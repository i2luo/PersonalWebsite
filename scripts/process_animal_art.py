#!/usr/bin/env python3
"""Turn a white-background pixel-art render into a clean transparent PNG.

Pipeline (matches how the original penguin/iceberg assets were prepared, plus a
hard de-fringe pass so no white halo pixels survive on the silhouette):

  1. Flood-fill the white background from the borders to transparent. Interior
     whites (a penguin belly, snow on the iceberg) stay opaque because they are
     fenced in by darker outline pixels.
  2. De-fringe: repeatedly drop any near-white opaque pixel that touches a
     transparent neighbour. This removes the anti-aliased halo the user asked us
     to get rid of.
  3. Auto-crop to the remaining content and re-pad onto a fixed canvas so every
     sprite lands with its feet on the floor (and every island is centred). That
     registration is what lets one shared CSS rule position all 14 animals.

Usage:
  process_animal_art.py sprite  in.png  out.png
  process_animal_art.py island  in.png  out.png
"""

import sys
from collections import deque

from PIL import Image


# A pixel counts as "white background" if it is bright and barely saturated.
BG_MIN_CHANNEL = 212          # all of r,g,b must be at least this bright
BG_MAX_SATURATION = 28        # max-min channel spread must be below this
# De-fringe is a touch more aggressive than the flood threshold so the soft
# anti-aliased ring around the silhouette is fully cleared.
FRINGE_MIN_CHANNEL = 196
FRINGE_MAX_SATURATION = 40
FRINGE_PASSES = 3
# Any near-white pixel left on the silhouette after de-fringing is recoloured to
# this dark pixel-art outline tone, so literally no white edge pixels survive
# (even on white animals like the rabbit or the iceberg's snow cap).
OUTLINE_COLOR = (26, 36, 51)


def is_background(px):
    r, g, b, a = px
    if a == 0:
        return True
    lo = min(r, g, b)
    hi = max(r, g, b)
    return lo >= BG_MIN_CHANNEL and (hi - lo) <= BG_MAX_SATURATION


def is_fringe(px):
    r, g, b, a = px
    if a == 0:
        return False
    lo = min(r, g, b)
    hi = max(r, g, b)
    return lo >= FRINGE_MIN_CHANNEL and (hi - lo) <= FRINGE_MAX_SATURATION


def flood_clear_background(im):
    w, h = im.size
    px = im.load()
    seen = bytearray(w * h)
    q = deque()

    def consider(x, y):
        idx = y * w + x
        if seen[idx]:
            return
        seen[idx] = 1
        if is_background(px[x, y]):
            q.append((x, y))

    for x in range(w):
        consider(x, 0)
        consider(x, h - 1)
    for y in range(h):
        consider(0, y)
        consider(w - 1, y)

    while q:
        x, y = q.popleft()
        px[x, y] = (0, 0, 0, 0)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h:
                idx = ny * w + nx
                if not seen[idx]:
                    seen[idx] = 1
                    if is_background(px[nx, ny]):
                        q.append((nx, ny))


def defringe(im):
    w, h = im.size
    px = im.load()
    for _ in range(FRINGE_PASSES):
        kill = []
        for y in range(h):
            for x in range(w):
                if px[x, y][3] == 0:
                    continue
                if not is_fringe(px[x, y]):
                    continue
                touches_edge = False
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        if dx == 0 and dy == 0:
                            continue
                        nx, ny = x + dx, y + dy
                        if not (0 <= nx < w and 0 <= ny < h) or px[nx, ny][3] == 0:
                            touches_edge = True
                            break
                    if touches_edge:
                        break
                if touches_edge:
                    kill.append((x, y))
        if not kill:
            break
        for x, y in kill:
            px[x, y] = (0, 0, 0, 0)


def outline_white_edges(im):
    """Recolour any near-white pixel that sits on the transparent boundary."""
    w, h = im.size
    px = im.load()
    recolor = []
    for y in range(h):
        for x in range(w):
            if px[x, y][3] == 0 or not is_fringe(px[x, y]):
                continue
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    nx, ny = x + dx, y + dy
                    if not (0 <= nx < w and 0 <= ny < h) or px[nx, ny][3] == 0:
                        recolor.append((x, y))
                        break
                else:
                    continue
                break
    for x, y in recolor:
        px[x, y] = (*OUTLINE_COLOR, 255)
    return len(recolor)


def content_bbox(im):
    return im.getbbox()


def register(im, mode):
    """Crop to content and pad onto a fixed canvas with consistent placement.

    Sprites: animal is horizontally centred and scaled to fill the canvas
    height, with its feet pinned a couple of pixels above the canvas bottom.
    Because every animal lands on the same baseline at the same display size,
    one shared CSS rule drops all 14 of them onto the habitat surface instead
    of floating above it.

    Islands: centred on a 480x320 canvas.
    """
    bbox = content_bbox(im)
    if bbox is None:
        return im
    cropped = im.crop(bbox)
    cw, ch = cropped.size

    if mode == "sprite":
        canvas_w = 320
        canvas_h = 320
        floor = 6          # tiny gap so feet read as standing, not embedded
        top_margin = 10
        # Fill the height; clamp width so wide animals (turtle/whale) don't spill.
        scale = min((canvas_h - floor - top_margin) / ch, (canvas_w - 20) / cw)
    else:  # island
        canvas_w = 480
        canvas_h = 320
        floor = 0
        scale = min((canvas_w - 16) / cw, (canvas_h - 16) / ch, 1.0)

    if abs(scale - 1.0) > 1e-3:
        cropped = cropped.resize(
            (max(1, round(cw * scale)), max(1, round(ch * scale))),
            Image.NEAREST,
        )
        cw, ch = cropped.size

    out = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    ox = (canvas_w - cw) // 2
    if mode == "sprite":
        oy = canvas_h - ch - floor
    else:
        oy = (canvas_h - ch) // 2
    out.paste(cropped, (ox, oy), cropped)

    if mode == "island":
        out = align_surface(out, target_top=100)
    return out


def align_surface(im, target_top):
    """Shift an island vertically so its flat walkable top sits at target_top.

    Keeps the single CSS surface % valid for every habitat regardless of how
    tall/short the generated island turned out."""
    w, h = im.size
    px = im.load()
    rows = [sum(1 for x in range(w) if px[x, y][3] > 40) for y in range(h)]
    mx = max(rows) if rows else 0
    if not mx:
        return im
    platform_top = next((y for y in range(h) if rows[y] > 0.5 * mx), None)
    if platform_top is None:
        return im
    dy = target_top - platform_top
    # Don't push content off-canvas.
    bbox = im.getbbox()
    if bbox:
        dy = max(dy, -bbox[1])
        dy = min(dy, h - bbox[3])
    if dy == 0:
        return im
    shifted = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    shifted.paste(im, (0, dy), im)
    return shifted


def process(mode, src, dst):
    im = Image.open(src).convert("RGBA")
    flood_clear_background(im)
    defringe(im)
    im = register(im, mode)
    outline_white_edges(im)
    im.save(dst)

    # Quick report so the caller can sanity-check the result.
    px = im.load()
    w, h = im.size
    near_white_edge = 0
    for y in range(h):
        for x in range(w):
            if px[x, y][3] == 0:
                continue
            if is_fringe(px[x, y]):
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        nx, ny = x + dx, y + dy
                        if not (0 <= nx < w and 0 <= ny < h) or px[nx, ny][3] == 0:
                            near_white_edge += 1
                            break
                    else:
                        continue
                    break
    print(f"{dst}: {im.size} white_edge_pixels_left={near_white_edge}")


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] not in ("sprite", "island"):
        print(__doc__)
        sys.exit(1)
    process(sys.argv[1], sys.argv[2], sys.argv[3])
