#!/usr/bin/env python3
"""Inspect or render bounded JPEG image previews/crops with PyMuPDF."""

import json
import sys


def fail(message: str) -> None:
    sys.stderr.buffer.write(json.dumps({"error": message}, ensure_ascii=False).encode("utf-8"))
    raise SystemExit(2)


def load_fitz():
    try:
        import fitz
    except ImportError:
        fail("PyMuPDF is not installed. Install it with: python -m pip install pymupdf")
    return fitz


def render(page, fitz, max_dimension: int, clip=None) -> None:
    rect = clip or page.rect
    longest = max(rect.width, rect.height, 1)
    scale = min(1.0, max_dimension / longest)
    pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=clip, alpha=False)
    sys.stdout.buffer.write(pixmap.tobytes("jpeg", jpg_quality=82))


def main() -> None:
    # Backwards-compatible legacy form: image-worker.py <image-path> <max-dimension>
    if len(sys.argv) == 3 and sys.argv[1] not in {"info", "preview", "crop"}:
        mode = "preview"
        args = [sys.argv[1], sys.argv[2]]
    elif len(sys.argv) >= 3:
        mode = sys.argv[1]
        args = sys.argv[2:]
    else:
        fail("Usage: image-worker.py <info|preview|crop> <image-path> [arguments]")

    fitz = load_fitz()
    image_path = args[0]
    try:
        document = fitz.open(image_path)
        page = document.load_page(0)
        if mode == "info":
            if len(args) != 1:
                fail("Usage: image-worker.py info <image-path>")
            result = {
                "width": int(round(page.rect.width)),
                "height": int(round(page.rect.height)),
            }
            sys.stdout.buffer.write(json.dumps(result).encode("utf-8"))
            return

        if mode == "preview":
            if len(args) != 2:
                fail("Usage: image-worker.py preview <image-path> <max-dimension>")
            max_dimension = max(128, min(int(args[1]), 4096))
            render(page, fitz, max_dimension)
            return

        if mode == "crop":
            if len(args) != 6:
                fail("Usage: image-worker.py crop <image-path> <x> <y> <width> <height> <max-dimension>")
            x, y, width, height = (float(value) for value in args[1:5])
            max_dimension = max(128, min(int(args[5]), 1600))
            if x < 0 or y < 0 or width <= 0 or height <= 0:
                fail("Crop coordinates must use non-negative x/y and positive width/height.")
            x1 = min(page.rect.width, x + width)
            y1 = min(page.rect.height, y + height)
            if x >= page.rect.width or y >= page.rect.height or x1 <= x or y1 <= y:
                fail("Crop rectangle lies outside the image bounds.")
            clip = fitz.Rect(x, y, x1, y1)
            render(page, fitz, max_dimension, clip=clip)
            return

        fail(f"Unknown image worker mode: {mode}")
    except Exception as exc:
        fail(f"Unable to render image preview: {exc}")


if __name__ == "__main__":
    main()
