from __future__ import annotations

import base64
import io
import math
from typing import Iterable, Tuple

from PIL import Image


def hex_to_rgb(hex_color: str) -> Tuple[int, int, int]:
    value = hex_color.strip().lstrip("#")
    if len(value) not in (3, 6):
        raise ValueError("Invalid hex color length")
    if len(value) == 3:
        value = "".join(ch * 2 for ch in value)
    try:
        r = int(value[0:2], 16)
        g = int(value[2:4], 16)
        b = int(value[4:6], 16)
    except ValueError as exc:
        raise ValueError("Invalid hex color characters") from exc
    return (r, g, b)


def calculate_euclidean_distance(rgb1: Tuple[int, int, int], rgb2: Tuple[int, int, int]) -> float:
    return math.sqrt(sum((int(a) - int(b)) ** 2 for a, b in zip(rgb1, rgb2)))


def extract_dominant_color(image_bytes: bytes) -> Tuple[int, int, int]:
    with Image.open(io.BytesIO(image_bytes)) as img:
        img = img.convert("RGB")
        # Resize to speed up; 64x64 is enough for dominant color
        img = img.resize((64, 64))
        # Use adaptive palette to find dominant color
        paletted = img.convert("P", palette=Image.ADAPTIVE, colors=8)
        palette = paletted.getpalette()
        color_counts = paletted.getcolors()
        assert color_counts is not None
        dominant_color_index = max(color_counts, key=lambda item: item[0])[1]
        r = palette[dominant_color_index * 3]
        g = palette[dominant_color_index * 3 + 1]
        b = palette[dominant_color_index * 3 + 2]
        return (r, g, b)


def generate_gradient_image(
    rgb_from: Tuple[int, int, int], rgb_to: Tuple[int, int, int], size=(600, 600)
) -> bytes:
    width, height = size
    img = Image.new("RGB", size)
    for y in range(height):
        ratio = y / max(1, height - 1)
        r = int(rgb_from[0] * (1 - ratio) + rgb_to[0] * ratio)
        g = int(rgb_from[1] * (1 - ratio) + rgb_to[1] * ratio)
        b = int(rgb_from[2] * (1 - ratio) + rgb_to[2] * ratio)
        for x in range(width):
            img.putpixel((x, y), (r, g, b))
    # Encode to JPEG
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


