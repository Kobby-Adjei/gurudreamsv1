"""
Render the AirBridge hero loop on Modal (serverless GPUs) with the SAME pinned Blender
version and the SAME scene script used for the local previews.

    pip install modal && modal setup          # once
    modal run landing/blender/modal_render.py --start 1 --end 12 --chunks 1   # smoke test first
    modal run landing/blender/modal_render.py                       # L4, 12 chunks x 12 frames
    modal run landing/blender/modal_render.py --res 1080x1920 --prefix hero_tall_   # phone version

    GPU type is chosen when the app is defined, so it is an environment variable:
      macOS/Linux:        HERO_GPU=A10G modal run landing/blender/modal_render.py
      Windows PowerShell: $env:HERO_GPU="A10G"; modal run landing/blender/modal_render.py

Frames land in landing/blender/frames/hero_0001.png ... hero_0144.png (gitignored).
Paths are built with pathlib relative to this file, so it runs from any directory on
macOS, Linux or Windows.
Nothing here changes the look: render settings live in hero_scene.py (--quality prod).
"""

import os
import pathlib
import time

import modal

BLENDER_VERSION = "4.2.23"
BLENDER_SERIES = "4.2"
BLENDER_TARBALL = f"blender-{BLENDER_VERSION}-linux-x64.tar.xz"
BLENDER_URL = f"https://download.blender.org/release/Blender{BLENDER_SERIES}/{BLENDER_TARBALL}"
# published at https://download.blender.org/release/Blender4.2/blender-4.2.23.sha256
BLENDER_SHA256 = "bea0eb3146be13eae6225409a117b215184f41b7f79e799f97cb3abb8f6dc404"
BLENDER_BIN = f"/opt/blender-{BLENDER_VERSION}-linux-x64/blender"

GPU = os.environ.get("HERO_GPU", "L4")              # "L4" or "A10G"

# Approximate Modal list prices (USD per second) - check modal.com/pricing before relying on them.
PRICE_PER_S = {"L4": 0.000222, "A10G": 0.000306}
PRICE_CPU_CORE_S = 0.0000131      # per physical core-second
PRICE_GIB_S = 0.00000222          # per GiB-second of memory
CPU_CORES = 8.0                   # geometry-nodes cloud grid build is CPU work, so give it cores
MEM_GIB = 16

HERE = pathlib.Path(__file__).resolve().parent
SCENE = HERE / "hero_scene.py"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "curl", "xz-utils", "ca-certificates",
        # runtime libs the official Linux build expects even when headless
        "libx11-6", "libxi6", "libxxf86vm1", "libxfixes3", "libxrender1", "libxkbcommon0",
        "libsm6", "libice6", "libgl1", "libegl1", "libglu1-mesa", "libgomp1",
    )
    .run_commands(
        f"curl -fsSL -o /tmp/{BLENDER_TARBALL} {BLENDER_URL}",
        f"echo '{BLENDER_SHA256}  /tmp/{BLENDER_TARBALL}' | sha256sum -c -",
        f"tar -xf /tmp/{BLENDER_TARBALL} -C /opt && rm /tmp/{BLENDER_TARBALL}",
        f"{BLENDER_BIN} -b --factory-startup --version",
    )
    .add_local_file(str(SCENE), "/root/hero_scene.py")
)

app = modal.App("airbridge-hero-render", image=image)


@app.function(gpu=GPU, cpu=CPU_CORES, memory=MEM_GIB * 1024, timeout=3 * 60 * 60, max_containers=12)
def render_range(start: int, end: int, res: str = "1920x1080", device: str = "auto",
                 prefix: str = "hero_") -> dict:
    """Render frames [start, end] inclusive; return {filename: png bytes, '_seconds': float}.

    device: auto = OPTIX > CUDA > CPU (see hero_scene.py); pass "cuda" if OptiX misbehaves.
    """
    import subprocess

    out = pathlib.Path("/tmp/frames")
    out.mkdir(parents=True, exist_ok=True)
    cmd = [
        BLENDER_BIN, "-b", "--factory-startup", "-P", "/root/hero_scene.py", "--",
        "--quality", "prod", "--res", res, "--frames", f"{start}-{end}",
        "--out", str(out), "--prefix", prefix, "--device", device,
    ]
    t0 = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    dt = time.time() - t0
    for line in proc.stdout.splitlines():
        if line.startswith("[hero]"):
            print(line, flush=True)
    if proc.returncode != 0:
        print(proc.stdout[-4000:])
        print(proc.stderr[-4000:])
        raise RuntimeError(f"blender failed for frames {start}-{end}")
    result = {p.name: p.read_bytes() for p in sorted(out.glob(f"{prefix}*.png"))}
    result["_seconds"] = dt
    return result


@app.local_entrypoint()
def main(start: int = 1, end: int = 144, chunks: int = 12, res: str = "1920x1080",
         device: str = "auto", prefix: str = "hero_"):
    frames_dir = HERE / "frames"
    frames_dir.mkdir(exist_ok=True)
    n = end - start + 1
    size = -(-n // chunks)
    ranges = [(a, min(a + size - 1, end)) for a in range(start, end + 1, size)]
    print(f"rendering frames {start}-{end} at {res} on {GPU} in {len(ranges)} chunks: {ranges}")
    print(f"output: {frames_dir}")

    t0 = time.time()
    container_s = 0.0
    jobs = [(a, b, res, device, prefix) for (a, b) in ranges]
    for out in render_range.starmap(jobs):
        container_s += out.pop("_seconds")
        for name, data in out.items():
            (frames_dir / name).write_bytes(data)
        names = sorted(out)
        print(f"  wrote {len(names)} frames ({names[0]} .. {names[-1]})", flush=True)
    wall = time.time() - t0

    per_s = PRICE_PER_S.get(GPU, PRICE_PER_S["L4"]) + CPU_CORES * PRICE_CPU_CORE_S + MEM_GIB * PRICE_GIB_S
    print(f"done: {n} frames, wall {wall / 60:.1f} min, "
          f"render time {container_s / 60:.1f} container-min ({container_s / n:.1f} s/frame), "
          f"est. cost ${container_s * per_s:.2f} (+ container start-up)")
