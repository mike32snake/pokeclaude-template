"""Draw the ground tiles and the ranger. No source art: all drawn.

tools/gen_buildings.py already draws every shed this way. The tiles and the trainer
did not get the same treatment: they were cropped out of a Pokemon town image, which
is fine for a private localhost toy and not fine for a repo anyone else can read.
This draws replacements at the same sizes, in the same idiom as the sheds: 1px
near-black outline, three tones per surface, 16px tiles.

Usage: python3 tools/gen_overworld.py [out_dir]     (default: public/art)
"""
import colorsys, os, random, sys
from PIL import Image, ImageDraw

T = 16
INK = (26, 26, 32, 255)

def sh(c, f):
    return tuple(max(0, min(255, int(v * f))) for v in c[:3]) + (255,)

# ---------------------------------------------------------------- ground tiles

def grass():
    """Flat green that tiles seamlessly. The texture is sparse and low-contrast:
    this is drawn edge to edge behind the whole field, so anything busy crawls."""
    base = (122, 186, 112)
    im = Image.new("RGBA", (T, T), base + (255,))
    d = ImageDraw.Draw(im)
    rng = random.Random(7)
    for _ in range(14):
        x, y = rng.randrange(T), rng.randrange(T)
        d.point((x, y), fill=sh(base, 1.06))
    # A few blades, each fully inside the tile so the seam never shows a cut blade.
    for x, y in ((3, 5), (9, 2), (12, 9), (6, 12)):
        d.line([(x, y), (x, y - 2)], fill=sh(base, 0.88))
        d.point((x + 1, y - 1), fill=sh(base, 0.93))
    return im

def path():
    """Packed dirt. Same trick: keep the grain off the edges."""
    base = (214, 196, 156)
    im = Image.new("RGBA", (T, T), base + (255,))
    d = ImageDraw.Draw(im)
    rng = random.Random(11)
    for _ in range(22):
        d.point((rng.randrange(T), rng.randrange(T)), fill=sh(base, 0.94))
    for _ in range(10):
        d.point((rng.randrange(T), rng.randrange(T)), fill=sh(base, 1.04))
    for x, y, w in ((2, 4, 3), (8, 10, 4), (11, 3, 2)):
        d.line([(x, y), (x + w, y)], fill=sh(base, 0.88))
    return im

def flower():
    """Grass with two blooms, so a plot can be freckled without a second tileset."""
    im = grass()
    d = ImageDraw.Draw(im)
    for (cx, cy), petal in (((4, 5), (236, 208, 96)), ((11, 10), (232, 152, 196))):
        d.point((cx, cy - 1), fill=petal + (255,))
        d.point((cx, cy + 1), fill=petal + (255,))
        d.point((cx - 1, cy), fill=petal + (255,))
        d.point((cx + 1, cy), fill=petal + (255,))
        d.point((cx, cy), fill=(250, 248, 220, 255))
    return im

def fence():
    """Two rails on posts, meeting both tile edges exactly so a run reads continuous."""
    wood, im = (168, 126, 78), Image.new("RGBA", (T, T), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for y in (4, 9):                                    # rails, edge to edge
        d.rectangle([0, y, T - 1, y + 2], fill=INK)
        d.rectangle([0, y + 1, T - 1, y + 1], fill=sh(wood, 1.05))
    for x in (2, 10):                                   # posts, capped top and bottom
        d.rectangle([x, 1, x + 3, T - 2], fill=INK)
        d.rectangle([x + 1, 2, x + 2, T - 3], fill=sh(wood, 1.12))
        d.line([(x + 2, 2), (x + 2, T - 3)], fill=sh(wood, 0.8))
    return im

def tree(w=30, h=36):
    """A round canopy over a short trunk, sized to the tile grid it sits on."""
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    leaf = (86, 152, 80)
    trunk_w, trunk_top = 8, h - 11
    d.rectangle([w // 2 - trunk_w // 2 - 1, trunk_top, w // 2 + trunk_w // 2, h - 2], fill=INK)
    d.rectangle([w // 2 - trunk_w // 2, trunk_top, w // 2 + trunk_w // 2 - 1, h - 3],
                fill=(142, 100, 62, 255))
    d.line([(w // 2 + trunk_w // 2 - 1, trunk_top), (w // 2 + trunk_w // 2 - 1, h - 3)],
           fill=(112, 78, 48, 255))
    d.ellipse([0, 0, w - 1, trunk_top + 3], fill=INK)
    d.ellipse([1, 1, w - 2, trunk_top + 2], fill=leaf + (255,))
    d.ellipse([3, 2, w - 8, trunk_top - 4], fill=sh(leaf, 1.18))     # lit side
    d.ellipse([6, 3, w - 13, trunk_top - 10], fill=sh(leaf, 1.34))
    d.arc([1, 1, w - 2, trunk_top + 2], 20, 150, fill=sh(leaf, 0.8), width=2)
    return im

# ---------------------------------------------------------------- the ranger
#
# 32x38 frames, 3 columns (the walk cycle) by 4 rows, in the order the client reads
# them: down, left, right, up. Deliberately not a Pokemon protagonist: a field ranger
# in a wide-brim hat, so the silhouette is its own.
FW, FH = 32, 38
SKIN, HAIR = (232, 186, 146), (74, 54, 40)
PANTS, BOOT = (62, 74, 100), (44, 42, 50)

# public/js/sprites.js reads this sheet as WALK = [0, 1, 0, 2]: column 0 is the stand
# frame and columns 1 and 2 are the two opposite steps. Rows are down, left, right, up.
STEPS = (0, -1, 1)

def ranger_frame(facing, step, coat):
    im = Image.new("RGBA", (FW, FH), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx = FW // 2
    hat = sh(coat, 0.66)[:3]
    profile = facing in ("left", "right")
    lean = 0 if not profile else (-1 if facing == "left" else 1)

    # Legs. The two swing in opposition, so the stand frame is the only one with both
    # feet level. abs() here would move them together and read as a hop.
    for side in (-1, 1):
        swing = step * side
        lx = cx + side * 3 + lean
        foot = 33 - swing                       # forward foot lifts, back foot trails
        d.rectangle([lx - 3, 24, lx + 2, foot + 2], fill=INK)
        d.rectangle([lx - 2, 25, lx + 1, foot - 2], fill=PANTS + (255,))
        d.rectangle([lx - 2, foot - 2, lx + 1, foot + 1], fill=BOOT + (255,))

    # Torso, narrower in profile so a turn is visible at a glance.
    half = 4 if profile else 6
    d.rectangle([cx - half - 1 + lean, 15, cx + half + lean, 26], fill=INK)
    d.rectangle([cx - half + lean, 16, cx + half - 1 + lean, 25], fill=coat + (255,))
    d.rectangle([cx - half + lean, 16, cx - half + 2 + lean, 25], fill=sh(coat, 1.18))
    d.rectangle([cx - half + lean, 22, cx + half - 1 + lean, 23], fill=sh(coat, 0.62))

    # Arms. Facing down or up both show; in profile only the near arm does, and it
    # swings against the near leg.
    arms = [-1, 1] if not profile else [1 if facing == "right" else -1]
    for side in arms:
        ax = cx + side * (half + 1) + lean
        lift = -step * side if profile else 0
        d.rectangle([ax - 1, 16, ax + 1, 23 + lift], fill=INK)
        d.rectangle([ax - 1, 17, ax, 22 + lift], fill=sh(coat, 1.08 if side < 0 else 0.84))

    # Head. The hat brim sits ABOVE the eyes: a brim drawn across the face hides every
    # feature and all four directions collapse into the same silhouette.
    hy = 3                                       # crown top
    d.ellipse([cx - 6 + lean, hy + 4, cx + 5 + lean, hy + 15], fill=INK)
    d.ellipse([cx - 5 + lean, hy + 5, cx + 4 + lean, hy + 14], fill=SKIN + (255,))
    if facing == "up":
        # The whole head, not most of it: leaving the bottom row as skin draws a tan
        # arc under the hair that reads as a collar, not a jaw.
        d.ellipse([cx - 5 + lean, hy + 5, cx + 4 + lean, hy + 14], fill=HAIR + (255,))
        d.ellipse([cx - 4 + lean, hy + 6, cx + 2 + lean, hy + 10], fill=sh(HAIR, 1.25))
    else:
        eyes = {"down": [cx - 3, cx + 2], "left": [cx - 4], "right": [cx + 3]}[facing]
        for ex in eyes:
            d.rectangle([ex + lean, hy + 10, ex + lean, hy + 11], fill=INK)
        if profile:                              # a nose, so left and right differ
            nx = cx + (5 if facing == "right" else -6) + lean
            d.rectangle([nx, hy + 11, nx, hy + 11], fill=sh(SKIN, 0.78))
        d.rectangle([cx - 5 + lean, hy + 5, cx + 4 + lean, hy + 6], fill=HAIR + (255,))

    bw = 8 if not profile else 7                 # brim, wider than the head
    d.ellipse([cx - bw + lean, hy + 3, cx + bw - 1 + lean, hy + 7], fill=INK)
    d.ellipse([cx - bw + 1 + lean, hy + 4, cx + bw - 2 + lean, hy + 6], fill=hat + (255,))
    d.ellipse([cx - 5 + lean, hy - 1, cx + 4 + lean, hy + 5], fill=INK)
    d.ellipse([cx - 4 + lean, hy, cx + 3 + lean, hy + 4], fill=hat + (255,))
    d.ellipse([cx - 4 + lean, hy, cx + lean, hy + 2], fill=sh(hat, 1.35))
    return im

def ranger_sheet(coat):
    sheet = Image.new("RGBA", (FW * 3, FH * 4), (0, 0, 0, 0))
    for row, facing in enumerate(("down", "left", "right", "up")):
        for col, step in enumerate(STEPS):
            sheet.paste(ranger_frame(facing, step, coat), (col * FW, row * FH))
    return sheet

def coat_for(v):
    """Ten coats around the wheel, so a field of rangers never reads as one person."""
    h, l, s = (v / 10.0 + 0.42) % 1.0, 0.42, 0.44
    return tuple(int(c * 255) for c in colorsys.hls_to_rgb(h, l, s))

def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(__file__), "..", "public", "art")
    os.makedirs(f"{out}/tiles", exist_ok=True)
    os.makedirs(f"{out}/trainers", exist_ok=True)
    for name, im in (("grass", grass()), ("path", path()), ("flower", flower()),
                     ("fence", fence()), ("tree", tree())):
        im.save(f"{out}/tiles/{name}.png")
    for v in range(10):
        ranger_sheet(coat_for(v)).save(f"{out}/trainers/variant-{v}.png")
    print(f"drew 5 tiles and 10 ranger variants into {out}")

if __name__ == "__main__":
    main()
