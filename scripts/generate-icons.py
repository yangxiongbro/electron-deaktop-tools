"""根据 build/icons 里的 PNG 生成多尺寸 build/icon.ico。

图标源文件是 build/icon.svg：换图标时先把 SVG 导出成
build/icons/{16,24,32,48,64,128,256,512}x{...}.png（同时更新 build/icon.png），
再运行本脚本打包。

注意：这里用 **BMP(DIB) 帧**而不是 PNG 帧。PNG 帧虽然 Vista 之后合法，
但 electron-builder 打包时调用的 rcedit / 部分资源工具只认 DIB 帧，
会报 "Reserved header is not 0 or image type is not icon"。
"""

import struct
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
ICONS = BUILD / "icons"

PNG_SIZES = (16, 24, 32, 48, 64, 128, 256, 512)
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)


def png_path(size: int) -> Path:
    return ICONS / f"{size}x{size}.png"


def bmp_frame(source: Path) -> bytes:
    """把一张 PNG 转成 ICO 里的 BMP 帧：BITMAPINFOHEADER + BGRA 位图 + AND 掩码"""
    with Image.open(source) as image:
        rgba = image.convert("RGBA")
        width, height = rgba.size
        pixels = rgba.load()

        # 像素数据自下而上，每个像素 BGRA
        xor_rows = []
        for y in range(height - 1, -1, -1):
            row = bytearray()
            for x in range(width):
                r, g, b, a = pixels[x, y]
                row += bytes((b, g, r, a))
            xor_rows.append(bytes(row))
        xor_bitmap = b"".join(xor_rows)

        # AND 掩码：1 表示透明，每行按 4 字节对齐
        mask_stride = ((width + 31) // 32) * 4
        mask = bytearray()
        for y in range(height - 1, -1, -1):
            bits = bytearray(mask_stride)
            for x in range(width):
                if pixels[x, y][3] == 0:
                    bits[x // 8] |= 0x80 >> (x % 8)
            mask += bits

    header = struct.pack(
        "<IiiHHIIiiII",
        40,                # biSize
        width,             # biWidth
        height * 2,        # biHeight（XOR + AND 两张图叠加）
        1,                 # biPlanes
        32,                # biBitCount
        0,                 # biCompression = BI_RGB
        len(xor_bitmap) + len(mask),
        0,
        0,
        0,
        0,
    )
    return header + xor_bitmap + bytes(mask)


def build_ico() -> Path:
    frames = []
    for size in ICO_SIZES:
        file = png_path(size)
        if not file.exists():
            raise SystemExit(f"缺少图标文件：{file}")
        frames.append((size, bmp_frame(file)))

    # ICONDIR：reserved=0，type=1(icon)，count
    header = struct.pack("<HHH", 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    entries = b""
    payload = b""
    for size, data in frames:
        # 目录项里宽高是单字节，256 用 0 表示
        dimension = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dimension, dimension, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        payload += data

    target = BUILD / "icon.ico"
    target.write_bytes(header + entries + payload)
    return target


def verify(target: Path) -> None:
    data = target.read_bytes()
    reserved, type_, count = struct.unpack("<HHH", data[:6])
    if reserved != 0 or type_ != 1:
        raise SystemExit(f"ICO 头不正确：reserved={reserved} type={type_}")
    if count != len(ICO_SIZES):
        raise SystemExit(f"ICO 帧数量不对：{count} != {len(ICO_SIZES)}")

    with Image.open(target) as ico:
        sizes = sorted(ico.ico.sizes())
    expected = sorted((size, size) for size in ICO_SIZES)
    if sizes != expected:
        raise SystemExit(f"ICO 尺寸不匹配：{sizes} != {expected}")


def main() -> None:
    missing = [size for size in PNG_SIZES if not png_path(size).exists()]
    if missing:
        raise SystemExit(
            "请先把 build/icon.svg 导出成这些尺寸的 PNG："
            + "、".join(f"{size}x{size}" for size in missing)
        )

    ico = build_ico()
    verify(ico)
    print("icon.ico:", ico, f"({ico.stat().st_size} bytes, {len(ICO_SIZES)} sizes)")


if __name__ == "__main__":
    main()
