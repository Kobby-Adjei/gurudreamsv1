/* AirBridge hero: a paper plane over moonlit clouds, rendered live in WebGL.
 *
 * Three passes per frame:
 *   1. clouds  — raymarched volume (fbm density, Beer–Lambert, two-lobe Henyey–Greenstein,
 *                multiple-scattering approximation) into a small offscreen buffer whose size
 *                follows the measured frame time;
 *   2. compose — full-resolution upscale of that buffer + analytic sky, moon glow and stars,
 *                tone mapping and dithering;
 *   3. plane   — six flat paper triangles rasterised at full resolution with MSAA, lit by the
 *                moon, shadowed by the clouds, and fogged by any cloud between it and the camera.
 * Falls back to a pre-rendered poster (the <picture> in .sky) without WebGL, with reduced motion,
 * or when the device cannot keep up. Stops after one calm flight to save battery.
 */
(function () {
  'use strict';

  var hero = document.querySelector('.hero');
  var canvas = document.getElementById('sky');
  if (!hero || !canvas) return;

  // Test/render hooks, set only by the tools/ scripts (never by the page itself).
  var hooks = window.__hero || {};
  var still = hooks.still || null; // { t, scale, live?: preview with live-quality settings }
  var hq = !!still && !still.live;

  function setState(s) { hero.setAttribute('data-hero', s); }

  var posterMode = false;
  function usePoster(reason) {
    posterMode = true;
    stopLoop();
    hero.setAttribute('data-hero-reason', reason);
    var img = hero.querySelector('.poster img');
    setState('poster');
    if (!img) return;
    var swap = function () { setState('poster-ready'); };
    if (img.complete && img.naturalWidth) swap();
    else if (img.decode) img.decode().then(swap, swap);
    else img.addEventListener('load', swap);
  }

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce && !still) { usePoster('reduced-motion'); return; }

  var gl = null;
  try {
    gl = canvas.getContext('webgl', {
      antialias: true, alpha: false, depth: true, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: !!still,
      powerPreference: 'default',
      failIfMajorPerformanceCaveat: !(still || hooks.allowSoftware)
    });
  } catch (e) { gl = null; }
  if (!gl) { usePoster('no-webgl'); return; }

  var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  var lite = !still && (coarse || Math.min(screen.width, screen.height) < 700);

  /* ------------------------------------------------------------------ shaders */

  var COMMON = [
    'precision highp float;',
    'uniform sampler2D uNoise, uWorley;',
    'uniform vec3 uCamPos, uCamR, uCamU, uCamF, uMoon, uPlanePos, uPlaneDir;',
    'uniform vec2 uTan;',
    'uniform float uTime;',
    'const vec3 MOON = vec3(0.66, 0.80, 1.0);',
    'const float YTOP = 2.7;',
    'const float YBOT = -0.6;',

    // iq's 3D value noise from a 2D texture whose green channel is red shifted by (37,17).
    'float noise(vec3 x) {',
    '  vec3 p = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);',
    '  vec2 uv = (p.xy + vec2(37.0, 17.0) * p.z) + f.xy;',
    '  vec2 rg = texture2D(uNoise, (uv + 0.5) / 256.0).yx;',
    '  return mix(rg.x, rg.y, f.z);',
    '}',
    // Tileable 3D Worley (inverted, two octaves) from a 32-slice atlas, 34x34 texels per slice incl. a 1-texel wrap border.
    'float worley(vec3 q) {',
    '  q = fract(q) * 32.0;',
    '  float z = q.z - 0.5; float z0 = floor(z); float fz = z - z0;',
    '  float s0 = mod(z0 + 32.0, 32.0); float s1 = mod(z0 + 1.0, 32.0);',
    '  vec2 xy = q.xy + 1.0; vec2 sz = vec2(272.0, 136.0);',
    '  float a = texture2D(uWorley, (vec2(mod(s0, 8.0), floor(s0 / 8.0)) * 34.0 + xy) / sz).r;',
    '  float b = texture2D(uWorley, (vec2(mod(s1, 8.0), floor(s1 / 8.0)) * 34.0 + xy) / sz).r;',
    '  return mix(a, b, fz);',
    '}',
    'const mat3 M3 = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);',

    // Large, slow swell of the cloud sea: where the tops rise and where they fall away.
    'float swell(vec3 p) {',
    '  float a = noise(vec3(p.xz * 0.05, 1.7)), b = noise(vec3(p.xz * 0.14, 7.3));',
    '  return a * 0.6 + (1.0 - abs(b * 2.0 - 1.0)) * 0.4;',
    '}',
    // Wisps part around the plane: a soft tube along its recent path.
    'float wake(vec3 p) {',
    '  vec3 a = uPlanePos; vec3 b = uPlanePos - uPlaneDir * 2.2;',
    '  vec3 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);',
    '  float r = mix(0.2, 0.5, h);',
    '  return mix(0.35 + 0.65 * h, 1.0, smoothstep(0.0, r, length(pa - ba * h)));',
    '}',
    // Signed field: > 0 inside cloud. Its gradient stays under ~5, so -field/5 is a safe step through clear air.
    'float field(vec3 p, float f) {',
    '  return (f - 0.55) * 3.6 + (swell(p) - 0.5) * 1.6 + 0.95 - p.y;',
    '}',
    'float dens(float fl, vec3 p) { return clamp(fl * 3.0, 0.0, 1.0) + clamp((0.1 - p.y) * 2.0, 0.0, 1.0); }',
    'float bil(vec3 q) { return 1.0 - abs(noise(q) * 2.0 - 1.0); }',
    'vec3 wind(vec3 p) { return p * vec3(0.5, 0.62, 0.5) + vec3(uTime * 0.02, 0.0, uTime * 0.01); }',
    // Worley puffs give the rounded cumulus tops; value-noise octaves break them up and fray the edges.
    'float fieldHi(vec3 p) {',
    '  vec3 q = wind(p);',
    '  float w = worley(q * 0.2) * 0.62 + worley(q * 0.52 + 0.37) * 0.38;',
    '  float f = 0.5 * noise(q); q = M3 * q * 2.03;',
    '  f += 0.25 * noise(q); q = M3 * q * 2.01;',
    '  f += 0.14 * noise(q); q = M3 * q * 2.02;',
    '  f += 0.07 * noise(q); q = M3 * q * 2.03;',
    '  f += 0.04 * noise(q);',
    '  return field(p, mix(f, w, 0.62));',
    '}',
    'float mapLo(vec3 p) {',
    '  vec3 q = wind(p);',
    '  float w = worley(q * 0.2) * 0.62 + worley(q * 0.52 + 0.37) * 0.38;',
    '  float f = 0.5 * noise(q); q = M3 * q * 2.03;',
    '  f += 0.25 * noise(q);',
    '  return dens(field(p, mix(f * 1.3, w, 0.62)), p);',
    '}',
    'float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }',

    'vec3 skyCol(vec3 rd) {',
    '  float y = max(rd.y, 0.0);',
    '  vec3 zen = vec3(0.0019, 0.0031, 0.0068);',
    '  vec3 hor = vec3(0.0090, 0.0170, 0.0380);',
    '  vec3 c = mix(hor, zen, pow(smoothstep(0.0, 0.55, y), 0.55));',
    '  float mu = max(dot(rd, uMoon), 0.0);',
    '  c += MOON * (0.006 * pow(mu, 3.0) + 0.020 * pow(mu, 24.0) + 0.06 * pow(mu, 180.0));',
    '  float az = max(dot(normalize(vec3(rd.x, 0.0, rd.z)), normalize(vec3(uMoon.x, 0.0, uMoon.z))), 0.0);',
    '  c += vec3(0.010, 0.018, 0.036) * (0.4 + 0.6 * az * az) * exp(-y * 14.0);',
    '  return c;',
    '}',
    'vec3 tonemap(vec3 c) {',
    '  c *= 1.35;',
    '  c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);',
    '  return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));',
    '}',
    'float ign(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }',
    'float tri(vec2 p) { return ign(p) + ign(p + vec2(17.3, 41.7)) - 1.0; }',
    // Light reaching a point: transmittance toward the moon, with a soft plane shadow.
    'float lightDepth(vec3 p) {',
    '  float acc = 0.0;',
    '  acc += mapLo(p + uMoon * 0.12) * 0.16;',
    '  acc += mapLo(p + uMoon * 0.36) * 0.30;',
    '  acc += mapLo(p + uMoon * 0.80) * 0.55;',
    '#ifndef LITE',
    '  acc += mapLo(p + uMoon * 1.55) * 0.90;',
    '  acc += mapLo(p + uMoon * 2.90) * 1.60;',
    '  acc += mapLo(p + uMoon * 5.00) * 2.40;',
    '#endif',
    '  return acc;',
    '}',
    'float planeShadow(vec3 p) {',
    '  vec3 v = uPlanePos - p; float along = dot(v, uMoon);',
    '  if (along < 0.0) return 1.0;',
    '  float perp = length(v - uMoon * along);',
    '  float r = 0.32 + along * 0.05;',
    '  return 1.0 - 0.55 * (1.0 - smoothstep(0.0, r, perp)) * exp(-along * 0.35);',
    '}',
    // In-scattered light at a cloud sample with density d (multiple-scattering octaves).
    'vec3 scatter(vec3 p, float d, float cosT) {',
    '  float ld = lightDepth(p) * 9.0;',
    '  float ps = planeShadow(p);',
    '  vec3 s = vec3(0.0); float a = 1.0, b = 1.0, c = 1.0;',
    '  for (int k = 0; k < 3; k++) {',
    '    float ph = mix(hg(cosT, 0.78 * c), hg(cosT, -0.2 * c), 0.3);',
    '    s += a * ph * exp(-ld * b);',
    '    a *= 0.38; b *= 0.5; c *= 0.5;',
    '  }',
    '  float powder = mix(1.0 - exp(-d * 8.0), 1.0, 0.35 + 0.65 * max(cosT, 0.0));',
    '  float top = smoothstep(YBOT, YTOP, p.y);',
    '  vec3 amb = mix(vec3(0.0010, 0.0016, 0.0040), vec3(0.008, 0.013, 0.028), top);',
    '  return MOON * 3.6 * s * ps * powder + amb * 0.8 * exp(-ld * 0.35);',
    '}',
    // March the clouds between t0 and t1 along rd; returns premultiplied radiance and transmittance.
    // left: transmittance still unaccounted for when the step budget ran out (far, grazing rays).
    'vec4 marchSeg(vec3 ro, vec3 rd, float t0, float t1, float jitter, float stepMul, out float dist, out float left) {',
    '  float T = 1.0; vec3 L = vec3(0.0); float tw = 0.0;',
    '  float cosT = dot(rd, uMoon);',
    '  float t = t0 + (0.03 + 0.008 * t0) * stepMul * jitter;',
    '  left = 0.0;',
    '  for (int i = 0; i < STEPS; i++) {',
    '    if (t > t1 || T < 0.015) break;',
    '    vec3 p = ro + rd * t;',
    '    float fine = (0.022 + 0.0055 * t + 0.0003 * t * t) * stepMul;',
    '    float fl = fieldHi(p);',
    '    float d = dens(fl, p) * wake(p);',
    '    float dt = fine;',
    '    if (d > 0.002) {',
    '      float a = 1.0 - exp(-d * 9.0 * dt);',
    '      L += T * a * scatter(p, d, cosT);',
    '      tw += T * a * t;',
    '      T *= 1.0 - a;',
    '    } else {',
    '      dt = max(fine * 2.2, -fl * 0.22) * (0.55 + 0.9 * jitter);',
    '    }',
    '    t += dt;',
    '    if (i == STEPS - 1 && t < t1) left = T;',
    '  }',
    '  dist = tw / max(1.0 - T, 1e-4);',
    '  return vec4(L, T);',
    '}',
    'vec3 rayDir(vec2 ndc) { return normalize(uCamF + uCamR * ndc.x * uTan.x + uCamU * ndc.y * uTan.y); }'
  ].join('\n');

  var VS_QUAD = 'attribute vec2 aP; void main() { gl_Position = vec4(aP, 0.0, 1.0); }';

  var FS_CLOUDS = [
    'uniform vec2 uRes;',
    'uniform float uStepMul, uJitter, uFrame;',
    'void main() {',
    '  vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;',
    '  vec3 rd = rayDir(ndc);',
    '  vec3 ro = uCamPos;',
    '  vec4 r = vec4(0.0, 0.0, 0.0, 1.0);',
    '  vec3 bg = skyCol(rd);',
    '  if (rd.y < -0.0015) {',
    '    float t0 = max((ro.y - YTOP) / -rd.y, 0.0);',
    '    float t1 = min((ro.y - YBOT) / -rd.y, 95.0);',
    '    float dist, left;',
    '    r = marchSeg(ro, rd, t0, t1, 0.5 + (fract(ign(gl_FragCoord.xy) + uFrame * 0.618034) - 0.5) * uJitter, uStepMul, dist, left);',
    '    vec3 haze = skyCol(normalize(vec3(rd.x, 0.0, rd.z))) * 1.15;',
    // Rays that ran out of budget end in far cloud, which at that distance is all haze.
    '    r.rgb += left * haze; dist = mix(dist, 95.0, left); r.a -= left;',
    // Aerial perspective: far clouds sink into the moonlit haze.
    '    float fog = 1.0 - exp(-max(dist - 9.0, 0.0) * 0.06);',
    '    r.rgb = mix(r.rgb, (1.0 - r.a) * haze, fog);',
    // Through gaps in the deck: the dark lower layer, fading to haze toward the horizon.
    '    bg = mix(vec3(0.0016, 0.0026, 0.0058), haze, exp(rd.y * 9.0));',
    '  }',
    '  vec3 c = r.rgb + r.a * bg;',
    '  gl_FragColor = vec4(sqrt(max(c, 0.0)) + tri(gl_FragCoord.xy) / 510.0, r.a);',
    '}'
  ].join('\n');

  var FS_COMPOSE = [
    'uniform sampler2D uClouds;',
    'uniform vec2 uOut;',
    'float h12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }',
    'vec3 stars(vec3 rd, float px) {',
    '  float el = asin(clamp(rd.y, -1.0, 1.0));',
    '  if (el < 0.02) return vec3(0.0);',
    '  vec2 sp = vec2(atan(rd.x, rd.z), el) * 140.0;',
    '  vec2 cell = floor(sp); vec2 f = fract(sp);',
    '  float h = h12(cell);',
    '  if (h < 0.93) return vec3(0.0);',
    '  vec2 c = vec2(h12(cell + 7.1), h12(cell + 3.7)) * 0.7 + 0.15;',
    '  float d = length((f - c) / 140.0) / px;',
    '  float b = pow(h12(cell + 1.9), 6.0) * 0.07 + 0.004;',
    '  float fade = smoothstep(0.02, 0.22, el) * (1.0 - smoothstep(0.80, 0.97, dot(rd, uMoon)));',
    '  return mix(vec3(0.75, 0.85, 1.0), vec3(1.0), h12(cell + 5.3)) * b * exp(-d * d * 1.6) * fade;',
    '}',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy / uOut;',
    '  vec3 rd = rayDir(uv * 2.0 - 1.0);',
    '  vec4 c = texture2D(uClouds, uv);',
    '  vec3 L = c.rgb * c.rgb;',
    '  float px = 2.0 * uTan.y / uOut.y;',
    '  vec3 col = L + c.a * stars(rd, px);',
    '  gl_FragColor = vec4(tonemap(col) + tri(gl_FragCoord.xy) / 255.0, 1.0);',
    '}'
  ].join('\n');

  var VS_PLANE = [
    'attribute vec3 aPos; attribute vec3 aNrm;',
    'uniform vec3 uPR, uPU, uPF;',
    'uniform float uPS;',
    'varying vec3 vW; varying vec3 vN; varying vec3 vL;',
    'void main() {',
    '  vec3 w = uPlanePos + (uPR * aPos.x + uPU * aPos.y + uPF * aPos.z) * uPS;',
    '  vN = uPR * aNrm.x + uPU * aNrm.y + uPF * aNrm.z; vW = w; vL = aPos;',
    '  vec3 d = w - uCamPos;',
    '  float z = dot(d, uCamF);',
    '  gl_Position = vec4(dot(d, uCamR) / uTan.x, dot(d, uCamU) / uTan.y, z * 1.002 - 0.2, z);',
    '}'
  ].join('\n');

  var FS_PLANE = [
    'varying vec3 vW; varying vec3 vN; varying vec3 vL;',
    'void main() {',
    '  vec3 v = normalize(uCamPos - vW);',
    '  vec3 n = normalize(vN); if (dot(n, v) < 0.0) n = -n;',
    '  float ndl = dot(n, uMoon);',
    '  float sh = exp(-lightDepth(vW) * 7.0);',
    // Soft occlusion where the wings meet the keel, and along the trailing edge folds.
    '  float ao = mix(0.62, 1.0, smoothstep(0.0, 0.09, abs(vL.x) + max(-vL.y, 0.0) * 0.6));',
    '  vec3 paper = vec3(0.93, 0.94, 0.955) * (0.985 + 0.03 * noise(vL * 90.0));',
    '  vec3 sky = vec3(0.020, 0.032, 0.060);',
    '  vec3 bounce = vec3(0.050, 0.064, 0.090);',
    '  vec3 lit = MOON * 1.7 * max(ndl, 0.0) * sh;',
    '  vec3 thru = MOON * 0.30 * max(-ndl, 0.0) * sh;',
    '  vec3 amb = (sky * (0.5 + 0.5 * n.y) + bounce * (0.5 - 0.5 * n.y)) * ao;',
    '  vec3 col = paper * (lit * mix(0.8, 1.0, ao) + thru + amb);',
    // Any cloud between the camera and the paper.
    '  float tp = length(vW - uCamPos);',
    '  vec3 rd = (vW - uCamPos) / tp;',
    '  float t0 = rd.y < 0.0 ? max((uCamPos.y - YTOP) / -rd.y, 0.0) : tp;',
    '  float dist, left;',
    '  vec4 fr = t0 < tp ? marchSeg(uCamPos, rd, t0, tp, 0.5, 0.5, dist, left) : vec4(0.0, 0.0, 0.0, 1.0);',
    '  col = col * fr.a + fr.rgb;',
    '  gl_FragColor = vec4(tonemap(col) + tri(gl_FragCoord.xy) / 255.0, 1.0);',
    '}'
  ].join('\n');

  /* ------------------------------------------------------------------ GL setup */

  var progs = {}, buf = {}, tex = {}, fbo = null, fboW = 0, fboH = 0;

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      throw new Error('shader: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }
  function program(vs, fs, defs) {
    var head = '#define STEPS ' + (hq ? 220 : lite ? 72 : 110) + '\n' + (lite ? '#define LITE\n' : '') + (defs || '');
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, head + COMMON + '\n' + vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, head + COMMON + '\n' + fs));
    gl.bindAttribLocation(p, 0, 'aP');
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.bindAttribLocation(p, 1, 'aNrm');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error('link: ' + gl.getProgramInfoLog(p));
    var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) { var info = gl.getActiveUniform(p, i); u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name); }
    return { p: p, u: u };
  }

  // Deterministic noise so the live scene matches the poster.
  function noiseTexture() {
    var N = 256, r = new Uint8Array(N * N), d = new Uint8Array(N * N * 4), s = 1234567;
    for (var i = 0; i < r.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; r[i] = s >>> 24; }
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      var k = (y * N + x) * 4;
      d[k] = r[y * N + x];
      d[k + 1] = r[((y - 17) & 255) * N + ((x - 37) & 255)];
      d[k + 2] = 0; d[k + 3] = 255;
    }
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return t;
  }

  // 32^3 tileable inverted Worley noise (4 and 8 cells per tile), packed 8x4 slices with wrap borders.
  function worleyTexture() {
    var N = 32, seed = 987654321;
    function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
    function octave(C) {
      var pts = new Float32Array(C * C * C * 3);
      for (var i = 0; i < pts.length; i++) pts[i] = rnd();
      var out = new Float32Array(N * N * N);
      for (var z = 0; z < N; z++) for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
        var px = (x + 0.5) / N * C, py = (y + 0.5) / N * C, pz = (z + 0.5) / N * C;
        var cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz), best = 9;
        for (var dz = -1; dz <= 1; dz++) for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          var ix = cx + dx, iy = cy + dy, iz = cz + dz;
          var k = ((((iz % C) + C) % C) * C * C + (((iy % C) + C) % C) * C + (((ix % C) + C) % C)) * 3;
          var ex = ix + pts[k] - px, ey = iy + pts[k + 1] - py, ez = iz + pts[k + 2] - pz;
          var d = ex * ex + ey * ey + ez * ez;
          if (d < best) best = d;
        }
        out[(z * N + y) * N + x] = 1 - Math.min(Math.sqrt(best), 1);
      }
      return out;
    }
    var a = octave(4), b = octave(8), v = new Float32Array(N * N * N), lo = 9, hi = -9;
    for (var i = 0; i < v.length; i++) { v[i] = a[i] * 0.7 + b[i] * 0.3; lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); }
    var W = 272, H = 136, d = new Uint8Array(W * H * 4);
    for (var s = 0; s < N; s++) {
      var ox = (s % 8) * 34, oy = Math.floor(s / 8) * 34;
      for (var y = 0; y < 34; y++) for (var x = 0; x < 34; x++) {
        var sx = (x - 1 + N) % N, sy = (y - 1 + N) % N;
        var val = Math.round((v[(s * N + sy) * N + sx] - lo) / (hi - lo) * 255);
        var k = ((oy + y) * W + ox + x) * 4;
        d[k] = d[k + 1] = d[k + 2] = val; d[k + 3] = 255;
      }
    }
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  // A classic paper dart, nose along +z, one unit long. Six flat faces; the shared edges are the folds.
  var V = {
    N: [0, 0, 0.62],
    Rl: [-0.022, 0, -0.38], Rr: [0.022, 0, -0.38],
    Ml: [-0.19, 0.028, -0.38], Mr: [0.19, 0.028, -0.38],
    Tl: [-0.36, 0.088, -0.36], Tr: [0.36, 0.088, -0.36],
    K: [0, -0.125, -0.38]
  };
  var FACES = [['N', 'Rl', 'Ml'], ['N', 'Ml', 'Tl'], ['N', 'Rr', 'Mr'], ['N', 'Mr', 'Tr'], ['N', 'K', 'Rl'], ['N', 'Rr', 'K']];

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { var l = Math.sqrt(dot(a, a)) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

  function planeMesh() {
    var data = [];
    FACES.forEach(function (f) {
      var a = V[f[0]], b = V[f[1]], c = V[f[2]];
      var n = norm(cross(sub(b, a), sub(c, a)));
      [a, b, c].forEach(function (p) { data.push(p[0], p[1], p[2], n[0], n[1], n[2]); });
    });
    var bf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    return bf;
  }

  function setup() {
    progs.clouds = program(VS_QUAD, FS_CLOUDS);
    progs.compose = program(VS_QUAD, FS_COMPOSE);
    progs.plane = program(VS_PLANE, FS_PLANE);
    buf.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    buf.plane = planeMesh();
    tex.noise = noiseTexture();
    tex.worley = worleyTexture();
    tex.clouds = gl.createTexture();
    fbo = gl.createFramebuffer();
    fboW = fboH = 0; half = null;
  }

  // Half-float cloud buffer where the device can render to and filter it: the temporal average needs
  // more than 8 bits to settle. Plain RGBA8 otherwise (still fine, a touch grainier).
  var half = null;
  function fboType() {
    if (half === null) {
      half = 0;
      var h = gl.getExtension('OES_texture_half_float');
      if (h && gl.getExtension('OES_texture_half_float_linear') && gl.getExtension('EXT_color_buffer_half_float')) half = h.HALF_FLOAT_OES;
    }
    return half || gl.UNSIGNED_BYTE;
  }

  function sizeFbo(w, h) {
    if (w === fboW && h === fboH) return;
    fboW = w; fboH = h; fresh = true;
    gl.bindTexture(gl.TEXTURE_2D, tex.clouds);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, fboType(), null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.clouds, 0);
    if (half && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      half = 0;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /* ------------------------------------------------------------------ scene */

  var MOON = norm([0.62, 0.42, 0.66]);
  var CRUISE_SPEED = 0.6; // world units per second: the camera's slow drift alongside the plane

  // Ease the flight in: one long arc that ends matched to the camera, then a calm, slow cruise.
  function bez(p0, p1, p2, p3, u) {
    var v = 1 - u;
    return add(add(mul(p0, v * v * v), mul(p1, 3 * v * v * u)), add(mul(p2, 3 * v * u * u), mul(p3, u * u * u)));
  }
  function easeOut(u) { return 1 - Math.pow(1 - u, 2.6); }

  var PASS = 7.5;
  // Camera drifts diagonally (right and away), so the cruising plane is seen from behind, three-quarters.
  var DRIFT = norm([0.82, 0, 0.57]);
  function camAt(t) { return [DRIFT[0] * CRUISE_SPEED * t, 3.0 + 0.04 * Math.sin(t * 0.17), DRIFT[2] * CRUISE_SPEED * t]; }
  function relPath(t, aspect) {
    var narrow = Math.min(1, aspect / 1.5);
    var end = [0.5 * narrow, -1.32, 7.0];
    var p0 = [-6.2 * Math.max(narrow, 0.6), 0.15, 3.0];
    var p1 = [-3.0 * narrow, -0.25, 6.2];
    var p2 = [-0.7 * narrow, -1.25, 7.9];
    var u = Math.min(Math.max(t / PASS, 0), 1);
    var p = bez(p0, p1, p2, end, easeOut(u));
    // Cruise: a long, slow sway that fades in as the arc ends.
    var w = Math.min(Math.max((t - PASS * 0.7) / 5, 0), 1);
    w = w * w * (3 - 2 * w);
    var c = t - PASS * 0.7;
    return add(p, mul([0.22 * Math.sin(c * 0.19), 0.06 * Math.sin(c * 0.31 + 1.0), 0.3 * Math.sin(c * 0.13)], w));
  }
  function planeAt(t, aspect) { return add(camAt(t), relPath(t, aspect)); }

  function scene(t, aspect) {
    var pitch = 0.05 + 0.005 * Math.sin(t * 0.11);
    var cam = camAt(t);
    var F = [0, Math.sin(pitch), Math.cos(pitch)];
    var U = [0, Math.cos(pitch), -Math.sin(pitch)];
    var R = [1, 0, 0];
    var tanY = 0.40 / Math.pow(Math.min(1, aspect), 0.42);
    var tanX = tanY * aspect;

    var h = 0.05;
    var p = planeAt(t, aspect), pa = planeAt(t - h, aspect), pb = planeAt(t + h, aspect);
    var vel = mul(sub(pb, pa), 1 / (2 * h));
    var acc = mul(add(sub(pb, p), sub(pa, p)), 1 / (h * h));
    acc[1] = 0;
    var fwd = norm(vel);
    var up0 = norm(sub([0, 1, 0], mul(fwd, fwd[1])));
    var right0 = cross(up0, fwd);
    var roll = Math.max(-0.6, Math.min(0.6, dot(acc, right0) * 0.5));
    var cr = Math.cos(roll), sr = Math.sin(roll);
    var up = add(mul(up0, cr), mul(right0, sr));
    // A gentle nose-up attitude while gliding.
    var f2 = norm(add(fwd, mul(up, 0.06)));
    var u2 = norm(sub(up, mul(fwd, 0.06)));
    return { cam: cam, F: F, U: U, R: R, tan: [tanX, tanY], plane: p, pF: f2, pU: u2, pR: cross(u2, f2), dir: fwd };
  }

  /* ------------------------------------------------------------------ drawing */

  var W = 0, H = 0, dpr = 1, scale = still ? still.scale : lite ? 0.38 : 0.5;
  var JITTER = hooks.jitter != null ? hooks.jitter : 1.0;
  var BLEND = 0.15; // share of each new frame in the accumulated cloud buffer
  var frameNo = 0, fresh = true, settling = false;
  var MIN_SCALE = 0.22, MAX_SCALE = lite ? 0.6 : 0.85;

  function resize() {
    var r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (w !== canvas.width || h !== canvas.height) { canvas.width = w; canvas.height = h; }
    W = r.width; H = r.height;
  }

  function common(pr, s) {
    var u = pr.u;
    gl.uniform3fv(u.uCamPos, s.cam); gl.uniform3fv(u.uCamR, s.R); gl.uniform3fv(u.uCamU, s.U); gl.uniform3fv(u.uCamF, s.F);
    gl.uniform3fv(u.uMoon, MOON); gl.uniform3fv(u.uPlanePos, s.plane); gl.uniform3fv(u.uPlaneDir, s.dir);
    gl.uniform2fv(u.uTan, s.tan); gl.uniform1f(u.uTime, s.t);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex.noise); gl.uniform1i(u.uNoise, 0);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, tex.worley); gl.uniform1i(u.uWorley, 2);
  }

  function quad() {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function cloudPass(s, x0, y0, w, h) {
    var cw = Math.max(16, Math.round(W * scale)), ch = Math.max(16, Math.round(H * scale));
    sizeFbo(cw, ch);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, cw, ch);
    gl.disable(gl.DEPTH_TEST);
    if (w) { gl.enable(gl.SCISSOR_TEST); gl.scissor(x0, y0, w, h); }
    var pr = progs.clouds; gl.useProgram(pr.p); common(pr, s);
    gl.uniform2f(pr.u.uRes, cw, ch);
    gl.uniform1f(pr.u.uStepMul, hq ? 0.45 : lite ? 1.25 : 1.0);
    gl.uniform1f(pr.u.uJitter, JITTER);
    gl.uniform1f(pr.u.uFrame, frameNo % 64);
    // Temporal accumulation: blend this frame's jittered samples into what is already there.
    if (!fresh) {
      gl.enable(gl.BLEND);
      // Stills keep an exact running mean; live frames an exponential one.
      gl.blendColor(0, 0, 0, still || settling ? 1 / (frameNo + 1) : BLEND);
      gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
    }
    quad();
    gl.disable(gl.BLEND);
    if (!w || (x0 + w >= fboW && y0 + h >= fboH)) { fresh = false; frameNo++; }
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function finalPass(s) {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    var pr = progs.compose; gl.useProgram(pr.p); common(pr, s);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex.clouds); gl.uniform1i(pr.u.uClouds, 1);
    gl.uniform2f(pr.u.uOut, canvas.width, canvas.height);
    quad();

    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS);
    pr = progs.plane; gl.useProgram(pr.p); common(pr, s);
    gl.uniform3fv(pr.u.uPR, s.pR); gl.uniform3fv(pr.u.uPU, s.pU); gl.uniform3fv(pr.u.uPF, s.pF);
    gl.uniform1f(pr.u.uPS, 1.0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.plane);
    gl.enableVertexAttribArray(0); gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.drawArrays(gl.TRIANGLES, 0, FACES.length * 3);
    gl.disableVertexAttribArray(1);
  }

  function sceneAt(t) { var s = scene(t, W / Math.max(H, 1)); s.t = t; return s; }
  function draw(t) { var s = sceneAt(t); cloudPass(s); finalPass(s); }

  /* ------------------------------------------------------------------ loop */

  var raf = 0, last = 0, clock = 0, speed = 1, wall = 0, frames = 0, ema = 16, lastChange = 0, slowFor = 0;
  var visible = true, onscreen = true, done = false, shown = false;
  var FLIGHT = 20, SETTLE = 3.5; // seconds of motion, then a slow ease to a still frame

  function stopLoop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
  function resume() { if (done && !hero.hasAttribute('data-hero-done')) redrawStill(); else startLoop(); }
  function startLoop() {
    if (raf || done || posterMode || !visible || !onscreen) return;
    last = 0;
    raf = requestAnimationFrame(tick);
  }

  function adapt(dt) {
    ema = ema * 0.9 + dt * 0.1;
    if (frames - lastChange < 20) return;
    if (ema > 24 && scale > MIN_SCALE) { scale = Math.max(MIN_SCALE, scale * 0.82); lastChange = frames; }
    else if (ema < 13 && scale < MAX_SCALE && frames - lastChange > 90) { scale = Math.min(MAX_SCALE, scale * 1.12); lastChange = frames; }
    // Still struggling at the smallest buffer: this device is better served by the poster.
    if (scale <= MIN_SCALE && ema > 48) slowFor += dt; else slowFor = 0;
    if (slowFor > 1500) usePoster('slow');
  }

  function tick(now) {
    raf = 0;
    if (!last) last = now;
    var dt = Math.min(now - last, 100);
    last = now;
    wall += dt / 1000;
    if (wall > FLIGHT) speed = Math.max(0, 1 - (wall - FLIGHT) / SETTLE);
    clock += dt / 1000 * (speed * speed * (3 - 2 * speed));
    frames++;
    if (frames > 3) adapt(dt);
    if (posterMode) return;
    draw(clock);
    if (!shown) { shown = true; setState('live'); }
    if (speed <= 0) { done = true; settle(); return; }
    raf = requestAnimationFrame(tick);
  }

  // Once still, average a couple of dozen jittered frames into one clean final image, then stop.
  function settle() {
    var n = 0;
    settling = true; fresh = true;
    (function more() {
      raf = 0;
      if (!visible || !onscreen || posterMode || gl.isContextLost()) { settling = false; return; }
      draw(clock);
      if (++n < 24) { raf = requestAnimationFrame(more); return; }
      settling = false;
      hero.setAttribute('data-hero-done', '');
    })();
  }

  function redrawStill() { if (!gl.isContextLost() && shown && !posterMode) { stopLoop(); resize(); settle(); } }

  /* ------------------------------------------------------------------ start */

  try {
    setup();
    resize();
  } catch (e) {
    usePoster('init');
    return;
  }

  // Context loss (GPU reset, too many contexts): show the poster; come back if the context does.
  canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); usePoster('context-lost'); }, false);
  canvas.addEventListener('webglcontextrestored', function () {
    try {
      setup(); resize();
      posterMode = false; hero.removeAttribute('data-hero-reason'); setState('live');
      if (done) settle(); else startLoop();
    } catch (e) { usePoster('restore'); }
  }, false);

  if (still) {
    // Offline render for the poster and share card: tile the cloud pass so no single draw runs long.
    resize();
    var s = sceneAt(still.t);
    var cw = Math.max(16, Math.round(W * scale)), ch = Math.max(16, Math.round(H * scale));
    var tiles = [], T = 256;
    for (var ty = 0; ty < ch; ty += T) for (var tx = 0; tx < cw; tx += T) tiles.push([tx, ty]);
    var i = 0, passes = hooks.passes || (hq ? 24 : 14);
    (function next() {
      if (i < tiles.length * passes) {
        var tl = tiles[i % tiles.length]; i++;
        cloudPass(s, tl[0], tl[1], T, T);
        gl.finish();
        setTimeout(next, 0);
        return;
      }
      finalPass(s);
      gl.finish();
      setState('live');
      hero.setAttribute('data-hero-done', '');
    })();
    return;
  }

  var ro = window.ResizeObserver ? new ResizeObserver(function () { resize(); if (done) redrawStill(); }) : null;
  if (ro) ro.observe(canvas); else window.addEventListener('resize', function () { resize(); if (done) redrawStill(); });

  document.addEventListener('visibilitychange', function () {
    visible = document.visibilityState !== 'hidden';
    if (visible) resume(); else stopLoop();
  });
  if (window.IntersectionObserver) {
    new IntersectionObserver(function (entries) {
      onscreen = entries[entries.length - 1].isIntersecting;
      if (onscreen) resume(); else stopLoop();
    }).observe(hero);
  }
  startLoop();
})();
