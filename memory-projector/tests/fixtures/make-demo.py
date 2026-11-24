#!/usr/bin/env python3
"""Synthetic depth-only memories for the demo page and the tests. No real footage: a little figure built from
spheres and capsules dances while a ball bounces beside it.

  python3 tests/fixtures/make-demo.py                    -> demo/demo-dance.mp4 + demo/memories.json
  python3 tests/fixtures/make-demo.py --empty OUT.mp4    -> a memory with no figure at all
  python3 tests/fixtures/make-demo.py --still OUT.mp4    -> the figure standing still (for stable pixel tests)

Format numbers are copied from lib/depth-format.js (SIZE, FPS, EMPTY 0, figure 64 + d * 191). Keep them in step.
"""
import json, math, os, subprocess, sys
import numpy as np

SIZE, FPS, SECONDS = 256, 12, 7
FIGURE_MIN, FIGURE_SPAN = 64, 191
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

yy, xx = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32)


def sphere(depth, cx, cy, r, cz=0.0):
    d2 = (xx - cx) ** 2 + (yy - cy) ** 2
    inside = d2 < r * r
    z = np.where(inside, cz + np.sqrt(np.maximum(r * r - d2, 0)), -1e9)
    np.maximum(depth, z, out=depth)


def capsule(depth, ax, ay, bx, by, r, cz=0.0):
    abx, aby = bx - ax, by - ay
    t = np.clip(((xx - ax) * abx + (yy - ay) * aby) / max(abx * abx + aby * aby, 1e-6), 0, 1)
    px, py = ax + t * abx, ay + t * aby
    d2 = (xx - px) ** 2 + (yy - py) ** 2
    z = np.where(d2 < r * r, cz + np.sqrt(np.maximum(r * r - d2, 0)), -1e9)
    np.maximum(depth, z, out=depth)


def frame(i, still=False, empty=False):
    depth = np.full((SIZE, SIZE), -1e9, np.float32)
    if empty:
        return np.zeros((SIZE, SIZE), np.uint8)
    t = 0 if still else i / FPS
    sway = math.sin(t * 2 * math.pi * 0.9) * 10
    bob = abs(math.sin(t * 2 * math.pi * 0.9)) * 6
    hip = (110 + sway * 0.5, 150 + bob)
    neck = (110 + sway, 88 + bob)
    capsule(depth, *hip, *neck, 18, 6)                                       # torso
    sphere(depth, neck[0] + sway * 0.2, neck[1] - 24, 17, 4)                # head
    for side in (-1, 1):                                                     # arms wave, legs bend
        ph = t * 2 * math.pi * 1.8 + (0 if side < 0 else math.pi)
        sh = (neck[0] + side * 16, neck[1] + 8)
        el = (sh[0] + side * 22, sh[1] + 18 + math.sin(ph) * 14)
        ha = (el[0] + side * 10, el[1] - 22 + math.cos(ph) * 16)
        capsule(depth, *sh, *el, 7, 10)
        capsule(depth, *el, *ha, 6, 14)
        kn = (hip[0] + side * 12 + math.sin(ph) * 4, 196)
        capsule(depth, hip[0] + side * 9, hip[1] + 6, *kn, 9, 4)
        capsule(depth, *kn, hip[0] + side * 14, 238, 8, 4)
    by = 236 - 13 - abs(math.sin(t * 2 * math.pi * 0.7)) * 70                # the ball
    sphere(depth, 196, by, 13, 0)
    fig = depth > -1e8
    d = np.zeros_like(depth)
    lo, hi = depth[fig].min(), depth[fig].max()
    d[fig] = (depth[fig] - lo) / max(hi - lo, 1e-6)
    out = np.zeros((SIZE, SIZE), np.uint8)
    out[fig] = (FIGURE_MIN + np.round(d[fig] * FIGURE_SPAN)).astype(np.uint8)
    return out


def write(path, frames):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    p = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "gray",
                          "-s", f"{SIZE}x{SIZE}", "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-profile:v", "baseline",
                          "-pix_fmt", "yuv420p", "-b:v", "400k", "-movflags", "+faststart", path], stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(f.tobytes())
    p.stdin.close()
    if p.wait():
        sys.exit("ffmpeg failed")


def main():
    n = FPS * SECONDS
    if len(sys.argv) == 3 and sys.argv[1] in ("--empty", "--still"):
        write(sys.argv[2], [frame(i, still=sys.argv[1] == "--still", empty=sys.argv[1] == "--empty") for i in range(n)])
        return
    demo = os.path.join(ROOT, "demo")
    write(os.path.join(demo, "demo-dance.mp4"), [frame(i) for i in range(n)])
    story = ("This is a demo memory. The figure is synthetic: a few spheres and capsules dancing next to a bouncing ball, "
             "rendered straight into a depth video so the projector has something to show before real memories arrive. "
             "Real memories come from the engine page, which turns a short clip into depth alone, so the faces in it "
             "never leave the machine they were filmed on.")
    with open(os.path.join(demo, "memories.json"), "w") as f:
        json.dump([{"id": "demo-dance", "src": "demo-dance.mp4", "story": story, "title": "A demo dance",
                    "fps": FPS, "seconds": SECONDS, "aspect": 1}], f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
