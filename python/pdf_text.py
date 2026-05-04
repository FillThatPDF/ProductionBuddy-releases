"""PDF text-extraction helper backed by PyMuPDF (1.0.8 engine swap).

PyMuPDF is the sole engine in 1.0.8: word-level bboxes come with block/
line indices for free, get_text("dict") gives a structured layout tree,
and `page.annots()` exposes annotations natively. All public methods
return coordinates in **PyMuPDF-native top-left origin** so callers
written against the 1.0.7 API (pypdfium2 + pdfplumber + pikepdf) work
unchanged.

LICENSE: PyMuPDF is AGPL-3.0. Internal A/B use against 1.0.7 is fine;
redistributing a compiled DMG with PyMuPDF bundled requires either a
commercial license from Artifex or open-sourcing the host application.
"""
from __future__ import annotations

from pathlib import Path
from typing import List, Optional, Tuple

import fitz  # PyMuPDF


def _assign_line_ids(words: List[dict], baseline_tol: float = 2.0) -> None:
    """Mutate `words` in place, adding a page-local `line_id` to each.

    PyMuPDF's get_text("words") already supplies block/line indices, so
    this helper is mainly here for callers that build word lists by hand
    (legacy fallback path in orchestrate._line_text_around). Anchored to
    the first y0 of each line so a long line of slightly drifting y0s
    can't gradually slip into the next visual line.
    """
    if not words:
        return
    order = sorted(range(len(words)), key=lambda i: (words[i]["y0"], words[i]["x0"]))
    current_id = -1
    anchor_y = None
    for i in order:
        y0 = words[i]["y0"]
        if anchor_y is None or y0 - anchor_y > baseline_tol:
            current_id += 1
            anchor_y = y0
        words[i]["line_id"] = current_id


class PdfTextExtractor:
    """Word/text/rect extraction over one PDF document via PyMuPDF.

    Use as a context manager so the underlying handle closes cleanly:

        with PdfTextExtractor(pdf_path) as ext:
            for page_idx in range(ext.page_count):
                words = ext.get_words(page_idx)
                text = ext.get_text_in_rect(page_idx, [x0, y0, x1, y1])
    """

    def __init__(self, pdf_path: str | Path):
        self.pdf_path = str(pdf_path)
        self._doc = fitz.open(self.pdf_path)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

    # ---- accessors ----
    @property
    def page_count(self) -> int:
        return int(self._doc.page_count)

    def page_height(self, page_idx: int) -> float:
        return float(self._doc[page_idx].rect.height)

    def page_width(self, page_idx: int) -> float:
        return float(self._doc[page_idx].rect.width)

    # ---- text extraction (top-left coords) ----
    def get_words(self, page_idx: int, split_punctuation: bool = False) -> List[dict]:
        """Return word dicts with top-left bboxes:
            {"text", "x0", "y0", "x1", "y1", "line_id"}

        `line_id` is a page-local integer (0-indexed top to bottom)
        derived directly from PyMuPDF's (block_no, line_no) tuple — two
        words share a line_id iff PyMuPDF placed them in the same line
        of the same block. Read out of the PDF's text content stream
        rather than guessed from glyph y-positions, so adjacent table
        rows / columns separate cleanly without the y-baseline heuristics
        the 1.0.7 stack needed.

        Two extraction modes (use both — they answer different questions):

        - split_punctuation=False (default): "High-bay" stays one token,
          "program." stays one token. Use for `line_text` reconstruction
          so find strings match InDesign's character sequence exactly.

        - split_punctuation=True: hyphens become word delimiters.
          "High-bay" → ["High", "-", "bay"], but "program.", "$1,500"
          stay cohesive. Sub-tokens get bboxes estimated proportional to
          their char count across the parent word's x-range — accurate
          enough for the QuadPoint overlap check downstream.
        """
        try:
            page = self._doc[page_idx]
            # Each entry: (x0, y0, x1, y1, word, block_no, line_no, word_no)
            raw = page.get_text("words")
        except Exception:
            return []

        # Stable read order — PyMuPDF returns this already, but be
        # defensive against future version reordering.
        raw = sorted(raw, key=lambda r: (r[5], r[6], r[7]))

        # Map (block_no, line_no) → sequential page-local int. First
        # encounter in read order wins, matching PyMuPDF's natural
        # top-to-bottom traversal.
        line_keys: dict = {}
        for r in raw:
            key = (r[5], r[6])
            if key not in line_keys:
                line_keys[key] = len(line_keys)

        out: List[dict] = []
        for x0, y0, x1, y1, text, block_no, line_no, word_no in raw:
            line_id = line_keys[(block_no, line_no)]
            if split_punctuation and "-" in text and len(text) > 1:
                pieces: List[str] = []
                buf = ""
                for ch in text:
                    if ch == "-":
                        if buf:
                            pieces.append(buf); buf = ""
                        pieces.append("-")
                    else:
                        buf += ch
                if buf:
                    pieces.append(buf)
                if len(pieces) <= 1:
                    out.append({"text": text, "x0": float(x0), "y0": float(y0),
                                "x1": float(x1), "y1": float(y1), "line_id": line_id})
                    continue
                total_chars = sum(len(p) for p in pieces) or 1
                width = float(x1) - float(x0)
                cursor = float(x0)
                for p in pieces:
                    if not p:
                        continue
                    seg_w = width * len(p) / total_chars
                    out.append({
                        "text": p,
                        "x0": cursor,
                        "y0": float(y0),
                        "x1": cursor + seg_w,
                        "y1": float(y1),
                        "line_id": line_id,
                    })
                    cursor += seg_w
            else:
                out.append({"text": text, "x0": float(x0), "y0": float(y0),
                            "x1": float(x1), "y1": float(y1), "line_id": line_id})
        return out

    def get_full_page_text(self, page_idx: int) -> str:
        """All text on a page as a single string (top-to-bottom read order)."""
        try:
            return self._doc[page_idx].get_text("text") or ""
        except Exception:
            return ""

    def get_text_in_rect(
        self, page_idx: int, rect_top_left: Tuple[float, float, float, float]
    ) -> str:
        """Extract text within a rect (top-left origin, y increases downward)."""
        try:
            x0, y0, x1, y1 = rect_top_left
            page = self._doc[page_idx]
            clip = fitz.Rect(float(x0), float(y0), float(x1), float(y1))
            return page.get_text("text", clip=clip) or ""
        except Exception:
            return ""

    def get_chars_in_rect(
        self, page_idx: int, rect_top_left: Tuple[float, float, float, float]
    ) -> str:
        """Char-level extraction: returns chars whose bbox center sits
        inside `rect`. Last-resort fallback for `extract_annotations`
        when both word-overlap and `get_text_in_rect` come back empty.

        Why this fallback exists: some fonts encode end-of-sentence
        punctuation (`.`, `,`) with a zero-width text bbox — the glyph
        renders visibly via PostScript drawing offsets but PyMuPDF's
        word/clip APIs treat it as having no width, so a strike whose
        QuadPoint covers the visible ink misses the word AND clips
        outside the period's bbox. Walking `get_text("rawdict")` chars
        and using the bbox center (or x0 for zero-width chars) finds
        them anyway.
        """
        try:
            x0, y0, x1, y1 = rect_top_left
            page = self._doc[page_idx]
            d = page.get_text("rawdict")
        except Exception:
            return ""
        # 0.5pt tolerance on each side absorbs the float noise between an
        # annotation's QuadPoint and the underlying glyph bbox — both
        # store positions independently and can disagree by ~1e-4 pt.
        # Half a point is well under any glyph width, so we don't pick
        # up neighboring chars by mistake.
        tol = 0.5
        hits = []
        for block in d.get("blocks", []):
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    for ch in span.get("chars", []):
                        bbox = ch.get("bbox") or (0, 0, 0, 0)
                        if len(bbox) < 4:
                            continue
                        bx0, by0, bx1, by1 = bbox
                        # Zero-width glyphs collapse x0==x1; use x0 as
                        # the position anchor in that case rather than
                        # the (degenerate) midpoint.
                        cx = (bx0 + bx1) / 2 if bx1 > bx0 else bx0
                        cy = (by0 + by1) / 2 if by1 > by0 else by0
                        if (x0 - tol) <= cx <= (x1 + tol) and (y0 - tol) <= cy <= (y1 + tol):
                            hits.append((cy, cx, ch.get("c", "")))
        hits.sort(key=lambda c: (round(c[0]), c[1]))
        return "".join(c[2] for c in hits)

    def close(self):
        try:
            self._doc.close()
        except Exception:
            pass


def quick_pdf_info(pdf_path: str | Path) -> dict:
    """Lightweight metadata fetch — used by the reference-file inventory.
    Returns {"page_count": int, "first_page_preview": str} or {}.
    """
    try:
        with PdfTextExtractor(pdf_path) as ext:
            preview = ""
            if ext.page_count > 0:
                preview = ext.get_full_page_text(0)[:300].replace("\n", " ").strip()
            return {"page_count": ext.page_count, "first_page_preview": preview}
    except Exception:
        return {}


def quick_image_dims(image_path: str | Path) -> Optional[Tuple[int, int]]:
    """Return (width, height) of a raster image. Pillow is the engine."""
    try:
        from PIL import Image
        with Image.open(str(image_path)) as im:
            return (im.width, im.height)
    except Exception:
        return None
