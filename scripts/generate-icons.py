"""生成应用图标：build/icon.png、build/icon.ico、build/icons/*.png"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
ICONS = BUILD / "icons"


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def make_icon(size: int) -> Image.Image:
    scale = 4
    canvas_size = size * scale
    image = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))

    # 背景渐变
    gradient = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(gradient)
    start = (79, 140, 255)
    end = (111, 91, 255)
    for y in range(canvas_size):
        t = y / max(1, canvas_size - 1)
        color = (
            lerp(start[0], end[0], t),
            lerp(start[1], end[1], t),
            lerp(start[2], end[2], t),
            255,
        )
        draw.line([(0, y), (canvas_size, y)], fill=color)

    radius = int(canvas_size * 0.22)
    mask = Image.new("L", (canvas_size, canvas_size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, canvas_size - 1, canvas_size - 1], radius=radius, fill=255
    )
    image.paste(gradient, (0, 0), mask)

    overlay = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay)
    odraw.rounded_rectangle(
        [canvas_size * 0.06, canvas_size * 0.06, canvas_size * 0.94, canvas_size * 0.94],
        radius=int(radius * 0.82),
        outline=(255, 255, 255, 46),
        width=max(2, int(canvas_size * 0.006)),
    )
    image.alpha_composite(overlay)

    text = "DT"
    font = None
    for candidate in (
        "C:/Windows/Fonts/segoeuib.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ):
        if Path(candidate).exists():
            try:
                font = ImageFont.truetype(candidate, int(canvas_size * 0.42))
                break
            except OSError:
                continue
    if font is None:
        font = ImageFont.load_default()

    draw = ImageDraw.Draw(image)
    box = draw.textbbox((0, 0), text, font=font)
    text_w = box[2] - box[0]
    text_h = box[3] - box[1]
    draw.text(
        ((canvas_size - text_w) / 2 - box[0], (canvas_size - text_h) / 2 - box[1]),
        text,
        font=font,
        fill=(255, 255, 255, 255),
    )

    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    ICONS.mkdir(parents=True, exist_ok=True)

    base = make_icon(512)
    base.save(BUILD / "icon.png")

    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [make_icon(s) for s in sizes]
    frames[-1].save(BUILD / "icon.ico", format="ICO", sizes=[(s, s) for s in sizes])

    for size in (16, 32, 48, 64, 128, 256, 512):
        make_icon(size).save(ICONS / f"{size}x{size}.png")

    print("icons generated at", BUILD)


if __name__ == "__main__":
    main()
