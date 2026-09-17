"""Generate a custom GBA-style building per repo. No source art: all drawn.

Style rules (match FRLG): 1px near-black outline, 3-tone shading per surface,
roof overhangs the walls by 4px, windows are 2-pane blue glass with a light frame,
a dark doorway sits centre-bottom, and a themed ornament identifies the project.
Sizes are whole tiles (16px) so the town compiler can place them on the grid.
"""
import json, os
from PIL import Image, ImageDraw

T = 16
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "art", "buildings")
INK = (26, 26, 32, 255)

def sh(c, f):
    return (max(0, min(255, int(c[0] * f))), max(0, min(255, int(c[1] * f))),
            max(0, min(255, int(c[2] * f))), 255)

THEMES = {
    # name:        roof,             wall,             accent           roof style, ornament
    "center":   ((214, 74, 64),  (242, 240, 232), (86, 148, 214), "curved",  "heart"),
    "mart":     ((70, 120, 196), (242, 240, 232), (240, 200, 80), "gable",   "envelope"),
    "office":   ((122, 134, 186), (236, 236, 242), (90, 160, 220), "flat2",  "globe"),
    "command":  ((70, 82, 128),  (214, 220, 232), (120, 200, 230), "flat2",  "dish"),
    "clinic":   ((236, 240, 244), (250, 250, 250), (214, 74, 64),  "hip",     "cross"),
    "tower":    ((92, 84, 120),  (206, 200, 214), (240, 216, 120), "spire",   "clock"),
    "guild":    ((92, 150, 92),  (226, 206, 168), (150, 108, 62),  "gable",   "banner"),
    "workshop": ((162, 108, 62), (206, 168, 116), (120, 90, 54),   "gable",   "gear"),
    "lab":      ((150, 158, 176), (238, 240, 244), (110, 196, 208), "dome",   "scope"),
    "block":    ((110, 116, 140), (220, 218, 226), (140, 170, 210), "flat2",  "doors"),
    "shop":     ((198, 150, 70), (242, 236, 220), (214, 74, 64),   "awning",  "chart"),
    "tent":     ((178, 96, 72),  (222, 206, 176), (120, 90, 54),   "tent",    None),
}

def draw_roof(d, style, x0, y0, w, rh, roof):
    lo, hi = sh(roof, .62), sh(roof, 1.16)
    ov = 4
    rx0, rx1 = x0 - ov, x0 + w + ov
    if style in ("gable", "hip"):
        cx = rx0 + (rx1 - rx0) // 2
        if style == "gable":
            d.polygon([(rx0, y0 + rh), (cx, y0 - rh // 2), (rx1, y0 + rh)], fill=roof, outline=INK)
            for i in range(4):
                yy = y0 - rh // 2 + (rh + rh // 2) * i // 4
                t = (yy - (y0 - rh // 2)) / (rh + rh // 2)
                d.line([(cx - (cx - rx0) * t + 1, yy), (cx + (rx1 - cx) * t - 1, yy)], fill=lo)
            d.line([(rx0 + 2, y0 + rh - 1), (cx, y0 - rh // 2 + 1)], fill=hi)
        else:
            inset = (rx1 - rx0) // 4
            d.polygon([(rx0, y0 + rh), (rx0 + inset, y0), (rx1 - inset, y0), (rx1, y0 + rh)],
                      fill=roof, outline=INK)
            for i in range(y0 + 3, y0 + rh, 3):
                t = (i - y0) / max(1, rh)
                d.line([(rx0 + inset * (1 - t) + 1, i), (rx1 - inset * (1 - t) - 1, i)], fill=lo)
            d.line([(rx0 + inset, y0), (rx1 - inset, y0)], fill=hi)
    elif style == "curved":
        d.pieslice([rx0, y0, rx1, y0 + rh * 2], 180, 360, fill=roof, outline=INK)
        d.pieslice([rx0 + 5, y0 + 3, rx1 - 5, y0 + rh * 2 - 3], 180, 360, fill=sh(roof, .82), outline=None)
        d.arc([rx0 + 2, y0 + 1, rx1 - 2, y0 + rh * 2 - 1], 190, 350, fill=hi)
    elif style == "dome":
        d.rectangle([rx0, y0 + rh // 2, rx1, y0 + rh], fill=roof, outline=INK)
        cx = (rx0 + rx1) // 2; r = rh
        d.pieslice([cx - r, y0 - r // 2, cx + r, y0 + rh + r // 2], 180, 360, fill=sh(roof, 1.05), outline=INK)
        d.arc([cx - r + 3, y0 - r // 2 + 3, cx + r - 3, y0 + rh], 200, 340, fill=hi)
    elif style == "spire":
        cx = (rx0 + rx1) // 2
        d.polygon([(rx0, y0 + rh), (cx, y0 - rh), (rx1, y0 + rh)], fill=roof, outline=INK)
        d.line([(cx, y0 - rh), (rx0 + 2, y0 + rh - 1)], fill=hi)
    elif style == "awning":
        d.rectangle([rx0, y0, rx1, y0 + rh], fill=roof, outline=INK)
        for i in range(rx0, rx1, 8):
            d.rectangle([i, y0 + rh - 5, min(i + 3, rx1 - 1), y0 + rh - 1], fill=sh(roof, .7))
        d.line([(rx0 + 1, y0 + 1), (rx1 - 1, y0 + 1)], fill=hi)
    elif style == "tent":
        cx = (rx0 + rx1) // 2
        d.polygon([(rx0, y0 + rh * 2), (cx, y0), (rx1, y0 + rh * 2)], fill=roof, outline=INK)
        for i in range(1, 4):
            d.line([(cx, y0 + 2), (rx0 + (rx1 - rx0) * i // 4, y0 + rh * 2)], fill=lo)
    else:  # flat2 — a slab with a parapet
        d.rectangle([rx0, y0, rx1, y0 + rh], fill=roof, outline=INK)
        d.rectangle([rx0, y0, rx1, y0 + 3], fill=sh(roof, .75), outline=INK)
        d.line([(rx0 + 1, y0 + 4), (rx1 - 1, y0 + 4)], fill=hi)

def draw_ornament(d, kind, cx, y, accent):
    if kind is None: return
    a, lo = accent, sh(accent, .6)
    if kind == "cross":
        d.rectangle([cx - 2, y - 11, cx + 2, y - 1], fill=a, outline=INK)
        d.rectangle([cx - 6, y - 8, cx + 6, y - 4], fill=a, outline=INK)
    elif kind == "clock":
        d.ellipse([cx - 9, y - 18, cx + 9, y], fill=(246, 244, 230, 255), outline=INK, width=2)
        d.line([(cx, y - 9), (cx, y - 15)], fill=INK, width=2)
        d.line([(cx, y - 9), (cx + 5, y - 9)], fill=INK, width=2)
    elif kind == "dish":
        d.line([(cx, y), (cx, y - 10)], fill=INK, width=2)
        d.pieslice([cx - 9, y - 20, cx + 9, y - 6], 200, 340, fill=(230, 232, 238, 255), outline=INK)
        d.line([(cx, y - 13), (cx + 6, y - 19)], fill=INK)
    elif kind == "scope":
        d.polygon([(cx - 9, y - 2), (cx + 2, y - 15), (cx + 9, y - 10), (cx - 3, y + 1)], fill=(200, 206, 216, 255), outline=INK)
        d.ellipse([cx + 3, y - 16, cx + 10, y - 9], fill=a, outline=INK)
    elif kind == "envelope":
        d.rectangle([cx - 9, y - 13, cx + 9, y - 1], fill=(250, 248, 240, 255), outline=INK)
        d.line([(cx - 9, y - 13), (cx, y - 5)], fill=INK); d.line([(cx + 9, y - 13), (cx, y - 5)], fill=INK)
    elif kind == "globe":
        d.ellipse([cx - 8, y - 17, cx + 8, y - 1], fill=a, outline=INK)
        d.arc([cx - 8, y - 17, cx + 8, y - 1], 0, 360, fill=sh(a, .6))
        d.line([(cx - 8, y - 9), (cx + 8, y - 9)], fill=sh(a, .5))
        d.arc([cx - 4, y - 17, cx + 4, y - 1], 0, 360, fill=sh(a, .5))
    elif kind == "gear":
        d.ellipse([cx - 8, y - 16, cx + 8, y], fill=a, outline=INK)
        for dx, dy in ((0, -1), (0, 1), (-1, 0), (1, 0)):
            d.rectangle([cx + dx * 9 - 2, y - 8 + dy * 9 - 2, cx + dx * 9 + 2, y - 8 + dy * 9 + 2], fill=a, outline=INK)
        d.ellipse([cx - 3, y - 11, cx + 3, y - 5], fill=(250, 250, 250, 255), outline=INK)
    elif kind == "banner":
        d.line([(cx, y + 2), (cx, y - 18)], fill=INK, width=2)
        d.polygon([(cx + 1, y - 18), (cx + 14, y - 14), (cx + 1, y - 8)], fill=a, outline=INK)
    elif kind == "chart":
        d.rectangle([cx - 10, y - 14, cx + 10, y], fill=(250, 248, 240, 255), outline=INK)
        for i, h in enumerate((4, 7, 11)):
            d.rectangle([cx - 7 + i * 6, y - 2 - h, cx - 4 + i * 6, y - 2], fill=a, outline=INK)
    elif kind == "heart":
        d.ellipse([cx - 8, y - 12, cx - 1, y - 5], fill=a, outline=INK)
        d.ellipse([cx + 1, y - 12, cx + 8, y - 5], fill=a, outline=INK)
        d.polygon([(cx - 8, y - 8), (cx, y + 1), (cx + 8, y - 8)], fill=a, outline=INK)
    elif kind == "doors":
        for i in range(3):
            d.rectangle([cx - 14 + i * 11, y - 9, cx - 7 + i * 11, y], fill=sh(a, .55), outline=INK)

ORN_H = 7          # headroom above the roof so ornaments are never clipped

def build(theme, tw, th, doors=1, floors=1):
    roof, wall, accent, style, orn = THEMES[theme]
    W = tw * T
    rh = min(9, max(6, th * T // 2))
    # a spire rises a further rh above the roof line, so it needs its own headroom
    head = ORN_H + (rh if style == "spire" else 0)
    # Extra wall height so a one-tile shed still reads as a building, not a table.
    # It overhangs upward into the grass gap above the plot, which is empty anyway.
    H = th * T + head + 12
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    top = head + rh
    bx0, bx1 = 6, W - 7
    by0, by1 = top, H - 3
    # walls
    d.rectangle([bx0, by0, bx1, by1], fill=wall, outline=INK)
    d.rectangle([bx0 + 1, by0 + 1, bx0 + 3, by1 - 1], fill=sh(wall, 1.06))
    d.rectangle([bx1 - 3, by0 + 1, bx1 - 1, by1 - 1], fill=sh(wall, .88))
    d.line([(bx0 + 1, by1 - 1), (bx1 - 1, by1 - 1)], fill=sh(wall, .8))
    if theme in ("workshop", "guild"):                       # horizontal timber boards
        for yy in range(by0 + 4, by1 - 2, 5):
            d.line([(bx0 + 1, yy), (bx1 - 1, yy)], fill=sh(wall, .86))
    elif theme in ("office", "command", "block", "tower"):   # floor bands
        for yy in range(by0 + 1, by1 - 2, max(12, (by1 - by0) // max(1, floors))):
            d.line([(bx0 + 1, yy), (bx1 - 1, yy)], fill=sh(wall, .9))
    # foundation
    d.rectangle([bx0 - 2, by1 - 2, bx1 + 2, by1 + 2], fill=sh(wall, .72), outline=INK)
    # door(s)
    dw, dh = 7, 8
    slots = [bx0 + (bx1 - bx0) * (k + 1) // (doors + 1) for k in range(doors)]
    for cx in slots:
        d.rectangle([cx - dw // 2, by1 - dh, cx + dw // 2, by1], fill=sh(accent, .38), outline=INK)
        d.rectangle([cx - dw // 2 + 2, by1 - dh + 2, cx + dw // 2 - 2, by1 - 2], fill=sh(accent, .5))
        d.line([(cx, by1 - dh + 2), (cx, by1 - 2)], fill=sh(accent, .3))
        d.rectangle([cx - dw // 2 - 2, by1, cx + dw // 2 + 2, by1 + 2], fill=sh(wall, .66), outline=INK)
    # windows: rows between roof and door band
    gw, gh = 6, 5
    inner_w = bx1 - bx0 - 10
    cols = max(1, inner_w // (gw + 6))
    rows = floors
    for r in range(rows):
        wy = by0 + 7 + r * (gh + 8)
        if wy + gh > by1 - dh - 2 and r > 0: break
        for c in range(cols):
            wx = bx0 + 5 + c * (inner_w // cols) + (inner_w // cols - gw) // 2
            if any(abs(wx + gw // 2 - s) < dw for s in slots) and wy + gh > by1 - dh - 4: continue
            d.rectangle([wx, wy, wx + gw, wy + gh], fill=(250, 250, 246, 255), outline=INK)
            d.rectangle([wx + 2, wy + 2, wx + gw - 2, wy + gh - 2], fill=sh(accent, 1.0))
            d.polygon([(wx + 2, wy + gh - 2), (wx + gw - 2, wy + 2), (wx + gw - 2, wy + 6),
                       (wx + 6, wy + gh - 2)], fill=sh(accent, 1.35))
            d.line([(wx + gw // 2, wy + 2), (wx + gw // 2, wy + gh - 2)], fill=(250, 250, 246, 255))
    draw_roof(d, style, bx0, top - rh, bx1 - bx0, rh, roof)
    ridge = {"gable": top - rh - rh // 2, "spire": top - 2 * rh, "dome": top - rh - rh // 2,
             "curved": top - rh, "tent": top - rh}.get(style, top - rh)
    draw_ornament(d, orn, W // 2, ridge + 3, accent)
    return im

# Shelters inside the pens: small huts, distinguished by roof style + ornament,
# not by bulk. Keep them <= 4 tiles wide so a pen still reads as open ground.
SPECS = {   # archetype -> (theme, tiles w, h, doors, window rows)
    # One tile tall, wide and low: five rows of pens have to share one screen.
    "center":   ("center",   4, 1, 1, 1),
    "mart":     ("mart",     3, 1, 1, 1),
    "office":   ("office",   4, 1, 1, 1),
    "command":  ("command",  4, 1, 1, 1),
    "clinic":   ("clinic",   4, 1, 1, 1),
    "tower":    ("tower",    2, 1, 1, 1),
    "guild":    ("guild",    4, 1, 1, 1),
    "workshop": ("workshop", 3, 1, 1, 1),
    "lab":      ("lab",      4, 1, 1, 1),
    "block":    ("block",    4, 1, 2, 1),
    "shop":     ("shop",     3, 1, 1, 1),
    "tent":     ("tent",     2, 1, 1, 0),
}

def main():
    os.makedirs(OUT, exist_ok=True)
    sizes = {}
    for key, (theme, tw, th, doors, floors) in SPECS.items():
        im = build(theme, tw, th, doors, floors)
        im.save(f"{OUT}/{key}.png")
        # solid = the walls/foundation that block movement; the rest is roof + ornament
        # headroom that the player should be able to stand "behind".
        roof, wall, accent, style, orn = THEMES[theme]
        sizes[key] = {"w": im.width, "h": im.height, "tilesW": tw, "tilesH": th,
                      "accent": list(accent[:3]), "roof": list(roof[:3])}
    json.dump(sizes, open(f"{OUT}/sizes.json", "w"), indent=1)
    print("generated", len(SPECS), "buildings:", ", ".join(sorted(SPECS)))

if __name__ == "__main__":
    main()
