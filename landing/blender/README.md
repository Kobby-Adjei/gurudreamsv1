# Hero video (Blender)

A white folded paper dart gliding over a moonlit cloud deck at night, rendered in Blender
Cycles as a 6 s seamless loop (24 fps, frames 1–144; frame 145 is frame 1).

Everything is procedural and lives in `hero_scene.py`. No external assets and no `.blend` in git.

## Blender version (pinned)

- **Blender 4.2.23 LTS**, Linux x64:
  `https://download.blender.org/release/Blender4.2/blender-4.2.23-linux-x64.tar.xz`
- sha256 (from `blender-4.2.23.sha256` on download.blender.org):
  `bea0eb3146be13eae6225409a117b215184f41b7f79e799f97cb3abb8f6dc404`

```sh
curl -fsSLO https://download.blender.org/release/Blender4.2/blender-4.2.23-linux-x64.tar.xz
echo "bea0eb3146be13eae6225409a117b215184f41b7f79e799f97cb3abb8f6dc404  blender-4.2.23-linux-x64.tar.xz" | sha256sum -c -
tar -xf blender-4.2.23-linux-x64.tar.xz
BLENDER=$PWD/blender-4.2.23-linux-x64/blender
```

## How the scene works

| Part | Approach |
| --- | --- |
| Clouds | Geometry Nodes `Volume Cube` evaluates a procedural field into two grids (fine near grid, coarse far grid). The grid stores a clamped, shifted signed distance; the Principled Volume shader adds pixel-scale erosion noise and turns it into density (soft cloud boundary, forward scattering g=0.62). Coverage noise makes deep gaps, flat stratus areas and raised masses; smooth-F1 Voronoi gives rounded cumulus caps. A fake planet curvature lets the deck fall away so the horizon sits just below frame centre. |
| Loop | The cloud field drifts along the flight heading by `DRIFT_PER_LOOP` per loop. Two copies of the field offset by exactly that distance are cross-blended with weights (1-t, t), variance-normalised so contrast does not dip mid-loop. At t=0 and t=1 the field is identical, so the loop is exact with no encode-time crossfade. Camera and plane motion are sums of sines with whole cycles per loop. |
| Haze | Aerial perspective is folded into the cloud shader: with camera distance, scattering albedo is traded for emission at the horizon colour. This adds no noise and no extra volume. |
| Sky | World gradient from deep navy at the zenith to blue-grey at the horizon, plus very faint, sparse Voronoi stars above about 7° elevation. |
| Moon | Sun lamp: cool white, 22° elevation, left of frame, 0.55° angular size. |
| Plane | A classic dart built from folded facets: keel, inner and outer wing panels with two creases, and slight dihedral. It has a gentle bow, a 1.6 mm (scaled) solidify, and an off-white matte paper material with a little subsurface, 22% translucency and a fibre bump. |
| Look | AgX with the Medium High Contrast look. The compositor adds a soft vignette; render dither 1.0 against 8-bit banding. |

## Render commands

Local preview stills (CPU):

```sh
cd landing/blender
$BLENDER -b --factory-startup -P hero_scene.py -- --quality preview --res 960x540 \
  --frames 1,72,140 --out previews --prefix preview_960_
$BLENDER -b --factory-startup -P hero_scene.py -- --quality prod --res 1920x1080 \
  --frames 72 --out previews --prefix prod_1080_
```

Full sequence (any machine; GPU used automatically when present):

```sh
$BLENDER -b --factory-startup -P hero_scene.py -- --quality prod --res 1920x1080 --frames 1-144 --out frames
```

On Modal (serverless GPU; same Blender build, same script):

```sh
pip install modal && modal setup
modal run landing/blender/modal_render.py                  # L4, 12 chunks x 12 frames
HERO_GPU=A10G modal run landing/blender/modal_render.py    # A10G
modal run landing/blender/modal_render.py --start 1 --end 12 --chunks 1   # smoke test first
```

Frames are written to `landing/blender/frames/` (gitignored).

## Measured timings (4 vCPU, no GPU, Blender 4.2.23)

| What | Settings | Time |
| --- | --- | --- |
| Preview still 960×540 | preview: 32 spp adaptive, 4 volume bounces, step rate 1.5, 0.45/1.4 voxels, OIDN | ~5–6 min/frame (about 40 s of that is building the grids) |
| Production still 1920×1080 | prod: 160 spp adaptive 0.015, 4 volume bounces, step rate 1.0, 0.30/0.9 voxels, OIDN | see the phase-1 report |

## Encode (after frames exist)

```sh
cd landing/blender
# H.264 MP4: keyframe at the loop start, faststart, no audio
ffmpeg -y -framerate 24 -i frames/hero_%04d.png -an -c:v libx264 -preset veryslow -tune film \
  -crf 23 -pix_fmt yuv420p -x264-params keyint=144:min-keyint=144:scenecut=0 \
  -movflags +faststart ../assets/hero.mp4
# VP9 WebM (2-pass constrained quality)
ffmpeg -y -framerate 24 -i frames/hero_%04d.png -an -c:v libvpx-vp9 -b:v 0 -crf 36 -row-mt 1 \
  -pix_fmt yuv420p -g 144 -pass 1 -f null /dev/null
ffmpeg -y -framerate 24 -i frames/hero_%04d.png -an -c:v libvpx-vp9 -b:v 0 -crf 36 -row-mt 1 \
  -pix_fmt yuv420p -g 144 -pass 2 ../assets/hero.webm
# Optional AV1 (smaller still)
ffmpeg -y -framerate 24 -i frames/hero_%04d.png -an -c:v libsvtav1 -crf 38 -preset 4 -g 144 \
  -pix_fmt yuv420p10le ../assets/hero.av1.mp4
# Poster = frame 1 (the first decoded frame, so there's no jump when playback starts)
ffmpeg -y -i frames/hero_0001.png -q:v 3 ../assets/hero-video-poster.jpg
```

Tune the CRF so the MP4 lands at 2–4 MB. The 2 MB target and the 6 s length mean roughly
2.5–5 Mbit/s, which is plenty for slow, soft content.
