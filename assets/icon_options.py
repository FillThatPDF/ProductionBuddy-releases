"""Generate 5 alternative icon designs for Production Buddy as 512px PNGs.
Drops them in assets/options/ so the user can preview and pick one.

Once a design is chosen, copy that script's body into build_icon.py to
generate the master 1024px + iconset + .icns.
"""
import math
import os
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).parent
OUT = HERE / "options"
OUT.mkdir(exist_ok=True)
SIZE = 512


# ---------- shared helpers ----------
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


def soft_shadow(canvas, draw_fn, blur=14, dy=10, alpha=110):
    """Apply a soft drop shadow under whatever draw_fn paints onto a temp."""
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw_fn(layer, ImageDraw.Draw(layer))
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw_fn(shadow, ImageDraw.Draw(shadow), shadow_mode=True, dy=dy, alpha=alpha)
    shadow = shadow.filter(ImageFilter.GaussianBlur(blur))
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(layer)


# Brand palette
TEAL   = (0x14, 0xb8, 0xa6)
SKY    = (0x38, 0xbd, 0xf8)
PURPLE = (0xc0, 0x84, 0xfc)
EMERALD = (0x10, 0xb9, 0x81)
ORANGE  = (0xfb, 0x92, 0x3c)
SLATE_DARK = (0x0f, 0x17, 0x2a)
SLATE_MID = (0x33, 0x41, 0x55)
INDIGO_DEEP = (0x1e, 0x1b, 0x4b)
SUNSET_PINK = (0xf4, 0x71, 0x73)
SUNSET_ORANGE = (0xfb, 0xbf, 0x24)


def find_font(candidates, size):
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


# ---------- Option A: Bold "PB" monogram on gradient ----------
def option_a_monogram():
    bg = gradient_bg(SIZE, TEAL, SKY, PURPLE)
    canvas = squircled(bg)
    draw = ImageDraw.Draw(canvas)

    # Subtle dot pattern overlay for texture
    overlay = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for y in range(0, SIZE, 22):
        for x in range(0, SIZE, 22):
            od.ellipse([x - 1, y - 1, x + 1, y + 1], fill=(255, 255, 255, 22))
    canvas.alpha_composite(overlay)

    # Big white "PB" — bold, centered
    font = find_font([
        "/System/Library/Fonts/Supplemental/Helvetica.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/HelveticaNeue.ttc",
    ], int(SIZE * 0.46))

    text = "PB"
    bbox = draw.textbbox((0, 0), text, font=font, stroke_width=0)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (SIZE - tw) // 2 - bbox[0]
    ty = (SIZE - th) // 2 - bbox[1] - 12

    # Soft shadow
    sh = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.text((tx + 4, ty + 8), text, font=font, fill=(15, 23, 42, 110))
    sh = sh.filter(ImageFilter.GaussianBlur(8))
    canvas.alpha_composite(sh)
    draw.text((tx, ty), text, font=font, fill=(255, 255, 255, 255))

    return canvas


# ---------- Option B: Friendly speech bubble with checkmark ----------
def option_b_speech_bubble():
    bg = gradient_bg(SIZE, TEAL, SKY, PURPLE)
    canvas = squircled(bg)
    draw = ImageDraw.Draw(canvas)

    # White rounded speech bubble
    bx, by = 92, 110
    bw, bh = 328, 240
    radius = 50
    # Drop shadow
    sh = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.rounded_rectangle([bx + 6, by + 14, bx + bw + 6, by + bh + 14],
                         radius=radius, fill=(15, 23, 42, 110))
    sh = sh.filter(ImageFilter.GaussianBlur(14))
    canvas.alpha_composite(sh)

    # Bubble body
    draw.rounded_rectangle([bx, by, bx + bw, by + bh],
                           radius=radius, fill=(255, 255, 255, 255))
    # Tail (triangle) bottom-left of bubble
    tail = [(bx + 70, by + bh - 4),
            (bx + 50, by + bh + 60),
            (bx + 130, by + bh - 4)]
    draw.polygon(tail, fill=(255, 255, 255, 255))

    # Checkmark in the bubble (emerald)
    cx, cy = bx + bw // 2, by + bh // 2 + 4
    pts = [(cx - 70, cy + 6),
           (cx - 22, cy + 50),
           (cx + 70, cy - 50)]
    draw.line([pts[0], pts[1]], fill=EMERALD + (255,), width=28, joint="curve")
    draw.line([pts[1], pts[2]], fill=EMERALD + (255,), width=28, joint="curve")
    for p in pts:
        draw.ellipse([p[0] - 14, p[1] - 14, p[0] + 14, p[1] + 14], fill=EMERALD + (255,))

    return canvas


# ---------- Option C: Magnifying glass over doc ----------
def option_c_magnifier():
    bg = gradient_bg(SIZE, INDIGO_DEEP, (0x4c, 0x1d, 0x95), (0xa8, 0x55, 0xf7))
    canvas = squircled(bg)
    draw = ImageDraw.Draw(canvas)

    # Doc behind, slightly tilted
    doc_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    dl = ImageDraw.Draw(doc_layer)
    dl.rounded_rectangle([90, 80, 350, 380], radius=18, fill=(255, 255, 255, 255))
    # Folded corner top-right
    dl.polygon([(310, 80), (350, 80), (350, 120), (310, 120)], fill=(0, 0, 0, 0))
    dl.polygon([(310, 80), (350, 120), (310, 120)], fill=(220, 230, 240, 255))
    # Lines
    line_color = (148, 163, 184, 255)
    for i, frac in enumerate([0.85, 0.95, 0.7, 0.9, 0.55]):
        ly = 130 + i * 38
        lx2 = 120 + int(200 * frac)
        dl.rounded_rectangle([120, ly, lx2, ly + 12], radius=6, fill=line_color)
    canvas.alpha_composite(doc_layer.rotate(-6, resample=Image.BICUBIC, center=(220, 230)))

    # Magnifier — circle + handle
    mx, my, mr = 340, 320, 110
    # Handle
    h_thick = 36
    handle_pts = [(mx + 70, my + 70), (mx + 165, my + 165)]
    draw.line(handle_pts, fill=(15, 23, 42, 255), width=h_thick + 8)
    draw.line(handle_pts, fill=(244, 244, 245, 255), width=h_thick - 2)
    # Glass ring
    ring_w = 22
    draw.ellipse([mx - mr, my - mr, mx + mr, my + mr],
                 outline=(244, 244, 245, 255), width=ring_w + 6)
    draw.ellipse([mx - mr + 4, my - mr + 4, mx + mr - 4, my + mr - 4],
                 outline=(15, 23, 42, 255), width=4)
    # Glass interior tint
    glass = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glass)
    gd.ellipse([mx - mr + ring_w, my - mr + ring_w, mx + mr - ring_w, my + mr - ring_w],
               fill=(SKY[0], SKY[1], SKY[2], 80))
    canvas.alpha_composite(glass)
    # Highlight on glass
    hl = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hl)
    hd.ellipse([mx - mr + 24, my - mr + 18, mx + mr // 2, my], fill=(255, 255, 255, 70))
    canvas.alpha_composite(hl)

    return canvas


# ---------- Option D: Red pencil applying edits to a doc ----------
def option_d_pencil_doc():
    bg = gradient_bg(SIZE, TEAL, EMERALD, SKY)
    canvas = squircled(bg)
    draw = ImageDraw.Draw(canvas)

    # Doc
    dl_img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    dl = ImageDraw.Draw(dl_img)
    doc_x, doc_y = 92, 96
    doc_w, doc_h = 280, 320
    dl.rounded_rectangle([doc_x, doc_y, doc_x + doc_w, doc_y + doc_h],
                         radius=20, fill=(255, 255, 255, 255))
    # Folded corner
    fold = 56
    dl.polygon([(doc_x + doc_w - fold, doc_y),
                (doc_x + doc_w, doc_y + fold),
                (doc_x + doc_w - fold, doc_y + fold)],
               fill=(220, 230, 240, 255))
    # Lines including a struck-through / red-edit line
    for i, frac in enumerate([0.85, 0.92, 0.7, 0.9, 0.6]):
        ly = doc_y + 56 + i * 44
        lx1 = doc_x + 32
        lx2 = lx1 + int((doc_w - 64) * frac)
        col = (148, 163, 184, 255)
        if i == 1:
            col = (236, 72, 100, 255)  # red highlight
        dl.rounded_rectangle([lx1, ly, lx2, ly + 12], radius=6, fill=col)
        if i == 1:
            # Red strikethrough line
            dl.line([(lx1, ly + 6), (lx2, ly + 6)], fill=(220, 38, 38, 255), width=4)
    canvas.alpha_composite(dl_img)

    # Pencil — diagonal across, red wood + dark tip
    p_color = (220, 38, 38, 255)
    p_dark = (15, 23, 42, 255)
    p_light = (252, 165, 165, 255)
    # Pencil body — long rectangle rotated
    pen = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    pen_d = ImageDraw.Draw(pen)
    bx, by = 80, 270
    bx2, by2 = 410, 270
    p_thick = 36
    pen_d.line([(bx, by), (bx2, by2)], fill=p_color, width=p_thick)
    # Eraser cap at left
    pen_d.rounded_rectangle([bx - 28, by - p_thick // 2 - 4, bx + 32, by + p_thick // 2 + 4],
                            radius=6, fill=(248, 250, 252, 255))
    pen_d.rectangle([bx + 30, by - p_thick // 2 - 4, bx + 46, by + p_thick // 2 + 4],
                    fill=(115, 130, 145, 255))
    # Tip cone at right
    pen_d.polygon([(bx2 - 30, by2 - p_thick // 2 - 6),
                   (bx2 + 50, by2),
                   (bx2 - 30, by2 + p_thick // 2 + 6)],
                  fill=(252, 211, 77, 255))
    pen_d.polygon([(bx2 + 18, by2 - 14),
                   (bx2 + 50, by2),
                   (bx2 + 18, by2 + 14)],
                  fill=p_dark)
    rotated = pen.rotate(-22, resample=Image.BICUBIC, center=(SIZE / 2, SIZE / 2))
    # Drop shadow
    sh = rotated.copy()
    sh_alpha = sh.split()[3]
    sh_solid = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sh_solid.putalpha(sh_alpha)
    sh_d = Image.new("RGBA", (SIZE, SIZE), (15, 23, 42, 110))
    sh_d.putalpha(sh_alpha)
    sh_d = sh_d.filter(ImageFilter.GaussianBlur(10))
    offset_sh = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    offset_sh.paste(sh_d, (4, 14))
    canvas.alpha_composite(offset_sh)
    canvas.alpha_composite(rotated)

    return canvas


# ---------- Option E: Sparkle / AI assistant doc ----------
def option_e_sparkle():
    bg = gradient_bg(SIZE, INDIGO_DEEP, PURPLE, SUNSET_PINK)
    canvas = squircled(bg)
    draw = ImageDraw.Draw(canvas)

    # Doc, off-center to the lower-left
    dl_img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    dl = ImageDraw.Draw(dl_img)
    doc_x, doc_y = 78, 130
    doc_w, doc_h = 280, 300
    dl.rounded_rectangle([doc_x, doc_y, doc_x + doc_w, doc_y + doc_h],
                         radius=20, fill=(255, 255, 255, 255))
    # Folded corner
    fold = 50
    dl.polygon([(doc_x + doc_w - fold, doc_y),
                (doc_x + doc_w, doc_y + fold),
                (doc_x + doc_w - fold, doc_y + fold)],
               fill=(220, 230, 240, 255))
    # Lines
    for i, frac in enumerate([0.85, 0.95, 0.6, 0.9]):
        ly = doc_y + 52 + i * 40
        lx2 = doc_x + 28 + int((doc_w - 56) * frac)
        dl.rounded_rectangle([doc_x + 28, ly, lx2, ly + 12], radius=6, fill=(148, 163, 184, 255))
    canvas.alpha_composite(dl_img)

    # 4-point sparkle ("AI shimmer") top-right
    def sparkle(cx, cy, size, color=(255, 255, 255, 255)):
        # 4-pointed star — diamond + thin cross
        s = size
        pts = [
            (cx, cy - s), (cx + s * 0.32, cy - s * 0.32),
            (cx + s, cy), (cx + s * 0.32, cy + s * 0.32),
            (cx, cy + s), (cx - s * 0.32, cy + s * 0.32),
            (cx - s, cy), (cx - s * 0.32, cy - s * 0.32),
        ]
        draw.polygon(pts, fill=color)

    # Big sparkle
    sparkle(390, 150, 60, color=(255, 255, 255, 255))
    # Smaller sparkles around it
    sparkle(440, 220, 28, color=(255, 230, 180, 255))
    sparkle(340, 90, 22, color=(255, 230, 240, 255))
    sparkle(420, 320, 18, color=(255, 255, 255, 240))

    # Glow halo behind the big sparkle
    halo = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    hd.ellipse([320, 80, 460, 220], fill=(255, 255, 255, 60))
    halo = halo.filter(ImageFilter.GaussianBlur(20))
    # Composite UNDER the sparkles by re-drawing sparkles after halo
    blended = canvas.copy()
    blended.alpha_composite(halo)
    sparkle_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sd2 = ImageDraw.Draw(sparkle_layer)
    def s2(cx, cy, size, color=(255, 255, 255, 255)):
        s = size
        pts = [
            (cx, cy - s), (cx + s * 0.32, cy - s * 0.32),
            (cx + s, cy), (cx + s * 0.32, cy + s * 0.32),
            (cx, cy + s), (cx - s * 0.32, cy + s * 0.32),
            (cx - s, cy), (cx - s * 0.32, cy - s * 0.32),
        ]
        sd2.polygon(pts, fill=color)
    s2(390, 150, 60)
    s2(440, 220, 28, color=(255, 230, 180, 255))
    s2(340, 90, 22, color=(255, 230, 240, 255))
    s2(420, 320, 18, color=(255, 255, 255, 240))
    blended.alpha_composite(sparkle_layer)
    return blended


# ---------- main ----------
def main():
    options = [
        ("A_monogram_PB", option_a_monogram),
        ("B_speech_bubble_check", option_b_speech_bubble),
        ("C_magnifier_doc", option_c_magnifier),
        ("D_pencil_markup_doc", option_d_pencil_doc),
        ("E_sparkle_AI_doc", option_e_sparkle),
    ]
    for name, fn in options:
        print(f"Building {name}…")
        img = fn()
        path = OUT / f"{name}.png"
        img.save(path, "PNG")
        print(f"  → {path}")

    # Build a contact-sheet 3x2 for easy preview
    print("Building contact_sheet.png…")
    sheet_w, sheet_h = SIZE * 3 + 80, SIZE * 2 + 60
    sheet = Image.new("RGBA", (sheet_w, sheet_h), (24, 24, 28, 255))
    positions = [
        (20, 20), (SIZE + 40, 20), (SIZE * 2 + 60, 20),
        (20, SIZE + 40), (SIZE + 40, SIZE + 40),
    ]
    for (name, _), pos in zip(options, positions):
        img = Image.open(OUT / f"{name}.png").convert("RGBA")
        sheet.paste(img, pos, img)
        # Label
        draw = ImageDraw.Draw(sheet)
        font = find_font([
            "/System/Library/Fonts/Supplemental/Helvetica.ttc",
            "/System/Library/Fonts/Helvetica.ttc",
        ], 22)
        draw.text((pos[0] + 10, pos[1] + SIZE + 4), name, font=font, fill=(220, 230, 240, 255))
    sheet.save(OUT / "contact_sheet.png", "PNG")
    print(f"  → {OUT / 'contact_sheet.png'}")


if __name__ == "__main__":
    main()
