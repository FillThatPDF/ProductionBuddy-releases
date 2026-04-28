"""Mashup of options C (magnifier) + E (sparkle), with the paper straight.

Background: sunset gradient (indigo → purple → pink) from E.
Foreground: white doc centered + magnifier overlapping bottom-right + sparkles
around the doc/glass for the AI-helper vibe.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).parent
OUT = HERE / "options"
OUT.mkdir(exist_ok=True)
SIZE = 512


def lerp(a, b, t):
    return a + (b - a) * t


def lerp_rgb(c1, c2, t):
    return (int(lerp(c1[0], c2[0], t)),
            int(lerp(c1[1], c2[1], t)),
            int(lerp(c1[2], c2[2], t)))


def squircle_mask(size, n=4.5, padding=4):
    mask = Image.new("L", (size, size), 0)
    cx, cy = size / 2, size / 2
    r = size / 2 - padding
    pixels = mask.load()
    for y in range(size):
        for x in range(size):
            dx = abs(x - cx) / r
            dy = abs(y - cy) / r
            v = (dx ** n) + (dy ** n)
            if v <= 1.0:
                edge = max(0.0, min(1.0, (1.0 - v) * 30))
                pixels[x, y] = int(255 * min(1.0, edge ** 0.6))
    return mask


def gradient_bg(size, c0, c1, c2, diag=True):
    img = Image.new("RGBA", (size, size))
    pix = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size) if diag else y / size
            if t < 0.5:
                col = lerp_rgb(c0, c1, t * 2)
            else:
                col = lerp_rgb(c1, c2, (t - 0.5) * 2)
            pix[x, y] = (*col, 255)
    return img


def squircled(bg, size=SIZE, n=4.5):
    mask = squircle_mask(size, n=n)
    out = bg.copy()
    out.putalpha(mask)
    return out


# Palette
INDIGO_DEEP = (0x1e, 0x1b, 0x4b)
PURPLE      = (0xc0, 0x84, 0xfc)
SUNSET_PINK = (0xf4, 0x71, 0x73)
SLATE_DARK  = (0x0f, 0x17, 0x2a)
SKY         = (0x38, 0xbd, 0xf8)


def build():
    # 1. Background: sunset gradient squircle
    bg = gradient_bg(SIZE, INDIGO_DEEP, PURPLE, SUNSET_PINK)
    canvas = squircled(bg)
    draw = ImageDraw.Draw(canvas)

    # 2. White doc — STRAIGHT (no rotation), centered horizontally,
    # offset slightly up so the magnifier has room bottom-right.
    doc_w, doc_h = 280, 320
    doc_x = (SIZE - doc_w) // 2 - 10
    doc_y = 90

    # Soft drop shadow under doc
    sh = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.rounded_rectangle([doc_x + 6, doc_y + 18, doc_x + doc_w + 6, doc_y + doc_h + 18],
                         radius=22, fill=(15, 23, 42, 130))
    sh = sh.filter(ImageFilter.GaussianBlur(14))
    canvas.alpha_composite(sh)

    # Doc body
    doc_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    dl = ImageDraw.Draw(doc_layer)
    dl.rounded_rectangle([doc_x, doc_y, doc_x + doc_w, doc_y + doc_h],
                         radius=22, fill=(255, 255, 255, 255))
    # Folded corner top-right
    fold = 50
    dl.polygon([(doc_x + doc_w - fold, doc_y),
                (doc_x + doc_w,        doc_y + fold),
                (doc_x + doc_w - fold, doc_y + fold)],
               fill=(220, 230, 240, 255))
    # Cut original corner
    dl.polygon([(doc_x + doc_w - fold, doc_y),
                (doc_x + doc_w + 1,    doc_y),
                (doc_x + doc_w + 1,    doc_y + fold)],
               fill=(0, 0, 0, 0))

    # Text lines
    line_color = (148, 163, 184, 255)
    accent = (236, 72, 100, 255)  # red highlight on first line
    for i, frac in enumerate([0.85, 0.95, 0.7, 0.9, 0.55]):
        ly = doc_y + 56 + i * 40
        lx1 = doc_x + 30
        lx2 = lx1 + int((doc_w - 60) * frac)
        col = accent if i == 0 else line_color
        dl.rounded_rectangle([lx1, ly, lx2, ly + 12], radius=6, fill=col)
    canvas.alpha_composite(doc_layer)

    # 3. Magnifier — overlapping doc bottom-right.
    mx, my, mr = 360, 360, 96  # center + radius
    # Handle (drawn first so ring sits on top)
    handle_pts = [(mx + 64, my + 64), (mx + 150, my + 150)]
    h_thick = 28
    # Handle drop shadow
    hs = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    hsd = ImageDraw.Draw(hs)
    hsd.line(handle_pts, fill=(15, 23, 42, 130), width=h_thick + 8)
    hs = hs.filter(ImageFilter.GaussianBlur(8))
    canvas.alpha_composite(hs)
    draw.line(handle_pts, fill=SLATE_DARK + (255,), width=h_thick + 4)
    # Lighter strip running through handle for highlight
    draw.line([(handle_pts[0][0] + 4, handle_pts[0][1] - 4),
               (handle_pts[1][0] + 4, handle_pts[1][1] - 4)],
              fill=(244, 244, 245, 200), width=4)

    # Glass ring shadow
    rs = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    rsd = ImageDraw.Draw(rs)
    rsd.ellipse([mx - mr + 2, my - mr + 8, mx + mr + 2, my + mr + 8],
                outline=(15, 23, 42, 130), width=20)
    rs = rs.filter(ImageFilter.GaussianBlur(10))
    canvas.alpha_composite(rs)

    # Glass interior — subtle sky-blue tint
    gl = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gld = ImageDraw.Draw(gl)
    gld.ellipse([mx - mr + 18, my - mr + 18, mx + mr - 18, my + mr - 18],
                fill=(SKY[0], SKY[1], SKY[2], 100))
    canvas.alpha_composite(gl)

    # Glass ring (white outer + dark inner stroke)
    ring_outer = 18
    draw.ellipse([mx - mr, my - mr, mx + mr, my + mr],
                 outline=(244, 244, 245, 255), width=ring_outer)
    draw.ellipse([mx - mr + ring_outer - 2, my - mr + ring_outer - 2,
                  mx + mr - ring_outer + 2, my + mr - ring_outer + 2],
                 outline=SLATE_DARK + (255,), width=3)

    # Glass highlight (top-left arc inside the lens)
    hl = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hl)
    hd.ellipse([mx - mr + 28, my - mr + 22, mx + 4, my + 8],
               fill=(255, 255, 255, 90))
    canvas.alpha_composite(hl)

    # 4. Sparkles — 4-pointed stars scattered around the doc/glass
    sparkle_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sl = ImageDraw.Draw(sparkle_layer)

    def sparkle(cx, cy, size, color=(255, 255, 255, 255)):
        s = size
        pts = [
            (cx, cy - s), (cx + s * 0.32, cy - s * 0.32),
            (cx + s, cy), (cx + s * 0.32, cy + s * 0.32),
            (cx, cy + s), (cx - s * 0.32, cy + s * 0.32),
            (cx - s, cy), (cx - s * 0.32, cy - s * 0.32),
        ]
        sl.polygon(pts, fill=color)

    # Halo for the big sparkle, painted under
    halo = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    hd2 = ImageDraw.Draw(halo)
    hd2.ellipse([395, 75, 495, 175], fill=(255, 255, 255, 60))
    halo = halo.filter(ImageFilter.GaussianBlur(18))
    canvas.alpha_composite(halo)

    sparkle(445, 125, 44, color=(255, 255, 255, 255))   # big top-right
    sparkle(80, 150, 26, color=(255, 230, 240, 255))    # mid-left
    sparkle(110, 380, 22, color=(255, 240, 200, 255))   # lower-left
    sparkle(470, 270, 20, color=(255, 255, 255, 240))   # right of glass
    canvas.alpha_composite(sparkle_layer)

    return canvas


def main():
    img = build()
    out = OUT / "F_sparkle_magnifier.png"
    img.save(out, "PNG")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
