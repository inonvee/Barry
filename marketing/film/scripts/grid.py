#!/usr/bin/env python3
"""Tile stills into one review sheet. usage: grid.py out.png cols img1 img2 ..."""
import sys
from PIL import Image, ImageDraw
out, cols, files = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
ims = [Image.open(f).convert('RGB').resize((960, 540)) for f in files]
rows = (len(ims) + cols - 1) // cols
sheet = Image.new('RGB', (cols * 960, rows * 540), (30, 30, 30))
d = ImageDraw.Draw(sheet)
for i, (im, f) in enumerate(zip(ims, files)):
    x, y = (i % cols) * 960, (i // cols) * 540
    sheet.paste(im, (x, y))
    d.rectangle([x, y, x + 959, y + 539], outline=(60, 60, 60))
    d.text((x + 10, y + 10), f.split('/')[-1], fill=(244, 217, 174))
sheet.save(out)
