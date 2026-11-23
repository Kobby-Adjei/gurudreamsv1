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
| Clouds | Geometry Nodes `Volume Cube` evaluates a procedural field into two grids (fine near grid, coarse far grid). The grid stores a clamped, shifted signed distance; the Principled Volume shader adds pixel-scale erosion noise and turns it into density (soft cloud boundary, forward scattering g=0.62). Coverage noise makes deep gaps, flat stratus areas and raised masses; domain-warped smooth-F1 Voronoi gives rounded cumulus caps. A fake planet curvature lets the deck fall away so the horizon sits just below frame centre. |
| Loop | The cloud field drifts along the flight heading by `DRIFT_PER_LOOP` per loop. Two copies of the field offset by exactly that distance are cross-blended with weights (1-t, t), variance-normalised so contrast does not dip mid-loop. At t=0 and t=1 the field is identical, so the loop is exact with no encode-time crossfade. Camera and plane motion are sums of sines with whole cycles per loop. |
| Haze | Aerial perspective is folded into the cloud shader: with camera distance (scale `FOG_DIST`), scattering albedo is traded for emission at the horizon colour. The sky has a broad glow band at that same colour, so the deck dissolves into the horizon without a line. This adds no noise and no extra volume. |
| Sky | World gradient from deep navy at the zenith to blue-grey at the horizon, plus very faint, sparse Voronoi stars above about 7° elevation. |
| Moon | Sun lamp: cool white, low (16°), from the left and slightly ahead (66° off the view axis) so cloud edges catch forward-scattered silver rims. Angular size 0.55°. |
| Plane | A classic dart built from folded facets: keel, inner and outer wing panels with two creases, and slight dihedral. It has a gentle bow, a 1.6 mm (scaled) solidify, and an off-white paper material with a soft sheen (roughness 0.48), a little subsurface, 30% translucency and a fibre bump. |
| Look | AgX with the Medium High Contrast look, exposure -0.15. The compositor adds a soft vignette; render dither 1.0 against 8-bit banding. |
| Portrait | When the height is greater than the width (e.g. `--res 1080x1920`), the camera switches to a vertical sensor fit with a 46° vertical view. The script then solves the lens shift so the plane sits horizontally centred, 30% up from the bottom, under the phone copy. Same lens, same scene, same loop. |

## Render commands (local Blender)

Preview stills (CPU, what `previews/` holds):

```sh
cd landing/blender
$BLENDER -b --factory-startup -P hero_scene.py -- --quality preview --res 960x540 \
  --frames 1,72,140 --out previews --prefix preview_960_
$BLENDER -b --factory-startup -P hero_scene.py -- --quality preview --res 540x960 \
  --frames 1,72 --out previews --prefix preview_portrait_540x960_
```

Full sequence on a machine with an NVIDIA GPU (OptiX/CUDA is picked automatically):

```sh
$BLENDER -b --factory-startup -P hero_scene.py -- --quality prod --res 1920x1080 --frames 1-144 --out frames
$BLENDER -b --factory-startup -P hero_scene.py -- --quality prod --res 1080x1920 --frames 1-144 --out frames --prefix hero_tall_
```

## Measured timings (4 vCPU, no GPU, Blender 4.2.23)

| What | Settings | Time |
| --- | --- | --- |
| Preview still 960×540 | preview: 32 spp adaptive, 4 volume bounces, step rate 1.5, 0.45/1.4 voxels, OIDN | about 4–6 min/frame (about 40 s of that is building the grids) |
| Production still 1920×1080 | prod: 160 spp adaptive 0.015, 4 volume bounces, step rate 1.0, 0.30/0.9 voxels, OIDN | grids take 1:53 to build, then about 40 s per sample. Blender's ETA was about 1 h 50 min/frame, so the full sequence needs a GPU. |

---

## Run it from your computer (Modal GPUs)

The full render runs on [Modal](https://modal.com) serverless GPUs. Your computer only
sends the job and receives the PNG frames. Blender is installed inside Modal's container,
pinned to 4.2.23 and checked against its sha256. You don't need Blender locally.

**What it costs (estimate):** about 4–7 GPU-minutes per 1080p frame on an L4. For 144
frames that's about 10–16 GPU-hours, roughly **$10–16**, finishing in about 1–1.5 hours
because 12 containers run in parallel. The phone version (1080×1920) is about the same
again. An A10G is about 20–30% faster per frame at about 1.4× the price. The script
prints the real time and cost estimate when it finishes.

All commands are run from the **repository root** (the folder that contains `landing/`).

### macOS

1. Install the tools (Homebrew: https://brew.sh):
   ```sh
   brew install python@3.12 ffmpeg
   ```
2. Create a virtual environment and install Modal:
   ```sh
   cd path/to/gurudreamsv1
   python3 -m venv .venv
   source .venv/bin/activate
   pip install modal
   ```
3. Log in to Modal. Create a token at https://modal.com/settings/tokens, then:
   ```sh
   modal token set --token-id ak-XXXX --token-secret as-XXXX
   ```
   (`modal setup` does the same through your browser.)
4. Run the smoke test (12 frames, one container), then look at
   `landing/blender/frames/hero_0001.png`:
   ```sh
   modal run landing/blender/modal_render.py --start 1 --end 12 --chunks 1
   ```
5. Run the full loop, then the phone version:
   ```sh
   modal run landing/blender/modal_render.py
   modal run landing/blender/modal_render.py --res 1080x1920 --prefix hero_tall_
   ```
   To use an A10G instead of an L4: `HERO_GPU=A10G modal run landing/blender/modal_render.py`.
   If the GPU render fails at startup, retry with CUDA instead of OptiX: add `--device cuda`.
6. Encode: see [Encode](#encode-macos-and-windows) below.

### Windows (PowerShell)

1. Install the tools:
   ```powershell
   winget install Python.Python.3.12
   winget install Gyan.FFmpeg
   ```
   Close and reopen PowerShell so `py` and `ffmpeg` are on the PATH.
2. Create a virtual environment and install Modal:
   ```powershell
   cd C:\path\to\gurudreamsv1
   py -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install modal
   ```
   If activation is blocked, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once and retry.
3. Log in to Modal (create a token at https://modal.com/settings/tokens):
   ```powershell
   modal token set --token-id ak-XXXX --token-secret as-XXXX
   ```
4. Run the smoke test, then check `landing\blender\frames\hero_0001.png`:
   ```powershell
   modal run landing/blender/modal_render.py --start 1 --end 12 --chunks 1
   ```
5. Run the full loop, then the phone version:
   ```powershell
   modal run landing/blender/modal_render.py
   modal run landing/blender/modal_render.py --res 1080x1920 --prefix hero_tall_
   ```
   To use an A10G instead: `$env:HERO_GPU="A10G"; modal run landing/blender/modal_render.py`.
   If the GPU render fails at startup, add `--device cuda`.
6. Encode: see below. Every command is one line, so it works the same in PowerShell.

### Encode (macOS and Windows)

Run these from `landing/blender` (`cd landing/blender`). They read `frames/` and write
into `landing/assets/`.

```sh
ffmpeg -y -framerate 24 -i frames/hero_%04d.png -an -c:v libx264 -preset veryslow -tune film -crf 23 -pix_fmt yuv420p -x264-params keyint=144:min-keyint=144:scenecut=0 -movflags +faststart ../assets/hero.mp4
ffmpeg -y -framerate 24 -i frames/hero_%04d.png -an -c:v libvpx-vp9 -b:v 0 -crf 36 -row-mt 1 -pix_fmt yuv420p -g 144 -pass 1 -f null -
ffmpeg -y -framerate 24 -i frames/hero_%04d.png -an -c:v libvpx-vp9 -b:v 0 -crf 36 -row-mt 1 -pix_fmt yuv420p -g 144 -pass 2 ../assets/hero.webm
ffmpeg -y -i frames/hero_0001.png -q:v 3 ../assets/hero-video-poster.jpg

ffmpeg -y -framerate 24 -i frames/hero_tall_%04d.png -an -c:v libx264 -preset veryslow -tune film -crf 23 -pix_fmt yuv420p -x264-params keyint=144:min-keyint=144:scenecut=0 -movflags +faststart ../assets/hero-tall.mp4
ffmpeg -y -framerate 24 -i frames/hero_tall_%04d.png -an -c:v libvpx-vp9 -b:v 0 -crf 36 -row-mt 1 -pix_fmt yuv420p -g 144 -pass 1 -f null -
ffmpeg -y -framerate 24 -i frames/hero_tall_%04d.png -an -c:v libvpx-vp9 -b:v 0 -crf 36 -row-mt 1 -pix_fmt yuv420p -g 144 -pass 2 ../assets/hero-tall.webm
ffmpeg -y -i frames/hero_tall_0001.png -q:v 3 ../assets/hero-tall-video-poster.jpg
```

Check the sizes. Each MP4 should be 2–4 MB. If one is larger, raise `-crf` by 2 (e.g. 25)
and re-run that line. If it shows banding in the dark sky, lower it by 2. The WebM is
usually 20–30% smaller than the MP4.

### Where the outputs go

| File | Used for |
| --- | --- |
| `landing/assets/hero.mp4`, `landing/assets/hero.webm` | desktop / landscape video |
| `landing/assets/hero-tall.mp4`, `landing/assets/hero-tall.webm` | phones (aspect ratio 4:5 or taller) |
| `landing/assets/hero-video-poster.jpg`, `landing/assets/hero-tall-video-poster.jpg` | poster shown before playback and for reduced motion |
| `landing/blender/frames/` | raw PNG frames. Gitignored; keep them until the video is approved, then delete. |

Commit the six files in `landing/assets/` (or send them over). Wiring them into
`index.html` is a separate step: a `<video autoplay muted loop playsinline
preload="metadata" poster=...>`, with the tall sources under
`media="(max-aspect-ratio: 4/5)"` and the poster only under `prefers-reduced-motion`.
