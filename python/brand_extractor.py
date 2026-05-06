"""Brand-guide extractor — pulls swatch + font lists from a brand-guide PDF.

The output schema matches the `brand` field in qa_config.json that the JSX
brand-enforcement pass consumes:

    {
        "name":     "DTE",
        "swatches": ["DTE Blue", "PANTONE 286 C", "C=100 M=65 Y=0 K=30", ...],
        "fonts":    ["GoodPro-Narr", "Helvetica", ...],
        "sourcePath": "/path/to/DTE_Brand_Guide.pdf",
        "savedAt":  "2026-05-06T10:00:00Z",
        # Optional metadata for the Settings UI:
        "swatchSamples": [{"label": "...", "rgb": [r,g,b], "cmyk": [c,m,y,k]}, ...],
    }

Brand swatches stored as plain strings is a deliberate choice. The
JSX QA pass compares against the doc's actual swatch *names*, which the
designer maintains in InDesign — names line up across files in a single
brand system, so a name match is the right grain. We also dump RGB/CMYK
samples for the Settings UI to render as color chips.
"""
from __future__ import annotations

from pathlib import Path
import re
import datetime
from collections import Counter
from typing import List, Dict, Any, Tuple

import fitz  # PyMuPDF


# Filter thresholds for the color extraction step.
_NEAR_WHITE_THRESHOLD = 240   # any RGB component above this → near-white, skip
_NEAR_BLACK_THRESHOLD = 25    # all components below this → near-black, skip
_GREY_TOLERANCE = 8           # max(RGB) - min(RGB) below this → greyscale, skip
_DEDUPE_TOLERANCE = 6         # RGB distance under which two colors merge


def extract_brand_from_pdf(pdf_path: str, suggested_name: str = None) -> Dict[str, Any]:
    """Open a brand-guide PDF and pull out the brand swatches + fonts.

    Returns a dict ready to be written to <userData>/brand-guides/<name>.json
    after main.js attaches a final `name` (the user can edit the suggested
    name before saving).
    """
    pdf_path = str(pdf_path)
    doc = fitz.open(pdf_path)
    try:
        swatch_samples = _extract_swatches(doc)
        fonts = _extract_fonts(doc)
        detected_name = _detect_company_name(doc, pdf_path)
    finally:
        doc.close()

    # Build the swatches name list. Each sample becomes a CMYK label like
    # "C=100 M=65 Y=0 K=30" — that's what designers typically name brand
    # swatches in InDesign. The doc's own swatch names will match these
    # at QA time when the designer maintained the brand system properly.
    swatch_names = [_cmyk_label(s["cmyk"]) for s in swatch_samples]

    return {
        "name": suggested_name or detected_name,
        "swatches": swatch_names,
        "fonts": fonts,
        "sourcePath": pdf_path,
        "savedAt": datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "swatchSamples": swatch_samples,
        "detectedName": detected_name,
    }


def _extract_swatches(doc: "fitz.Document") -> List[Dict[str, Any]]:
    """Walk every page's vector drawings, collect unique fill colors.

    Brand-guide PDFs typically render the palette as a row of colored
    rectangles. Each rectangle is a drawing op with a `fill` color. We
    collect those, dedupe within a small RGB tolerance, and skip
    near-white / near-black / pure-grey colors that are almost certainly
    page background or body text rather than brand colors.
    """
    bucket: List[Tuple[int, int, int]] = []
    use_count: Counter = Counter()

    for page_idx in range(doc.page_count):
        page = doc[page_idx]
        try:
            drawings = page.get_drawings()
        except Exception:
            continue
        for d in drawings:
            fill = d.get("fill")
            if not fill:
                continue
            # PyMuPDF returns fill as a tuple of 0..1 floats (RGB or grey).
            rgb = _normalize_to_rgb_int(fill)
            if rgb is None or _looks_neutral(rgb):
                continue
            existing = _find_close_color(bucket, rgb)
            if existing is None:
                bucket.append(rgb)
                use_count[rgb] = 1
            else:
                use_count[existing] += 1

    # Sort by usage (more uses ≈ more brand-relevant), cap at 24
    sorted_colors = sorted(bucket, key=lambda c: -use_count[c])[:24]
    samples = []
    for rgb in sorted_colors:
        cmyk = _rgb_to_cmyk(rgb)
        samples.append({
            "rgb": list(rgb),
            "cmyk": cmyk,
            "label": _cmyk_label(cmyk),
            "useCount": use_count[rgb],
        })
    return samples


def _extract_fonts(doc: "fitz.Document") -> List[str]:
    """List every font family used in the brand-guide PDF.

    PyMuPDF's `get_fonts(page)` returns one tuple per font referenced on
    the page; the basefont (index 3) is usually `MyriadPro-Bold` /
    `GoodPro-Narr` style. We collapse weight/style suffixes so the brand
    list ends up as families ("GoodPro" rather than ["GoodPro-Narr",
    "GoodPro-NarrBold", "GoodPro-NarrLight"]). The InDesign QA pass
    matches on family-or-full-name, so either grain works.
    """
    families: set = set()
    for page_idx in range(doc.page_count):
        try:
            fonts = doc.get_page_fonts(page_idx)
        except Exception:
            continue
        for f in fonts:
            basefont = f[3] if len(f) > 3 else ""
            if not basefont:
                continue
            # Strip a leading 6-char subset prefix like "ABCDEF+FontName"
            if "+" in basefont:
                basefont = basefont.split("+", 1)[1]
            family = _family_from_basefont(basefont)
            if family:
                families.add(family)
    return sorted(families)


def _detect_company_name(doc: "fitz.Document", pdf_path: str) -> str:
    """Best-guess company name for the Save-as field.

    Order of preference:
      1. PDF metadata title (often filled in by designers)
      2. First non-empty short line of page 1 text — likely the cover title
      3. Filename base, sanitized
    """
    try:
        meta = doc.metadata or {}
        title = (meta.get("title") or "").strip()
        if title and 3 <= len(title) <= 60 and not title.lower().startswith("untitled"):
            # Trim trailing "Brand Guide" / "Style Guide" suffix to leave
            # just the company name
            return _strip_brand_guide_suffix(title)
    except Exception:
        pass
    try:
        if doc.page_count > 0:
            text = doc[0].get_text("text") or ""
            for raw in text.split("\n"):
                line = raw.strip()
                if 3 <= len(line) <= 50 and any(c.isalpha() for c in line):
                    return _strip_brand_guide_suffix(line)
    except Exception:
        pass
    stem = Path(pdf_path).stem
    return _strip_brand_guide_suffix(re.sub(r"[_-]+", " ", stem)).strip() or "Brand Guide"


# ---- Helpers ----------------------------------------------------------

def _normalize_to_rgb_int(fill) -> Tuple[int, int, int]:
    """PyMuPDF fill colors come as either a 3-tuple (RGB 0..1) or a single
    grey float. Normalize to (R, G, B) ints in 0..255.
    """
    if fill is None:
        return None
    if isinstance(fill, (int, float)):
        v = int(round(float(fill) * 255))
        return (v, v, v)
    if isinstance(fill, (tuple, list)):
        if len(fill) == 1:
            v = int(round(float(fill[0]) * 255))
            return (v, v, v)
        if len(fill) >= 3:
            r = int(round(float(fill[0]) * 255))
            g = int(round(float(fill[1]) * 255))
            b = int(round(float(fill[2]) * 255))
            return (max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)))
    return None


def _looks_neutral(rgb: Tuple[int, int, int]) -> bool:
    """True if the color is near-white, near-black, or near-grey — not a brand color."""
    r, g, b = rgb
    if r > _NEAR_WHITE_THRESHOLD and g > _NEAR_WHITE_THRESHOLD and b > _NEAR_WHITE_THRESHOLD:
        return True
    if r < _NEAR_BLACK_THRESHOLD and g < _NEAR_BLACK_THRESHOLD and b < _NEAR_BLACK_THRESHOLD:
        return True
    if (max(rgb) - min(rgb)) < _GREY_TOLERANCE:
        return True
    return False


def _find_close_color(bucket: List[Tuple[int, int, int]], target: Tuple[int, int, int]):
    for c in bucket:
        if (abs(c[0] - target[0]) <= _DEDUPE_TOLERANCE
                and abs(c[1] - target[1]) <= _DEDUPE_TOLERANCE
                and abs(c[2] - target[2]) <= _DEDUPE_TOLERANCE):
            return c
    return None


def _rgb_to_cmyk(rgb: Tuple[int, int, int]) -> List[int]:
    """Approximate RGB → CMYK using the standard formula.

    Print houses generally have a profile-aware conversion that gives
    different numbers, so this is a *best-fit* used only for naming and
    UI display. The brand check matches by swatch *name*, not value, so
    the conversion accuracy here doesn't affect QA results.
    """
    r, g, b = rgb
    if r == 0 and g == 0 and b == 0:
        return [0, 0, 0, 100]
    rf, gf, bf = r / 255.0, g / 255.0, b / 255.0
    k = 1 - max(rf, gf, bf)
    if k < 1:
        c = (1 - rf - k) / (1 - k)
        m = (1 - gf - k) / (1 - k)
        y = (1 - bf - k) / (1 - k)
    else:
        c = m = y = 0
    return [int(round(c * 100)), int(round(m * 100)),
            int(round(y * 100)), int(round(k * 100))]


def _cmyk_label(cmyk: List[int]) -> str:
    return "C={} M={} Y={} K={}".format(*cmyk)


def _family_from_basefont(basefont: str) -> str:
    """Reduce 'GoodPro-NarrBoldItalic' to 'GoodPro'.

    Heuristic: strip the first hyphen-style suffix or the first
    Pascal-case break, whichever comes first.
    """
    name = basefont.replace(",", "-").strip()
    # Strip after first "-" (most foundries use `Family-Style`)
    if "-" in name:
        name = name.split("-", 1)[0]
    return name


_BRAND_GUIDE_SUFFIX_RE = re.compile(
    r"\s*[-–—:]?\s*(brand|style|identity|design)\s*(guide|guidelines?|standards?|manual|book)\s*$",
    re.I,
)


def _strip_brand_guide_suffix(s: str) -> str:
    return _BRAND_GUIDE_SUFFIX_RE.sub("", s).strip()
