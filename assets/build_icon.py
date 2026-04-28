"""Generate assets/icon.png + iconset + icon.icns for Production Buddy.

Design (the chosen mashup of "magnifier" + "sparkle"):
  - Squircle background, sunset gradient (indigo → purple → pink).
  - White document, centered, straight (not tilted), with text lines
    and a red-highlight first line (the markup vibe).
  - Magnifying glass overlapping the bottom-right of the doc (review/QA).
  - 4-pointed sparkles scattered around with a soft halo on the big one
    (the "AI helper" shimmer).

Run from this folder:
    python3 build_icon.py
"""
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).parent
SIZE = 1024  # master canvas


# ---------- color helpers ----------
def lerp(a, b, t):
    return a + (b - a) * t


def lerp_rgb(c1, c2, t):
    return (int(lerp(c1[0], c2[0], t)),
            int(lerp(c1[1], c2[1], t)),
            int(lerp(c1[2], c2[2], t)))


def squircle_mask(size, n=4.5, padding=8):
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


def build_master():
    # Coordinates were authored at 512px in the preview. We render at 1024.
    # Scale every pixel constant by 2.
    S = SIZE / 512.0
    s = lambda v: int(round(v * S))

    bg = gradient_bg(SIZE, INDIGO_DEEP, PURPLE, SUNSET_PINK)
    canvas = squircled(bg)
    draw = ImageDraw.Draw(canvas)

    # ---- White doc, straight, centered ----
    doc_w, doc_h = s(280), s(320)
    doc_x = (SIZE - doc_w) // 2 - s(10)
    doc_y = s(90)

    # Drop shadow under doc
    sh = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.rounded_rectangle(
        [doc_x + s(6), doc_y + s(18), doc_x + doc_w + s(6), doc_y + doc_h + s(18)],
        radius=s(22), fill=(15, 23, 42, 130)
    )
    sh = sh.filter(ImageFilter.GaussianBlur(s(14)))
    canvas.alpha_composite(sh)

    # Doc body
    doc_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    dl = ImageDraw.Draw(doc_layer)
    dl.rounded_rectangle(
        [doc_x, doc_y, doc_x + doc_w, doc_y + doc_h],
        radius=s(22), fill=(255, 255, 255, 255)
    )
    fold = s(50)
    dl.polygon(
        [(doc_x + doc_w - fold, doc_y),
         (doc_x + doc_w,        doc_y + fold),
         (doc_x + doc_w - fold, doc_y + fold)],
        fill=(220, 230, 240, 255)
    )
    dl.polygon(
        [(doc_x + doc_w - fold, doc_y),
         (doc_x + doc_w + 1,    doc_y),
         (doc_x + doc_w + 1,    doc_y + fold)],
        fill=(0, 0, 0, 0)
    )

    line_color = (148, 163, 184, 255)
    accent = (236, 72, 100, 255)
    for i, frac in enumerate([0.85, 0.95, 0.7, 0.9, 0.55]):
        ly = doc_y + s(56) + i * s(40)
        lx1 = doc_x + s(30)
        lx2 = lx1 + int((doc_w - s(60)) * frac)
        col = accent if i == 0 else line_color
        dl.rounded_rectangle([lx1, ly, lx2, ly + s(12)], radius=s(6), fill=col)
    canvas.alpha_composite(doc_layer)

    # ---- Magnifier ----
    mx, my, mr = s(360), s(360), s(96)

    # Handle drop shadow
    handle_pts = [(mx + s(64), my + s(64)), (mx + s(150), my + s(150))]
    h_thick = s(28)
    hs = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    hsd = ImageDraw.Draw(hs)
    hsd.line(handle_pts, fill=(15, 23, 42, 130), width=h_thick + s(8))
    hs = hs.filter(ImageFilter.GaussianBlur(s(8)))
    canvas.alpha_composite(hs)
    # Handle
    draw.line(handle_pts, fill=SLATE_DARK + (255,), width=h_thick + s(4))
    draw.line(
        [(handle_pts[0][0] + s(4), handle_pts[0][1] - s(4)),
         (handle_pts[1][0] + s(4), handle_pts[1][1] - s(4))],
        fill=(244, 244, 245, 200), width=s(4)
    )

    # Glass ring shadow
    rs = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    rsd = ImageDraw.Draw(rs)
    rsd.ellipse(
        [mx - mr + s(2), my - mr + s(8), mx + mr + s(2), my + mr + s(8)],
        outline=(15, 23, 42, 130), width=s(20)
    )
    rs = rs.filter(ImageFilter.GaussianBlur(s(10)))
    canvas.alpha_composite(rs)

    # Glass interior tint
    gl = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gld = ImageDraw.Draw(gl)
    gld.ellipse(
        [mx - mr + s(18), my - mr + s(18), mx + mr - s(18), my + mr - s(18)],
        fill=(SKY[0], SKY[1], SKY[2], 100)
    )
    canvas.alpha_composite(gl)

    # Glass ring
    ring_outer = s(18)
    draw.ellipse([mx - mr, my - mr, mx + mr, my + mr],
                 outline=(244, 244, 245, 255), width=ring_outer)
    draw.ellipse(
        [mx - mr + ring_outer - s(2), my - mr + ring_outer - s(2),
         mx + mr - ring_outer + s(2), my + mr - ring_outer + s(2)],
        outline=SLATE_DARK + (255,), width=s(3)
    )

    # Glass highlight
    hl = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hl)
    hd.ellipse(
        [mx - mr + s(28), my - mr + s(22), mx + s(4), my + s(8)],
        fill=(255, 255, 255, 90)
    )
    canvas.alpha_composite(hl)

    # ---- Sparkles ----
    sparkle_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sl = ImageDraw.Draw(sparkle_layer)

    def sparkle(cx, cy, size, color=(255, 255, 255, 255)):
        sz = size
        pts = [
            (cx, cy - sz), (cx + sz * 0.32, cy - sz * 0.32),
            (cx + sz, cy), (cx + sz * 0.32, cy + sz * 0.32),
            (cx, cy + sz), (cx - sz * 0.32, cy + sz * 0.32),
            (cx - sz, cy), (cx - sz * 0.32, cy - sz * 0.32),
        ]
        sl.polygon(pts, fill=color)

    # Halo behind big sparkle
    halo = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    hd2 = ImageDraw.Draw(halo)
    hd2.ellipse([s(395), s(75), s(495), s(175)], fill=(255, 255, 255, 60))
    halo = halo.filter(ImageFilter.GaussianBlur(s(18)))
    canvas.alpha_composite(halo)

    sparkle(s(445), s(125), s(44), color=(255, 255, 255, 255))
    sparkle(s(80),  s(150), s(26), color=(255, 230, 240, 255))
    sparkle(s(110), s(380), s(22), color=(255, 240, 200, 255))
    sparkle(s(470), s(270), s(20), color=(255, 255, 255, 240))
    canvas.alpha_composite(sparkle_layer)

    return canvas


def main():
    print("Generating master 1024px icon…")
    img = build_master()
    out_png = HERE / "icon.png"
    img.save(out_png, "PNG")
    print(f"  wrote {out_png}")

    # iconset
    print("Generating iconset…")
    iconset_dir = HERE / "icon.iconset"
    iconset_dir.mkdir(exist_ok=True)
    sizes = [
        (16,  "icon_16x16.png"),
        (32,  "icon_16x16@2x.png"),
        (32,  "icon_32x32.png"),
        (64,  "icon_32x32@2x.png"),
        (128, "icon_128x128.png"),
        (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"),
        (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
    ]
    for sz, name in sizes:
        resized = img.resize((sz, sz), Image.LANCZOS)
        resized.save(iconset_dir / name, "PNG")
        print(f"  {name}")

    # icns
    print("Building icon.icns…")
    icns_path = HERE / "icon.icns"
    subprocess.run(
        ["iconutil", "-c", "icns", str(iconset_dir), "-o", str(icns_path)],
        check=True
    )
    print(f"  wrote {icns_path}")
    print("Done.")


if __name__ == "__main__":
    main()
