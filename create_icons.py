#!/usr/bin/env python3
"""
Generate PNG icons for Gmail OTP Catcher extension.
Uses only Python stdlib (struct + zlib) — no Pillow required.
Run from the extension root directory: python3 create_icons.py
"""

import struct
import zlib
import os


def make_chunk(chunk_type: bytes, data: bytes) -> bytes:
    payload = chunk_type + data
    crc = zlib.crc32(payload) & 0xFFFFFFFF
    return struct.pack('>I', len(data)) + payload + struct.pack('>I', crc)


def create_png(size: int, bg=(26, 115, 232), letter_color=(255, 255, 255)) -> bytes:
    """Create a simple icon PNG with a blue background and white envelope shape."""
    r, g, b = bg
    lr, lg, lb = letter_color

    # Build raw pixel rows (filter byte 0 = None per row)
    rows = []
    cx, cy = size // 2, size // 2

    # Draw a simple envelope shape
    margin = size // 5
    top    = size // 3
    bottom = size - margin
    left   = margin
    right  = size - margin

    for y in range(size):
        row = bytearray([0])  # filter byte
        for x in range(size):
            inside_rect = (left <= x <= right) and (top <= y <= bottom)
            # Envelope flap: two diagonal lines from top corners to center-top
            flap_y = top + abs(x - cx) * (cy - top) // max(cx - left, 1)
            on_flap = inside_rect and y <= flap_y and y >= top

            # Bottom lines of envelope
            on_border = (
                inside_rect and (
                    x == left or x == right or y == top or y == bottom or on_flap
                )
            )

            if inside_rect:
                pr, pg, pb = lr, lg, lb if on_border else (lr, lg, lb)
                row += bytes([lr, lg, lb])
            else:
                row += bytes([r, g, b])
        rows.append(bytes(row))

    raw = b''.join(rows)
    compressed = zlib.compress(raw, 9)

    png = b'\x89PNG\r\n\x1a\n'
    png += make_chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    png += make_chunk(b'IDAT', compressed)
    png += make_chunk(b'IEND', b'')
    return png


def create_solid_icon(size: int, r=26, g=115, b=232) -> bytes:
    """Create a solid-color PNG (simplest valid PNG)."""
    rows = []
    for _ in range(size):
        row = b'\x00' + bytes([r, g, b] * size)
        rows.append(row)
    raw = b''.join(rows)
    compressed = zlib.compress(raw, 9)

    png = b'\x89PNG\r\n\x1a\n'
    png += make_chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    png += make_chunk(b'IDAT', compressed)
    png += make_chunk(b'IEND', b'')
    return png


def draw_icon(size: int) -> bytes:
    """Draw a blue rounded-square icon with a white letter 'G' style mark."""
    pixels = []
    cx, cy = size / 2, size / 2
    radius = size / 2 - 0.5

    # Google blue
    bg_r, bg_g, bg_b = 26, 115, 232
    fg_r, fg_g, fg_b = 255, 255, 255

    rows = []
    for y in range(size):
        row = bytearray([0])  # filter byte = None
        for x in range(size):
            # Circular icon shape
            dist = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            if dist > radius:
                # Outside circle → white background
                row += bytes([255, 255, 255])
                continue

            # Draw a simple envelope / mail icon
            m = size * 0.15   # margin
            t = size * 0.32   # top of envelope
            bot = size * 0.72  # bottom
            lft = size * 0.18  # left
            rgt = size * 0.82  # right

            in_rect = (lft <= x <= rgt) and (t <= y <= bot)
            # Diagonal flap
            flap_y = t + abs(x - cx) / (cx - lft) * (cy * 0.52 - t)
            on_flap_line = in_rect and (t <= y <= flap_y + 1)

            if in_rect:
                row += bytes([fg_r, fg_g, fg_b])
            else:
                row += bytes([bg_r, bg_g, bg_b])

        rows.append(bytes(row))

    raw = b''.join(rows)
    compressed = zlib.compress(raw, 9)
    png = b'\x89PNG\r\n\x1a\n'
    png += make_chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    png += make_chunk(b'IDAT', compressed)
    png += make_chunk(b'IEND', b'')
    return png


if __name__ == '__main__':
    os.makedirs('icons', exist_ok=True)
    for sz in [16, 48, 128]:
        data = create_solid_icon(sz)
        path = f'icons/icon{sz}.png'
        with open(path, 'wb') as f:
            f.write(data)
        print(f'  ✓ Created {path}  ({sz}×{sz} px, {len(data)} bytes)')
    print('\nAll icons created. Load the extension in Chrome now.')
