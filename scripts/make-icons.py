"""Generate the placeholder icons in extension/icons (requires Pillow).

Run from the repository root:  python3 scripts/make-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

for size in (16, 48, 128):
    scale = 8  # draw large, then downsample for smooth edges
    big = size * scale
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, big - 1, big - 1), radius=big // 5, fill=(26, 115, 232, 255))
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", int(big * 0.7))
    except OSError:
        font = ImageFont.load_default(size=int(big * 0.7))
    d.text((big / 2, big / 2), "W", font=font, fill="white", anchor="mm")
    img.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png", optimize=True)
    print(f"wrote {OUT / f'icon{size}.png'}")
