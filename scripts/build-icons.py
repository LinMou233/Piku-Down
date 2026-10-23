from pathlib import Path
from PIL import Image
import json

root = Path(__file__).resolve().parents[1]
source = root / 'resources' / 'icon-source.png'
image = Image.open(source).convert('RGBA')
side = max(image.size)
canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
canvas.alpha_composite(image, ((side-image.width)//2, (side-image.height)//2))
sizes = [16, 20, 24, 28, 32, 40, 48, 64, 96, 128, 256, 512, 1024]
for size in sizes:
    canvas.resize((size, size), Image.Resampling.LANCZOS).save(root / 'resources' / 'icons' / f'icon-{size}.png')
canvas.resize((1024, 1024), Image.Resampling.LANCZOS).save(root / 'resources' / 'icon.png')
canvas.save(root / 'resources' / 'icon.ico', sizes=[(size, size) for size in sizes if size <= 256], bitmap_format='bmp')
icon = Image.open(root / 'resources' / 'icon.ico')
actual = sorted(size[0] for size in icon.ico.sizes())
assert actual == [size for size in sizes if size <= 256], actual
print(json.dumps({'ico_sizes': actual, 'png_sizes': sizes, 'transparent': canvas.getpixel((0, 0))[3] == 0}))
