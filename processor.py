"""图像处理核心。

单张图片的处理顺序固定为：旋转 / 翻转 -> 裁剪 -> 缩放 -> 写出。

裁剪框使用归一化坐标（相对旋转后的画面，取值 0~1），因此同一组参数
可以直接套用到尺寸不同的图片上。
"""

import re
from pathlib import Path

from PIL import Image, ImageOps

# 放开大图限制（默认约 1.79 亿像素会直接报错），仍保留解压炸弹防护
Image.MAX_IMAGE_PIXELS = 400_000_000

# 支持的输入格式
SUPPORTED_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".gif"}

# 导出格式 -> 文件后缀 / Pillow 格式名
FORMATS = {
    "jpg": (".jpg", "JPEG"),
    "png": (".png", "PNG"),
    "webp": (".webp", "WEBP"),
}


def load_upright(path):
    """读取图片并应用 EXIF 方向标记，保证与浏览器中看到的方向一致。"""
    img = Image.open(path)
    transposed = ImageOps.exif_transpose(img)
    if transposed is not None:
        img = transposed
    return img


def _natural_key(path):
    """让 img2 排在 img10 前面，纯按字典序会反过来。"""
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", path.name)]


def list_images(folder):
    """列出目录下的图片，按文件名自然排序。"""
    files = [
        p for p in Path(folder).iterdir()
        if p.is_file() and p.suffix.lower() in SUPPORTED_SUFFIXES
    ]
    return sorted(files, key=_natural_key)


def apply_ops(img, ops):
    """依次执行旋转 / 翻转 / 裁剪，返回处理后的图像。"""
    ops = ops or {}

    try:
        rotate = int(ops.get("rotate") or 0) % 360
    except (TypeError, ValueError):
        rotate = 0
    if rotate:
        # 前端记录的是顺时针角度，PIL 的 rotate 是逆时针
        img = img.rotate(-rotate, expand=True)

    if ops.get("flipH"):
        img = ImageOps.mirror(img)
    if ops.get("flipV"):
        img = ImageOps.flip(img)

    return crop(img, ops.get("crop"))


def crop(img, box):
    """按归一化裁剪框裁剪；裁剪框为空或无效时原样返回。"""
    if not box:
        return img
    try:
        x = float(box["x"])
        y = float(box["y"])
        w = float(box["w"])
        h = float(box["h"])
    except (KeyError, TypeError, ValueError):
        return img

    width, height = img.size
    left = max(0, min(width - 1, round(x * width)))
    top = max(0, min(height - 1, round(y * height)))
    right = max(left + 1, min(width, round((x + w) * width)))
    bottom = max(top + 1, min(height, round((y + h) * height)))
    if (right - left, bottom - top) == img.size:
        return img
    return img.crop((left, top, right, bottom))


def resize(img, spec):
    """按导出设置缩放。

    mode 取值：
      original  —— 保持裁剪后的原始像素尺寸
      long_edge —— 长边统一缩放到 value 像素（等比，可能放大也 可能缩小）
      exact     —— 直接拉伸到 width x height
    """
    if not spec:
        return img
    mode = spec.get("mode") or "original"

    if mode == "long_edge":
        try:
            target = int(spec.get("value") or 0)
        except (TypeError, ValueError):
            target = 0
        if target > 0:
            width, height = img.size
            scale = target / max(width, height)
            size = (max(1, round(width * scale)), max(1, round(height * scale)))
            if size != img.size:
                img = img.resize(size, Image.LANCZOS)

    elif mode == "exact":
        try:
            width = int(spec.get("width") or 0)
            height = int(spec.get("height") or 0)
        except (TypeError, ValueError):
            width = height = 0
        if width > 0 and height > 0 and (width, height) != img.size:
            img = img.resize((width, height), Image.LANCZOS)

    return img


def save(img, dest, fmt, quality):
    """按指定格式写出图片。dest 必须是带后缀的完整路径。"""
    pil_format = FORMATS.get((fmt or "jpg").lower(), FORMATS["jpg"])[1]
    dest = Path(dest)

    if pil_format == "JPEG":
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        img.save(dest, pil_format, quality=quality, optimize=True, progressive=True)
    elif pil_format == "WEBP":
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGB")
        img.save(dest, pil_format, quality=quality, method=4)
    else:  # PNG
        if img.mode == "P":
            img = img.convert("RGBA")
        img.save(dest, pil_format, optimize=True)

    return dest


def process_one(src, dest_dir, ops, output):
    """处理单张图片，返回 (输出路径, 输出尺寸)。"""
    img = load_upright(src)
    img = apply_ops(img, ops)
    img = resize(img, output.get("resize"))

    fmt = (output.get("format") or "jpg").lower()
    suffix = FORMATS.get(fmt, FORMATS["jpg"])[0]
    dest = Path(dest_dir) / f"{Path(src).stem}_out{suffix}"

    quality = int(output.get("quality") or 92)
    save(img, dest, fmt, quality)
    return dest, img.size


def process_batch(src_dir, dest_dir, ops_by_name, output):
    """批量处理目录下的图片。

    逐张处理，单张失败不影响其余图片。返回每张图片的处理结果列表。
    """
    results = []
    for src in list_images(src_dir):
        try:
            dest, size = process_one(src, dest_dir, ops_by_name.get(src.name), output)
            results.append({
                "name": src.name,
                "output": dest.name,
                "status": "ok",
                "size": f"{size[0]}x{size[1]}",
            })
        except Exception as exc:  # noqa: BLE001 - 单张失败不应中断整批
            results.append({
                "name": src.name,
                "status": "failed",
                "error": f"{type(exc).__name__}: {exc}",
            })
    return results
