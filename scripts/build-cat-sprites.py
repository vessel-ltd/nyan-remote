"""Package the six approved imagegen cats for the UI (Pillow + numpy, build-time only).

User approved programmatic background removal/registration on 2026-09-08.
Sources are preserved in docs/cat-concepts/sprites. Outputs are RGBA PNGs at 2x.
Run: python3 scripts/build-cat-sprites.py
"""
from collections import deque
from pathlib import Path
import json
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
IDS = ['mochi-cat', 'fluffy-cat', 'tuxedo-cat', 'calico-cat', 'pixel-tabby-cat', 'pixel-grey-cat']
OUT = ROOT / 'web/public/cats'
OUT.mkdir(parents=True, exist_ok=True)
W, H = 144, 96
# Six drawn poses, with holds and a small vertical follow-through between poses.
POSES = [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 0]
LIFT = [0, 4, 7, 10, 7, 3, 0, 0, 1, 2, 1, 0]

def cutout(im):
    rgb = np.array(im.convert('RGB')).astype(np.int16)
    # Background squares are nearly neutral. Warm cream/white fur is retained.
    neutral = (rgb.min(axis=2) >= 195) & (np.ptp(rgb, axis=2) <= 6)
    height, width = neutral.shape
    seen = np.zeros((height, width), dtype=bool)
    background = np.zeros_like(seen)
    for y, x in zip(*np.where(neutral)):
        if seen[y, x]:
            continue
        q = deque([(y, x)])
        seen[y, x] = True
        component = []
        touches_edge = False
        while q:
            cy, cx = q.popleft()
            component.append((cy, cx))
            touches_edge |= cy == 0 or cx == 0 or cy == height-1 or cx == width-1
            for dy, dx in [(0, 1), (0, -1), (1, 0), (-1, 0)]:
                ny, nx = cy+dy, cx+dx
                if 0 <= ny < height and 0 <= nx < width and neutral[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    q.append((ny, nx))
        yy, xx = zip(*component)
        values = rgb[yy, xx, 0]
        # Also clear checkerboard trapped inside a curled tail / between legs.
        checker_hole = len(component) > 200 and values.min() < 235 and values.max() > 247 and values.std() > 3
        if touches_edge or checker_hole:
            background[yy, xx] = True
    alpha = np.where(background, 0, 255).astype('uint8')
    result = im.convert('RGBA')
    result.putalpha(Image.fromarray(alpha))
    return result

def separate_cats(im):
    # Generated characters sometimes cross the nominal grid. Split by connected
    # silhouettes instead of cutting toes/tails at an arbitrary 512px boundary.
    clean = cutout(im)
    alpha = np.array(clean.getchannel('A')) > 0
    height, width = alpha.shape
    labels = np.zeros(alpha.shape, dtype=np.int32)
    components = []
    for y, x in zip(*np.where(alpha)):
        if labels[y, x]:
            continue
        label = len(components) + 1
        q = deque([(y, x)])
        labels[y, x] = label
        points = []
        while q:
            cy, cx = q.popleft()
            points.append((cy, cx))
            for dy, dx in [(0,1),(0,-1),(1,0),(-1,0)]:
                ny, nx = cy+dy, cx+dx
                if 0 <= ny < height and 0 <= nx < width and alpha[ny,nx] and not labels[ny,nx]:
                    labels[ny,nx] = label
                    q.append((ny,nx))
        yy, xx = zip(*points)
        components.append((len(points), label, (min(xx), min(yy), max(xx)+1, max(yy)+1)))
    bodies = sorted(components, reverse=True)[:6]
    assert len(bodies) == 6 and min(c[0] for c in bodies) > 10000
    bodies.sort(key=lambda c: ((c[2][1]+c[2][3])//1024, c[2][0]))
    assigned = {c[1]: [c[1]] for c in bodies}
    for size, label, box in components:
        if label in assigned or size < 4:
            continue
        x, y = (box[0]+box[2])/2, (box[1]+box[3])/2
        def distance(body):
            b = body[2]
            return max(b[0]-x, 0, x-b[2])**2 + max(b[1]-y, 0, y-b[3])**2
        nearest = min(bodies, key=distance)
        if distance(nearest) < 25**2:
            assigned[nearest[1]].append(label)
    frames, boxes = [], []
    for _, label, _ in bodies:
        frame = clean.copy()
        frame.putalpha(Image.fromarray(np.where(np.isin(labels, assigned[label]), 255, 0).astype('uint8')))
        box = frame.getbbox()
        frames.append(frame.crop(box))
        boxes.append(box)
    return frames, boxes

report = {}
contact = Image.new('RGB', (864, 6 * 124), '#141c20')
draw = ImageDraw.Draw(contact)
for row, cat in enumerate(IDS):
    source = Image.open(ROOT / f'docs/cat-concepts/sprites/{cat}.png')
    assert source.size == (1536, 1024), (cat, source.size)
    frames, boxes = separate_cats(source)
    # One scale for all six poses; never independently stretch a head or body.
    scale = min(132 / max(f.width for f in frames), 74 / max(f.height for f in frames))
    resized = [f.resize((round(f.width*scale), round(f.height*scale)), Image.Resampling.LANCZOS) for f in frames]
    atlas = Image.new('RGBA', (W*12, H))
    for i, (pose, lift) in enumerate(zip(POSES, LIFT)):
        frame = resized[pose]
        x = (W-frame.width)//2
        y = H-6-frame.height-lift
        assert x >= 3 and y >= 3
        atlas.alpha_composite(frame, (W*i+x, y))
    atlas.save(OUT/f'{cat}.png', optimize=True)
    # Six unique key poses on dark background for manual fringe/anatomy review.
    for i, frame in enumerate(resized):
        contact.paste(frame, (W*i+(W-frame.width)//2, row*124+110-frame.height), frame)
    draw.text((8, row*124+3), cat, fill='#b9e3c7')
    report[cat] = {'source_boxes': boxes, 'scale': round(scale, 5), 'bytes': (OUT/f'{cat}.png').stat().st_size}
contact.save(ROOT/'docs/cat-concepts/sprites/cutout-review.png')
(ROOT/'docs/cat-concepts/sprites/registration.json').write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps(report, indent=2))
