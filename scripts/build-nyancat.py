# Turn the real Nyan Cat (nyan.cat's original.gif) + the real rainbow into one sprite sheet.
#
# ★★ **A tool run only once** (the output `web/public/nyancat.png` is committed).
#    Not called from any npm script. ⚠️ Needs Pillow (`pip install Pillow`), so it is
#    **neither a runtime nor a build dependency** (does not touch §2 "no new dependencies").
#
# Usage:
#   curl -o /tmp/nyan-src.gif https://nyan.cat/cats/original.gif
#   SRC=/tmp/nyan-src.gif OUT=web/public/nyancat.png python3 scripts/build-nyancat.py
#
# ⚠️⚠️ **Why the real one is used / what happens if published** is written at the top of
#    `web/src/ui/Nyan.tsx` (2026-08-28 user decision; a private repository for personal use).
# ★ The rainbow colors are exactly `.wave-1..6` in nyan.cat's `style/base2.css`.
# ★ 12 frames (same as the GIF). The rainbow's stagger swaps every frame,
#   and the horizontal scroll advances "exactly one period per loop", so it loops seamlessly.
#
# Why not show the GIF as-is in an <img>:
#   a GIF animation cannot be stopped by CSS = no "stopped cat" and no `prefers-reduced-motion`.
#   With a sprite it is one `steps(12)` animation, and stopping it just removes a class.
from pathlib import Path
from PIL import Image, ImageSequence

import os

SRC = Path(os.environ.get('SRC', '/tmp/nyan-src.gif'))
OUT = Path(os.environ.get('OUT', 'web/public/nyancat.png'))

# ── Source (the cat)
src = Image.open(SRC)
cats = [f.convert('RGBA') for f in ImageSequence.Iterator(src)]
CW, CH = cats[0].size          # 272 × 168
N = len(cats)                  # 12

# ── Rainbow (the 6 colors straight from nyan.cat's CSS)
WAVES = ['#ff0000', '#ff9900', '#ffff00', '#33ff00', '#0099ff', '#6633ff']
# ⚠️⚠️ **The source art's dot grid is 8px** (272/8 = 34 dots, 168/8 = 21 dots).
#    Unless the rainbow's dimensions are multiples of 8, **it is off by half a dot and blurs** at 1x.
GRID = 8
BAR = 2 * GRID                 # height of one stripe (CSS 1.25em @14px = 17.5px → rounded to 16)
STEP = 6 * GRID                # step width (CSS 3.5em @14px = 49px → 48)
BAND = BAR * len(WAVES)        # 96 = 16px × 6 stripes (CSS 1.25em×6 = 105px snapped to the grid)
TRAIL = STEP * 4               # rainbow length (4 steps)

def rgb(h):
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16), 255)

# Vertical position of the rainbow: align with the Pop-Tart body (centered in the non-empty area)
body_top = (CH - BAND) // 2 // GRID * GRID    # snap to the grid (32)
W = TRAIL + CW
H = CH

frames = []
for i, cat in enumerate(cats):
    canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))

    # ★ Stagger (swaps every 2 frames) + horizontal scroll (advances one step per loop)
    up = i % 2 == 0
    shift = round(STEP * i / N)

    for col in range(-1, TRAIL // STEP + 2):
        x0 = col * STEP - shift
        # Stagger: lower every other one by half a step (the real staircase edge)
        stagger = 0 if ((col % 2 == 0) == up) else GRID
        for k, c in enumerate(WAVES):
            y0 = body_top + k * BAR + stagger
            box = (x0, y0, x0 + STEP, y0 + BAR)
            if box[2] <= 0 or box[0] >= TRAIL + STEP // 2:
                continue
            Image.new('RGBA', (STEP, BAR), rgb(c)).save  # noqa: B018 (for readability)
            canvas.paste(Image.new('RGBA', (STEP, BAR), rgb(c)), (box[0], box[1]))

    # ⚠️ Extend the rainbow **under the Pop-Tart** (stopping short leaves a visible gap).
    #    The cat is composited on top, so the hidden part is not visible.
    cut = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    cut.paste(canvas.crop((0, 0, TRAIL + 56, H)), (0, 0))
    # Trim steps sticking out above/below (stay within the band)
    band = cut.crop((0, body_top, W, body_top + BAND + GRID))
    cut = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    cut.paste(band, (0, body_top))

    cut.alpha_composite(cat, (TRAIL, 0))     # composite the cat on the right edge
    frames.append(cut)

# ★★ Scale down to 1x (the original dot resolution). ⚠️ NEAREST (smoothing blurs it)
assert W % GRID == 0 and H % GRID == 0, (W, H)
dw, dh = W // GRID, H // GRID
small = [f.resize((dw, dh), Image.NEAREST) for f in frames]

sheet = Image.new('RGBA', (dw * N, dh), (0, 0, 0, 0))
for i, f in enumerate(small):
    sheet.paste(f, (i * dw, 0))

out = OUT
sheet.save(out, optimize=True)
print(f'元の1コマ = {W}×{H} → 1倍 = {dw}×{dh}（比 {dw/dh:.4f}:1）/ コマ数 = {N}')
print(f'スプライト = {sheet.size} / {out.stat().st_size:,} bytes')
print(f'CSS: --nyan-w = {dh} * {dw}/{dh} / background-size = width*{N} / 1周 = {70 * N}ms')

# For eyeballing (3x, frames 0 and 1)
