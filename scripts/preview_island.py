#!/usr/bin/env python3
"""Compose island + sprite the way the CSS does, so positioning can be eyeballed.

Mirrors the layout in styles.css for `.animal-island--img`:
  - island image width W, height W*320/480
  - sprite image shown at a fixed height, horizontally centred on the creature
  - creature `bottom: SURFACE%` of the island box
  - food shown beside the mouth while eating
  - zzz to the upper-right of the head while sleeping (sprite stays upright)

Usage: preview_island.py island.png sprite.png out.png [surface_pct] [food_x_pct] [food_y_pct]
"""

import sys
from PIL import Image, ImageDraw, ImageFont

K = 4                      # zoom for legibility
ISLAND_W = 83 * K          # matches the ~83px nav render
SPRITE_H = 34 * K          # matches .island-creature-sprite height


def load(p):
    return Image.open(p).convert("RGBA")


def scaled(im, w=None, h=None):
    iw, ih = im.size
    if w:
        h = round(ih * w / iw)
    else:
        w = round(iw * h / ih)
    return im.resize((w, h), Image.NEAREST)


def compose(island, sprite, surface_pct, food_xy, state, label):
    iw = ISLAND_W
    ih = round(iw * island.size[1] / island.size[0])
    sh = SPRITE_H
    sw = round(sprite.size[0] * sh / sprite.size[1])

    cw, chh = iw + 220, ih + 230
    canvas = Image.new("RGBA", (cw, chh), (16, 28, 36, 255))
    d = ImageDraw.Draw(canvas)

    ix = 110
    ibot = chh - 40
    itop = ibot - ih
    isl = scaled(island, w=iw)
    canvas.alpha_composite(isl, (ix, itop))

    # surface guide line
    surf_y = round(ibot - surface_pct / 100 * ih)
    d.line([(ix - 10, surf_y), (ix + iw + 10, surf_y)], fill=(255, 80, 80, 120), width=1)

    creature_left_pct = 65 if state == "eat" else 42
    ccx = ix + creature_left_pct / 100 * iw
    spr = scaled(sprite, h=sh)
    spr_bottom = surf_y
    spx = round(ccx - sw / 2)
    spy = round(spr_bottom - sh)
    canvas.alpha_composite(spr, (spx, spy))

    if state == "eat":
        fx_pct, fy_pct = food_xy
        fx = ix + fx_pct / 100 * iw
        fy = ibot - fy_pct / 100 * ih
        r = 7
        d.ellipse([fx - r, fy - r, fx + r, fy + r], fill=(120, 200, 255, 255))

    if state == "sleep":
        # zzz to the upper-right of the head
        head_top = spy
        zx = round(ccx + sw * 0.34)
        zy = round(head_top + sh * 0.05)
        try:
            font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 22)
        except Exception:
            font = ImageFont.load_default()
        d.text((zx, zy), "z", fill=(255, 255, 255, 255), font=font)
        d.text((zx + 14, zy - 12), "z", fill=(255, 255, 255, 220), font=font)

    d.text((10, 8), label, fill=(255, 255, 255, 230))
    return canvas


def main():
    island = load(sys.argv[1])
    sprite = load(sys.argv[2])
    out = sys.argv[3]
    surface = float(sys.argv[4]) if len(sys.argv) > 4 else 67
    fx = float(sys.argv[5]) if len(sys.argv) > 5 else 78
    fy = float(sys.argv[6]) if len(sys.argv) > 6 else 88

    panels = [
        compose(island, sprite, surface, (fx, fy), "idle", f"idle  surf={surface}"),
        compose(island, sprite, surface, (fx, fy), "eat", f"eat  food=({fx},{fy})"),
        compose(island, sprite, surface, (fx, fy), "sleep", "sleep (upright + zzz)"),
    ]
    w = sum(p.size[0] for p in panels) + 20
    h = max(p.size[1] for p in panels)
    strip = Image.new("RGBA", (w, h), (16, 28, 36, 255))
    x = 10
    for p in panels:
        strip.alpha_composite(p, (x, 0))
        x += p.size[0] + 10
    strip.save(out)
    print("wrote", out, strip.size)


if __name__ == "__main__":
    main()
