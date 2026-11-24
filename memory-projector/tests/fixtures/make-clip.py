#!/usr/bin/env python3
"""A synthetic stand-in for a real clip, for the engine tests: a magenta figure (head, body, swinging arms) and a magenta
disc standing for a reflection, on a busy background, filmed with a shaky hand. 640 x 360, 24 fps, 9 s, H.264.

  python3 tests/fixtures/make-clip.py   -> tests/fixtures/magenta-clip.mp4
"""
import math, os, subprocess, sys
import numpy as np

W, H, FPS, SECONDS = 640, 360, 24, 9
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "magenta-clip.mp4")
rng = np.random.default_rng(3)
yy, xx = np.mgrid[0:H + 80, 0:W + 80].astype(np.float32)
# a busy background, bigger than the frame so the shaking camera never sees its edge
bg = np.stack([60 + 40 * np.sin(xx / 13) + 30 * rng.random(xx.shape), 120 + 50 * np.sin(yy / 9 + xx / 31),
               90 + 40 * np.cos(xx / 21) + 30 * rng.random(xx.shape)], -1).clip(0, 255).astype(np.uint8)
MAGENTA = np.array([255, 0, 255], np.uint8)


def shape(img, mask):
    img[mask] = MAGENTA


def frame(i):
    t = i / FPS
    # the hand: a slow wander plus a faster tremble, ±12 px
    dx = int(round(8 * math.sin(t * 1.7) + 4 * math.sin(t * 9.1)))
    dy = int(round(6 * math.sin(t * 1.3 + 1) + 4 * math.sin(t * 7.7)))
    img = bg[40 + dy:40 + dy + H, 40 + dx:40 + dx + W].copy()
    Y, X = yy[:H, :W] + dy, xx[:H, :W] + dx              # scene coordinates: everything moves with the camera
    cx, feet = 250, 330
    shape(img, (X - cx) ** 2 + (Y - (feet - 190)) ** 2 < 26 ** 2)                       # head
    shape(img, (np.abs(X - cx) < 30) & (Y > feet - 165) & (Y < feet - 70))               # body
    for side in (-1, 1):
        a = math.sin(t * 3 + (0 if side < 0 else math.pi)) * 0.6
        ax, ay = cx + side * 30, feet - 155
        bx, by = ax + side * 55 * math.cos(a), ay + 55 * math.sin(a) + 30
        tt = np.clip(((X - ax) * (bx - ax) + (Y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2), 0, 1)
        shape(img, (X - (ax + tt * (bx - ax))) ** 2 + (Y - (ay + tt * (by - ay))) ** 2 < 10 ** 2)   # arms
        shape(img, (np.abs(X - (cx + side * 15)) < 11) & (Y >= feet - 70) & (Y <= feet))           # legs
    shape(img, (X - 520) ** 2 + (Y - 150) ** 2 < 40 ** 2)                                # the "reflection"
    return img


p = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                      "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart", OUT],
                     stdin=subprocess.PIPE)
for i in range(FPS * SECONDS):
    p.stdin.write(frame(i).tobytes())
p.stdin.close()
sys.exit(p.wait())
