#!/usr/bin/env python3
"""Review aid: pull frames from a rendered MP4 and tile them into labelled contact sheets.
usage: contact-sheet.py <video.mp4> <outprefix> [interval_seconds=2.0] [cols=4] [rows=4]"""
import os, subprocess, sys, glob, tempfile
from PIL import Image, ImageDraw
video, prefix = sys.argv[1], sys.argv[2]
step = float(sys.argv[3]) if len(sys.argv) > 3 else 2.0
cols = int(sys.argv[4]) if len(sys.argv) > 4 else 4
rows = int(sys.argv[5]) if len(sys.argv) > 5 else 4
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ff = os.path.join(root, 'node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg')
env = dict(os.environ, LD_LIBRARY_PATH=os.path.join(root, 'node_modules/@remotion/compositor-linux-x64-gnu'))
tmp = tempfile.mkdtemp()
dur = float(subprocess.run([ff.replace('ffmpeg', 'ffprobe'), '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], capture_output=True, text=True, env=env).stdout)
n = int(dur // step) + 1
for i in range(n):
    subprocess.run([ff, '-y', '-loglevel', 'error', '-ss', f'{i * step:.3f}', '-i', video, '-frames:v', '1', '-vf', 'scale=640:-1', os.path.join(tmp, f'f{i:04d}.png')], check=True, env=env)
files = sorted(glob.glob(os.path.join(tmp, 'f*.png')))
per = cols * rows
for s in range(0, len(files), per):
    chunk = files[s:s + per]
    ims = [Image.open(f) for f in chunk]
    w, h = ims[0].size
    sheet = Image.new('RGB', (cols * w, rows * h), (20, 20, 20))
    d = ImageDraw.Draw(sheet)
    for i, im in enumerate(ims):
        x, y = (i % cols) * w, (i // cols) * h
        sheet.paste(im, (x, y))
        t = (s + i) * step
        d.rectangle([x + 6, y + 6, x + 96, y + 30], fill=(0, 0, 0))
        d.text((x + 12, y + 11), f'{t:5.1f}s f{int(t*30)}', fill=(244, 217, 174))
        d.rectangle([x, y, x + w - 1, y + h - 1], outline=(50, 50, 50))
    out = f'{prefix}-{s // per + 1}.png'
    sheet.save(out)
    print(out)
