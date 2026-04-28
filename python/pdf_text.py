"""PDF text-extraction helper used in place of PyMuPDF.

Strategy: pypdfium2 is the primary engine (fast, BSD-licensed, ships the
PDFium binary). pdfplumber is a pure-Python fallback for the ~5% of PDFs
where pypdfium2 returns empty results — typically docs with CharProc-based
fonts or text rendered as outlines.

All public functions return coordinates in **PyMuPDF-style top-left origin**
(y increases downward) so existing orchestrate.py logic — which was written
against PyMuPDF — continues to work with no comparison changes.
"""
from __future__ import annotations

from pathlib import Path
from typing import List, Optional, Tuple

import pdfplumber
import pypdfium2 as pdfium


class PdfTextExtractor:
    """Lazy, dual-engine text extractor for one PDF document.

    Use as a context manager so both engines get closed cleanly:

        with PdfTextExtractor(pdf_path) as ext:
            for page_idx in range(ext.page_count):
                words = ext.get_words(page_idx)
                text = ext.get_text_in_rect(page_idx, [x0, y0, x1, y1])
    """

    def __init__(self, pdf_path: str | Path):
        self.pdf_path = str(pdf_path)
        self._pdfium = pdfium.PdfDocument(self.pdf_path)
        self._plumber = None  # opened lazily on first fallback / get_words

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

    # ---- accessors ----
    @property
    def page_count(self) -> int:
        return len(self._pdfium)

    def page_height(self, page_idx: int) -> float:
        """Page height in PDF points (used for y-axis flips)."""
        return float(self._pdfium[page_idx].get_size()[1])

    def page_width(self, page_idx: int) -> float:
        return float(self._pdfium[page_idx].get_size()[0])

    # ---- helpers ----
    def _plumber_doc(self):
        if self._plumber is None:
            self._plumber = pdfplumber.open(self.pdf_path)
        return self._plumber

    # ---- text extraction (top-left coords) ----
    def get_words(self, page_idx: int) -> List[dict]:
        """Return list of word dicts with top-left bboxes:
            {"text": str, "x0": float, "y0": float, "x1": float, "y1": float}

        pdfplumber is the primary engine here because it gives clean per-word
        bboxes natively — pypdfium2 only exposes per-character rects, which
        we'd have to group ourselves.
        """
        try:
            page = self._plumber_doc().pages[page_idx]
            words = page.extract_words(use_text_flow=True)
            # pdfplumber already returns top-left coords with x0/x1, top/bottom
            return [{
                "text": w.get("text", ""),
                "x0": float(w["x0"]),
                "y0": float(w["top"]),
                "x1": float(w["x1"]),
                "y1": float(w["bottom"]),
            } for w in words]
        except Exception:
            return []

    def get_full_page_text(self, page_idx: int) -> str:
        """All text on a page as a single string.

        pypdfium2 first; if it returns empty (or just whitespace), fall back
        to pdfplumber.
        """
        try:
            tp = self._pdfium[page_idx].get_textpage()
            txt = tp.get_text_range()
            tp.close()
            if txt and txt.strip():
                return txt
        except Exception:
            pass
        try:
            return self._plumber_doc().pages[page_idx].extract_text() or ""
        except Exception:
            return ""

    def get_text_in_rect(
        self, page_idx: int, rect_top_left: Tuple[float, float, float, float]
    ) -> str:
        """Extract text within a rect.

        Input rect is in **top-left origin** (matches PyMuPDF):
            (x0, y0_top, x1, y1_bottom)  with y0_top < y1_bottom

        pypdfium2 needs PDF-native bottom-left coords, so we flip y here.
        Falls back to pdfplumber's `crop` if pypdfium2 returns empty.
        """
        x0, y0_top, x1, y1_bot = rect_top_left
        h = self.page_height(page_idx)
        # Convert: pypdfium2 wants (left, bottom, right, top) in PDF coords
        bot = h - y1_bot
        top = h - y0_top
        try:
            tp = self._pdfium[page_idx].get_textpage()
            # pypdfium2's get_text_bounded signature varies by version; use
            # the kwargs form for portability.
            txt = tp.get_text_bounded(left=x0, bottom=bot, right=x1, top=top)
            tp.close()
            if txt and txt.strip():
                return txt
        except Exception:
            pass
        try:
            page = self._plumber_doc().pages[page_idx]
            cropped = page.crop((x0, y0_top, x1, y1_bot))
            return cropped.extract_text() or ""
        except Exception:
            return ""

    def close(self):
        try:
            self._pdfium.close()
        except Exception:
            pass
        if self._plumber is not None:
            try:
                self._plumber.close()
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
