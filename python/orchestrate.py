#!/usr/bin/env python3
"""Main orchestrator for InDesignEditor v0.2.

Pipeline:
  1. Extract annotations from marked-up PDF (PyMuPDF)
  2. Inspect .indd structure via ExtendScript → JSON
  3. Send annotations + inspection to Claude API → structured edit list
  4. Generate apply_edits_v2.jsx with paths + edits.json reference
  5. Run via osascript → InDesign
  6. Run Python-side QA checks (hyperlinks reachability, spellcheck)
  7. Merge findings into findings.json

Reads JSON payload from argv[1]: { pdfPath, inddPath, outputDir }.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path


DEFAULT_CACHE_RETENTION = 10  # default — overridable via settings.cacheRetention


def get_work_dir(output_dir, indd_path, cache_retention=DEFAULT_CACHE_RETENTION):
    """Return a per-run scratch dir under ~/Library/Caches/indesign-editor/.

    Intermediate artifacts (logs, generated JSX, JSON dumps, findings) live
    here so the user's job folder stays clean — only the .indd and .pdf
    deliverables end up in output_dir. The dir name embeds the source
    basename + a timestamp so consecutive runs don't collide and old runs
    are easy to spot for debugging.

    Also prunes older runs in the cache root, keeping the most recent
    `cache_retention` entries.
    """
    cache_root = Path.home() / "Library" / "Caches" / "indesign-editor"
    cache_root.mkdir(parents=True, exist_ok=True)
    prune_old_runs(cache_root, max(1, int(cache_retention or DEFAULT_CACHE_RETENTION)))
    stamp = time.strftime("%Y%m%d-%H%M%S")
    safe_base = re.sub(r"[^\w.-]+", "_", Path(indd_path).stem)[:60]
    work = cache_root / f"{stamp}_{safe_base}"
    work.mkdir(parents=True, exist_ok=True)
    return work


def prune_old_runs(cache_root, keep):
    """Keep the `keep` most-recent run dirs in cache_root; delete the rest.

    Sorts subdirs by mtime descending. We use mtime (not name) so manual
    folder renames don't mess up the order.
    """
    try:
        runs = [p for p in cache_root.iterdir() if p.is_dir()]
        runs.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        for old in runs[keep:]:
            try:
                shutil.rmtree(old)
            except Exception:
                pass
    except Exception:
        pass

HERE = Path(__file__).parent
JSX_DIR = HERE.parent / "jsx"

# Engine selection: detected per-run from the source file extension.
# .indd → InDesignEngine, .ai → IllustratorEngine. The engine supplies the
# AppleScript app name + JSX template paths.
sys.path.insert(0, str(HERE))
from engines import get_engine  # noqa: E402


class _StepTimer:
    """Auto-tracks per-step timings by sniffing the standard "step N:" log
    lines. Each new "step ..." line closes out the previous step. Output:
      - inline `← step N: <label> done in X.YYs` line after each step
      - a sorted-by-duration summary at the end of the run
      - a JSON file at `<work_dir>/timings.json`

    Negligible runtime overhead (~1µs per log call), always on.
    """
    _STEP_RE = re.compile(r"^\[orchestrate\] (step [\d.a-z]+:.*?)…?\s*$",
                          re.IGNORECASE)

    def __init__(self):
        self._t_run_start = time.perf_counter()
        self._t_step_start = None
        self._step_label = None
        self.steps = []  # [{label, elapsed_s}]

    def maybe_mark(self, msg):
        m = self._STEP_RE.match(msg)
        if not m:
            return None
        return self._begin(m.group(1).strip())

    def _begin(self, label):
        closeout = self._close_current()
        self._step_label = label
        self._t_step_start = time.perf_counter()
        return closeout  # log line to emit for the just-closed prev step

    def _close_current(self):
        if self._step_label is None:
            return None
        elapsed = time.perf_counter() - self._t_step_start
        self.steps.append({"label": self._step_label, "elapsed_s": round(elapsed, 3)})
        line = f"[orchestrate]   ← {self._step_label} done in {elapsed:.2f}s"
        self._step_label = None
        self._t_step_start = None
        return line

    def finalize(self, work_dir=None):
        # Close the last step (if a step is still open)
        closeout = self._close_current()
        if closeout:
            print(closeout, flush=True)
            _tee(closeout)

        total = time.perf_counter() - self._t_run_start
        sorted_steps = sorted(self.steps, key=lambda s: -s["elapsed_s"])
        header = f"[orchestrate] === TIMING SUMMARY === total: {total:.2f}s"
        print(header, flush=True); _tee(header)
        for s in sorted_steps:
            pct = (100 * s["elapsed_s"] / total) if total > 0 else 0
            line = f"[orchestrate]   {s['elapsed_s']:>7.2f}s ({pct:>5.1f}%)  {s['label']}"
            print(line, flush=True); _tee(line)

        if work_dir is not None:
            try:
                Path(work_dir).mkdir(parents=True, exist_ok=True)
                (Path(work_dir) / "timings.json").write_text(json.dumps({
                    "total_s": round(total, 3),
                    "steps": self.steps,
                }, indent=2))
            except Exception:
                pass


_timer = _StepTimer()
# Captured by _emit_work_dir() so the timing finalizer knows where to write
# timings.json. Each main_* function calls _emit_work_dir() exactly once.
_LAST_WORK_DIR = None


def _emit_work_dir(work_dir):
    """Emit the stdout marker main.js parses, AND capture for the timer."""
    global _LAST_WORK_DIR
    _LAST_WORK_DIR = str(work_dir)
    print(f"[work_dir] {work_dir}", flush=True)


# Tee log lines to a fixed file so external observers (debug terminals,
# `tail -f`, the timing-investigation Monitor) can watch a run in real time.
# Truncated at the start of each run, written in append mode after that.
_TEE_PATH = "/tmp/pb_orchestrate.log"
try:
    Path(_TEE_PATH).write_text(
        f"--- pb run started {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n"
    )
except Exception:
    pass


def _tee(line):
    try:
        with open(_TEE_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def log(msg):
    msg_str = str(msg)
    # Mark step boundaries automatically. Emits a "← prev step done in Xs"
    # line BEFORE the new "step N:" line so step transitions are obvious.
    closeout = _timer.maybe_mark(msg_str)
    if closeout:
        print(closeout, flush=True)
        _tee(closeout)
    print(msg_str, flush=True)
    _tee(msg_str)


def bump_version(base_name):
    """Detect a `_v##` (or `-v##`, etc.) suffix and increment the number.
    Preserves zero-padding width. Falls back to '<base>_AI_EDITED' if no version pattern.

    Examples:
      57985_..._v06        → 57985_..._v07
      My_Doc_v9            → My_Doc_v10
      foo-V3               → foo-V4 (case preserved)
      foo (no version)     → foo_AI_EDITED
    """
    m = re.search(r"([_\-\s])(v|V)(\d+)\s*$", base_name)
    if not m:
        return base_name + "_AI_EDITED"
    sep, v, num_str = m.group(1), m.group(2), m.group(3)
    width = len(num_str)
    new_num = int(num_str) + 1
    new_num_str = str(new_num).zfill(width) if width > 1 else str(new_num)
    return base_name[:m.start()] + sep + v + new_num_str


def _normalize_pdf_rect(rect, page_h):
    """Convert a pikepdf /Rect = [x0_bl, y0_bl, x1_bl, y1_bl] (PDF-native,
    bottom-left origin) into PyMuPDF-style top-left coords (x0, y0_top, x1,
    y1_bot) with y0_top < y1_bot. Also normalizes corner ordering — some
    writers emit /Rect with x0 > x1 etc.
    """
    if rect is None or len(rect) < 4:
        return None
    try:
        # pikepdf.Array doesn't support int slicing — iterate to get vals.
        vals = [float(v) for v in rect]
        x0, y0_bl, x1, y1_bl = vals[0], vals[1], vals[2], vals[3]
    except Exception:
        return None
    lx, rx = min(x0, x1), max(x0, x1)
    ly, ry = min(y0_bl, y1_bl), max(y0_bl, y1_bl)
    # Flip y for top-left origin
    return (lx, page_h - ry, rx, page_h - ly)


def _quad_rects_from_quadpoints(qp, page_h):
    """Convert pikepdf /QuadPoints (8 floats per quad, PDF coords) into a
    list of bounding rects in top-left origin.

    The quad-point order varies by writer (Acrobat vs ISO 32000), so we
    just take min/max over all four points per quad — the bounding box is
    correct regardless of corner order.
    """
    rects = []
    if qp is None:
        return rects
    try:
        vals = [float(v) for v in qp]
    except Exception:
        return rects
    if len(vals) % 8 != 0:
        return rects
    for i in range(0, len(vals), 8):
        pts = vals[i:i + 8]
        xs = pts[0::2]
        ys = pts[1::2]
        lx, rx = min(xs), max(xs)
        ly_bl, ry_bl = min(ys), max(ys)
        rects.append((lx, page_h - ry_bl, rx, page_h - ly_bl))
    return rects


def _strip_leading_bullet(text):
    """Strip a leading bullet glyph + spacing from a reconstructed line.
    InDesign typically renders bullets via paragraph style (not as inline
    glyphs in the text run), so a `find` string that starts with "• " will
    fail to match the actual run. We strip a few common bullet/dash chars.
    """
    if not text:
        return text
    # Common bullets / decorations PDF readers emit at the start of list items
    return re.sub(r"^\s*[•‣◦⁃∙·●–—\-\*]+\s*", "", text).strip()


def _refine_annotations_with_cell_geometry(annotations, doc_inspection, pdf_path):
    """For annotations that fall inside a table cell, re-clip `line_text` to
    only the words within that single cell's x-range. The default extraction
    uses a fixed 40pt x-gap heuristic to detect cell boundaries, which fails
    on tables whose cells abut closely (rebate tables, form grids).

    Reads per-table `columnEdges` written by inspect_doc.jsx (in spread
    coordinates — for single-page spreads this matches the PDF's top-left
    origin x). For each annotation falling inside a table, re-runs
    `_line_text_around` with `x_clip` set to the cell's column edges so
    only words inside that cell contribute to the line.
    """
    # Build a per-page list of {column_edges, frame_bounds} entries
    page_tables = {}
    for p in (doc_inspection.get("pages") or []):
        page_num = p.get("page")
        on_page = []
        for fr in (p.get("frames") or []):
            fb = fr.get("bounds") or []  # [y1, x1, y2, x2] in spread coords
            for tbl in (fr.get("tables") or []):
                edges = tbl.get("columnEdges") or []
                if len(edges) >= 2:
                    on_page.append({"edges": edges, "frame_bounds": fb})
        if on_page:
            page_tables[page_num] = on_page
    if not page_tables:
        return  # no tables anywhere — refinement is a no-op

    from pdf_text import PdfTextExtractor
    text = PdfTextExtractor(pdf_path)
    refined = 0
    for ann in annotations:
        page_num = ann.get("page")
        if page_num not in page_tables:
            continue
        rect = ann.get("rect") or []
        if len(rect) < 4:
            continue
        cx = (rect[0] + rect[2]) / 2
        cy = (rect[1] + rect[3]) / 2
        # Pick the table whose column range contains cx (and ideally whose
        # frame_bounds vertical range contains cy, but X is the discriminator
        # we care about for cell clipping).
        cell_x0 = cell_x1 = None
        for tbl in page_tables[page_num]:
            edges = tbl["edges"]
            fb = tbl["frame_bounds"]
            if fb and len(fb) >= 4:
                # frame_bounds is [y1, x1, y2, x2] (top-left origin)
                if not (fb[0] <= cy <= fb[2]):
                    continue
            if cx < edges[0] or cx > edges[-1]:
                continue
            # Find the column the cx falls into
            for ci in range(len(edges) - 1):
                if edges[ci] <= cx <= edges[ci + 1]:
                    cell_x0 = edges[ci]
                    cell_x1 = edges[ci + 1]
                    break
            if cell_x0 is not None:
                break
        if cell_x0 is None:
            continue  # not in any cell

        # Re-extract line_text using the cell's x-range as the clip
        try:
            words = text.get_words(page_num - 1)
        except Exception:
            continue
        new_line = _line_text_around(words, cx, cy, x_clip=(cell_x0, cell_x1))
        if new_line and new_line != ann.get("line_text"):
            ann["line_text"] = new_line
            refined += 1
    return refined


def _line_text_around(words, cx, cy, line_height_band=14, baseline_tol=2,
                      cell_x_gap=40, x_clip=None):
    """Reconstruct the visual line of text containing the point (cx, cy).
    Used by markup annotations (StrikeOut/Highlight/etc.) so the classifier
    has surrounding context for scoped replacements — without this, a
    strikethrough on "3" or "Up" would trigger a global delete across the
    whole doc.

    Words emitted by `PdfTextExtractor.get_words` carry a `line_id`, so the
    line membership lookup is a dict slice instead of the two-pass y-band
    clustering this used to run inline.

    Cross-cell guard: split the chosen line on any horizontal x-gap larger
    than `cell_x_gap` between adjacent words. PDF table cells usually sit
    ≥ 40pt apart, so a big gap means we crossed a column boundary. Keep
    only the chunk that contains the seed point (cx, cy).

    `baseline_tol` is retained for callers that pass it but is unused here
    — line membership is now decided once, at extraction time.
    """
    if not words:
        return None
    # Group by line_id (assigned by pdf_text._assign_line_ids). Falls back
    # to the legacy per-word y-band scan if line_ids aren't present (e.g.
    # a caller built `words` by hand).
    if "line_id" not in words[0]:
        return _line_text_around_legacy(words, cx, cy, line_height_band,
                                        baseline_tol, cell_x_gap, x_clip)
    by_line = {}
    for w in words:
        by_line.setdefault(w["line_id"], []).append(w)
    # Pick the line whose center y is closest to cy. Using center rather
    # than y-range containment matters because tall glyphs (bullets,
    # symbols rendered with extra leading) can have a y-range that
    # swallows a regular text line's cy — selecting the bullet line
    # alone yields a one-glyph "line" that strips to empty.
    best_words = None
    best_dist = float("inf")
    for ws in by_line.values():
        y_min = min(w["y0"] for w in ws)
        y_max = max(w["y1"] for w in ws)
        d = abs(cy - (y_min + y_max) / 2)
        if d > line_height_band:
            continue
        if d < best_dist:
            best_dist = d
            best_words = ws
    if not best_words:
        return None
    # PyMuPDF places adjacent table cells in DIFFERENT blocks (and thus
    # different line_ids) even when they sit on the same visual y
    # baseline. Merge in same-baseline words from other lines so the
    # cell-gap split below sees the full visual line — without this
    # step, a strike in the right column of a 2-column row only gets
    # the right cell's words as line_text, even when the left cell's
    # text is needed for disambiguation (e.g. paired_nearby anchors).
    pick_y0 = min(w["y0"] for w in best_words)
    extras = []
    for lid, ws in by_line.items():
        if ws is best_words:
            continue
        for w in ws:
            if abs(w["y0"] - pick_y0) <= baseline_tol:
                extras.append(w)
    if extras:
        best_words = list(best_words) + extras
    # Apply x_clip (table cell mode) — only words whose center x falls
    # within the cell's column edges, with a small tolerance for
    # ascenders / punctuation that overhang the cell boundary.
    if x_clip is not None:
        cell_x0, cell_x1 = x_clip
        best_words = [w for w in best_words
                      if cell_x0 - 2 <= (w["x0"] + w["x1"]) / 2 <= cell_x1 + 2]
        if not best_words:
            return None
    best_words = sorted(best_words, key=lambda w: w["x0"])
    # Cell-gap split: a big horizontal gap between adjacent words means we
    # crossed a column boundary. Keep the chunk containing the word
    # closest to the cx anchor.
    seed = min(best_words, key=lambda w: abs((w["x0"] + w["x1"]) / 2 - cx))
    chunks = [[]]
    for w in best_words:
        if chunks[-1] and (w["x0"] - chunks[-1][-1]["x1"]) > cell_x_gap:
            chunks.append([])
        chunks[-1].append(w)
    seed_chunk = chunks[0]
    for chunk in chunks:
        if any(w is seed for w in chunk):
            seed_chunk = chunk
            break
    line_text = " ".join(w["text"] for w in seed_chunk).strip()
    return _strip_leading_bullet(line_text)


def _line_text_around_legacy(words, cx, cy, line_height_band=14,
                             baseline_tol=2, cell_x_gap=40, x_clip=None):
    """Fallback used when caller passed words without `line_id` set."""
    candidates = []
    for w in words:
        wcy = (w["y0"] + w["y1"]) / 2
        if abs(wcy - cy) > line_height_band:
            continue
        if x_clip is not None:
            cell_x0, cell_x1 = x_clip
            wcx = (w["x0"] + w["x1"]) / 2
            if wcx < cell_x0 - 2 or wcx > cell_x1 + 2:
                continue
        candidates.append(w)
    if not candidates:
        return None
    candidates.sort(key=lambda w: (w["y0"] - cy) ** 2 + ((w["x0"] + w["x1"]) / 2 - cx) ** 2)
    seed = candidates[0]
    seed_y0 = seed["y0"]
    line_words = [w for w in candidates if abs(w["y0"] - seed_y0) <= baseline_tol]
    line_words.sort(key=lambda w: w["x0"])
    chunks = [[]]
    for w in line_words:
        if chunks[-1] and (w["x0"] - chunks[-1][-1]["x1"]) > cell_x_gap:
            chunks.append([])
        chunks[-1].append(w)
    seed_chunk = chunks[0]
    for chunk in chunks:
        if any(w is seed for w in chunk):
            seed_chunk = chunk
            break
    line_text = " ".join(w["text"] for w in seed_chunk).strip()
    return _strip_leading_bullet(line_text)


def extract_annotations(pdf_path):
    """Extract sticky-note annotations from the marked-up PDF and, for each,
    capture what text is *near* the annotation's icon so we can detect the
    common reviewer convention: 'put a sticky note next to a word containing
    only the replacement text'.

    Returns each annotation with:
      page, rect, type, content,
      nearby_text       — the closest word(s) to the icon
      nearby_text_rect  — bbox of that text in the PDF
      line_text         — full line containing the nearby text
    """
    import fitz  # PyMuPDF — primary engine in 1.0.8
    from pdf_text import PdfTextExtractor

    annotations = []

    # PyMuPDF annotation type names (already match the strings the rule-
    # based classifier expects, no pikepdf "/Subtype" prefix to strip).
    MARKUP_TYPES = ("StrikeOut", "Underline", "Squiggly", "Highlight")
    KNOWN_TYPES = MARKUP_TYPES + ("Text", "FreeText", "Caret")

    doc = fitz.open(pdf_path)
    text = PdfTextExtractor(pdf_path)
    try:
        for page_idx in range(doc.page_count):
            page = doc[page_idx]
            # PyMuPDF gives us annot rects + vertices in top-left origin
            # already, so no MediaBox-height-based y-flipping like 1.0.7
            # had to do. The rect/sub_rect coords feed the classifier in
            # the same coordinate system as `words` from the extractor.

            # Pre-fetch all words on the page in two modes (same contract
            # as 1.0.7 — only the underlying engine changed):
            #   - words: hyphenated tokens stay merged ("High-bay") — used
            #     for line_text reconstruction so the find string matches
            #     the original InDesign character sequence.
            #   - words_split: punctuation/hyphen-split tokens — used for
            #     marked_text extraction so a strike on "-bay fixtures"
            #     captures only that, not the whole "High-bay" token.
            words = text.get_words(page_idx)
            words_split = text.get_words(page_idx, split_punctuation=True)

            for annot in page.annots() or ():
                # PyMuPDF: .type → (int, "TypeName"); .info → dict with
                # 'content'/'title'/'subject'; .rect → fitz.Rect (top-
                # left); .vertices → flat list of (x,y) points, 4 per
                # quad for markup annotations, in top-left coords.
                try:
                    atype = annot.type[1] if annot.type else ""
                except Exception:
                    continue
                if atype not in KNOWN_TYPES:
                    continue
                try:
                    content = (annot.info.get("content") or "").strip()
                except Exception:
                    content = ""

                rect = annot.rect
                rx0, ry0, rx1, ry1 = float(rect.x0), float(rect.y0), float(rect.x1), float(rect.y1)
                # Defend against degenerate / inverted rects from third-
                # party annotators.
                if rx0 > rx1: rx0, rx1 = rx1, rx0
                if ry0 > ry1: ry0, ry1 = ry1, ry0
                r = (rx0, ry0, rx1, ry1)

                # ---- Strikethrough / underline / highlight: extract underlying text ----
                # PyMuPDF exposes /QuadPoints as `annot.vertices` — a flat
                # list of (x, y) tuples already in top-left coords, four
                # points per quad. One quad per visual line the markup
                # covers; multi-line strikes give us multiple quads.
                if atype in MARKUP_TYPES:
                    marked_text = ""
                    sub_rects = []
                    verts = annot.vertices or []
                    for q in range(0, len(verts), 4):
                        quad = verts[q:q + 4]
                        if len(quad) < 4:
                            continue
                        xs = [float(p[0]) for p in quad]
                        ys = [float(p[1]) for p in quad]
                        sub_rects.append((min(xs), min(ys), max(xs), max(ys)))
                    # Prefer word-level extraction with a 50% bbox-overlap
                    # rule. Two failure modes to balance:
                    #   - Center-inside-quad is too strict: a strike that
                    #     visually covers "bay fixtures" can leave "bay" out
                    #     if its center is barely past the quad's left edge.
                    #   - pypdfium2's get_text_bounded is too leaky: a strike
                    #     on "upfront" returns "y upfront" because the rect
                    #     clips a tail glyph from an adjacent word.
                    # Requiring ≥ 50% of the word's area to overlap the quad
                    # catches words with a small overshoot and rejects words
                    # only partially clipped at the edge.
                    if sub_rects:
                        bits = []
                        for sr in sub_rects:
                            sx0, sy0, sx1, sy1 = sr
                            in_rect = []
                            # Use the split-punctuation word set so a strike
                            # on "-bay fixtures" captures only those tokens,
                            # not the whole "High-bay" hyphenated word.
                            for w in words_split:
                                ww = w["x1"] - w["x0"]
                                wh = w["y1"] - w["y0"]
                                if ww <= 0 or wh <= 0:
                                    continue
                                ox = max(0.0, min(w["x1"], sx1) - max(w["x0"], sx0))
                                oy = max(0.0, min(w["y1"], sy1) - max(w["y0"], sy0))
                                if (ox * oy) / (ww * wh) >= 0.5:
                                    in_rect.append(w)
                            if in_rect:
                                in_rect.sort(key=lambda w: (round(w["y0"]), w["x0"]))
                                # Re-join WITHOUT spaces around hyphens that
                                # bind to adjacent letters (so "-" + "bay"
                                # → "-bay"); regular spaces between alpha
                                # tokens stay.
                                pieces = []
                                for w in in_rect:
                                    t = w["text"]
                                    if t == "-" and pieces and not pieces[-1].endswith(" "):
                                        pieces[-1] = pieces[-1] + "-"
                                    elif pieces and pieces[-1].endswith("-"):
                                        pieces[-1] = pieces[-1] + t
                                    else:
                                        pieces.append(t)
                                bits.append(" ".join(pieces))
                        marked_text = " ".join(bits).strip()
                    # Fall back to bounded text if no words landed inside
                    # the quads (rare — happens with very narrow strike
                    # marks on punctuation).
                    if not marked_text and sub_rects:
                        bits = []
                        for sr in sub_rects:
                            t = text.get_text_in_rect(page_idx, sr).strip()
                            if t:
                                bits.append(t)
                        marked_text = " ".join(bits).strip()
                    # Char-level fallback for zero-width-glyph strikes:
                    # PyMuPDF reports end-of-sentence periods/commas with
                    # an x0==x1 text bbox in some fonts, so the glyph
                    # falls outside both the word bbox AND the bounded-
                    # text clip even though the strike's QuadPoint sits
                    # squarely on its visible ink. Walk individual chars
                    # and pick by bbox-center inclusion.
                    if not marked_text and sub_rects:
                        bits = []
                        for sr in sub_rects:
                            t = text.get_chars_in_rect(page_idx, sr).strip()
                            if t:
                                bits.append(t)
                        marked_text = " ".join(bits).strip()
                    if not marked_text:
                        # Final fallback: words intersecting the annotation rect
                        bits = []
                        for w in words:
                            if (w["x0"] >= rx0 - 1 and w["x1"] <= rx1 + 1 and
                                    w["y0"] >= ry0 - 2 and w["y1"] <= ry1 + 2):
                                bits.append(w["text"])
                        marked_text = " ".join(bits).strip()
                    # Strip control chars + collapse whitespace
                    marked_text = re.sub(r"[\x00-\x08\x0B\x0C\x0E-\x1F]+", "", marked_text)
                    marked_text = re.sub(r"\s+", " ", marked_text).strip()

                    # Also reconstruct surrounding line_text — gives the
                    # classifier context for scoped replacement when the
                    # marked text is too short to safely match globally
                    # (e.g. a strikethrough on "3" or "Up").
                    #
                    # Multi-line strikes (sub_rects span more than one
                    # visual line): walk each sub-rect, pull its line,
                    # and join them in reading order. Without this, a
                    # strike on "three" + "month" across a soft-wrap
                    # gets a `line_text` from the rect's centroid — which
                    # lands between the two lines and arbitrarily picks
                    # one. The joined version contains the marked text
                    # contiguously so the classifier's line-scoped
                    # REPLACE_TEXT path stays surgical.
                    if len(sub_rects) > 1:
                        seen_lines = set()
                        line_chunks = []
                        for sr in sub_rects:
                            scx = (sr[0] + sr[2]) / 2
                            scy = (sr[1] + sr[3]) / 2
                            chunk = _line_text_around(words, scx, scy)
                            if chunk and chunk not in seen_lines:
                                seen_lines.add(chunk)
                                line_chunks.append(chunk)
                        sl_line_text = " ".join(line_chunks).strip() if line_chunks else None
                    else:
                        sl_line_text = _line_text_around(words, (rx0 + rx1) / 2, (ry0 + ry1) / 2)

                    # Whitespace-only strike detection: if marked_text strips
                    # empty and the strike is on a StrikeOut, the reviewer
                    # likely struck a single redundant space character. The
                    # standard text extractors normalize whitespace so we
                    # never see the multi-space sequence on the line. Capture
                    # surrounding context with a WIDER rect using PyMuPDF's
                    # raw textbox API (which preserves spacing better) so the
                    # classifier can emit a GREP collapsing 2+ whitespace at
                    # the right spot.
                    whitespace_strike_context = None
                    if not marked_text and atype == "StrikeOut":
                        try:
                            ws_rect = fitz.Rect(rx0 - 30, ry0 - 1, rx1 + 30, ry1 + 1)
                            ws_text = page.get_textbox(ws_rect) or ""
                            # If there's a 2+ whitespace run inside the wider
                            # text, capture the chars flanking it as anchors.
                            m_ws = re.search(r"(\S+)\s{2,}(\S+)", ws_text)
                            if m_ws:
                                whitespace_strike_context = {
                                    "before": m_ws.group(1),
                                    "after": m_ws.group(2),
                                    "raw": ws_text.strip(),
                                }
                                # Mark with a single-space placeholder so the
                                # `if marked_text:` guard below admits the annotation.
                                marked_text = " "
                        except Exception:
                            pass

                    # Single-letter case-fix disambiguation: when marked_text
                    # is one alpha char (e.g. 'w'), capture the FULL containing
                    # word using the strike's rect-vs-words geometry. Without
                    # this, classify_annotation can't tell which 'w' on the
                    # line was struck (e.g. "straightforward" vs "when") if
                    # the paired-comment's nearby text isn't on the same line.
                    marked_word = None
                    if (marked_text and len(marked_text) == 1
                            and marked_text.isalpha() and atype == "StrikeOut"):
                        cx_strike = (rx0 + rx1) / 2
                        cy_strike = (ry0 + ry1) / 2
                        for w in words:  # unsplit words → "when" stays whole
                            if (w["x0"] - 1 <= cx_strike <= w["x1"] + 1 and
                                    w["y0"] - 2 <= cy_strike <= w["y1"] + 2):
                                marked_word = w["text"]
                                break

                    if marked_text:
                        ann_record = {
                            "page": page_idx + 1,
                            "rect": [round(x, 2) for x in r],
                            # Per-line sub-rectangles from /QuadPoints (top-
                            # left coords). One entry per visual line the
                            # markup covers: a single-line strike has one
                            # sub-rect, a strike spanning a soft-wrap has
                            # two. Lets downstream code measure proximity
                            # against the actual marked regions instead of
                            # the wide bounding `rect`, and tells whether
                            # the markup is multi-line at a glance.
                            "sub_rects": [[round(x, 2) for x in sr] for sr in (sub_rects or [])],
                            "type": atype,
                            # Highlights/Underlines often carry an instruction
                            # in /Contents (e.g. "Lowercase", "Use a curly
                            # apostrophe...") — capture it so the classifier
                            # can act on or surface it.
                            "content": content,
                            "marked_text": marked_text,
                            "nearby_text": None,
                            "nearby_rect": None,
                            "line_text": sl_line_text,
                        }
                        if whitespace_strike_context:
                            ann_record["whitespace_strike_context"] = whitespace_strike_context
                        if marked_word:
                            ann_record["marked_word"] = marked_word
                        annotations.append(ann_record)
                    continue

                if not content:
                    continue
                cx = (rx0 + rx1) / 2
                cy = (ry0 + ry1) / 2

                # Find nearest word(s). Bias: same horizontal line as icon,
                # prefer words to the LEFT (reviewers typically place sticky-
                # note icons after the word being commented on).
                #
                # Two-pass:
                #   1. Loose y-band (14pt) to find candidate words near the icon
                #      — sticky icons are ~24pt tall and rarely centered exactly
                #      on a baseline, so we need a forgiving first pass.
                #   2. After picking the closest word, re-filter to ONLY the
                #      words on the picked word's actual baseline (y0 within
                #      ~2pt). This keeps adjacent visual lines from leaking into
                #      `line_text`. PyMuPDF gave us block/line numbers for free;
                #      pdfplumber doesn't, so we use top-edge proximity instead.
                line_height_band = 14
                same_line = []
                for w in words:
                    x0, y0, x1, y1 = w["x0"], w["y0"], w["x1"], w["y1"]
                    t = w["text"]
                    if not t.strip():
                        continue
                    wcy = (y0 + y1) / 2
                    if abs(wcy - cy) > line_height_band:
                        continue
                    gap = cx - x1  # negative if word is to the right of icon
                    same_line.append({"text": t, "rect": [x0, y0, x1, y1], "gap": gap})

                nearby_text = None
                nearby_rect = None
                line_text = None
                if same_line:
                    left_of = [w for w in same_line if w["gap"] >= -5]
                    left_of.sort(key=lambda w: w["gap"])
                    pick = left_of[0] if left_of else same_line[0]
                    nearby_text = pick["text"]
                    nearby_rect = pick["rect"]
                    # Tight pass: same baseline as the picked word (tolerate
                    # ~2pt for ascender/descender drift).
                    pick_y0 = pick["rect"][1]
                    line_words = [w for w in same_line if abs(w["rect"][1] - pick_y0) <= 2]
                    line_words.sort(key=lambda w: w["rect"][0])
                    # Cross-cell guard: split on x-gap > 40pt (likely a
                    # column boundary) and keep only the chunk containing
                    # the picked word. Otherwise table-row line_text would
                    # merge "Incentive" (label column) with "Up to $X" body.
                    chunks = [[]]
                    cell_x_gap = 40
                    for lw in line_words:
                        if chunks[-1] and (lw["rect"][0] - chunks[-1][-1]["rect"][2]) > cell_x_gap:
                            chunks.append([])
                        chunks[-1].append(lw)
                    pick_chunk = chunks[0]
                    for chunk in chunks:
                        if any(w is pick for w in chunk):
                            pick_chunk = chunk; break
                    line_text = " ".join(w["text"] for w in pick_chunk).strip()
                    # Strip leading bullets — InDesign bullets are rendered
                    # by paragraph style, not as inline glyphs, so they
                    # won't appear in the runs we find/replace against.
                    line_text = _strip_leading_bullet(line_text)

                # Caret annotations sometimes live in table cells where the
                # relevant target (e.g. a "$1000" amount the reviewer wants to
                # format with a comma) is on a DIFFERENT line from the line
                # the caret was visually drawn on. Capture a broader column-
                # scoped context so rules like "comma-caret → format thousands"
                # can find the target number even when it's not on the
                # immediate baseline.
                column_block_text = None
                if atype == "Caret":
                    col_x_low, col_x_high = cx - 150, cx + 150  # narrow cell width
                    cy_low, cy_high = cy - 40, cy + 40           # ±2 lines
                    block_words = []
                    for w in words:
                        wcy = (w["y0"] + w["y1"]) / 2
                        if not (cy_low <= wcy <= cy_high): continue
                        if w["x1"] < col_x_low or w["x0"] > col_x_high: continue
                        block_words.append(w)
                    block_words.sort(key=lambda w: (round(w["y0"], 1), w["x0"]))
                    column_block_text = " ".join(w["text"] for w in block_words).strip()

                annotations.append({
                    "page": page_idx + 1,
                    "rect": [round(x, 2) for x in r],
                    "type": atype,
                    "content": content,
                    "nearby_text": nearby_text,
                    "nearby_rect": nearby_rect,
                    "line_text": line_text,
                    "column_block_text": column_block_text,
                })
    finally:
        text.close()
        doc.close()

    return annotations


def render_template(template_path, replacements, out_path):
    src = Path(template_path).read_text()
    for old, new in replacements.items():
        src = src.replace(old, new)
    issues = scan_jsx_for_hazards(src)
    if issues:
        for line_no, kind, snippet in issues:
            log(f"[orchestrate] JSX hazard ({kind}) at line {line_no}: {snippet[:80]}")
        # Hard-fail on hazards that would silently break the script in
        # ExtendScript. SyntaxError-class issues should never reach the user.
        raise RuntimeError(
            f"JSX template {Path(template_path).name} has {len(issues)} parser hazard(s); "
            "see log above. Fix at the JSX source — do not paper over with try/catch."
        )
    Path(out_path).write_text(src)


# ----- JSX safety scans --------------------------------------------------

# Bytes that are valid in UTF-8 but break ExtendScript regex/string literals
# when they appear *literally* in source (rather than as \xNN / \uNNNN escapes).
# NUL (0x00) is the worst offender: most parsers treat it as end-of-input
# inside a regex literal, silently truncating the regex.
_JSX_HAZARD_BYTES = {
    0x00: "NUL byte (ends regex literal in ExtendScript)",
    0xFE: "literal byte 0xFE (often part of stray UTF-16 BOM)",
    0xFF: "literal byte 0xFF (often part of stray UTF-16 BOM)",
}


def scan_jsx_for_hazards(src):
    """Return list of (line_no, kind, line) for lines that contain bytes or
    patterns known to silently break ExtendScript parsing.

    We focus on hazards that would cause the JSX to throw SyntaxError at
    parse time (which gets caught by an enclosing try/catch and silently
    breaks downstream features) rather than runtime errors.
    """
    issues = []
    for i, line in enumerate(src.splitlines(), 1):
        # Hazard 1: literal NUL / 0xFE / 0xFF bytes anywhere in the line.
        for ch in line:
            code = ord(ch)
            if code in _JSX_HAZARD_BYTES:
                issues.append((i, _JSX_HAZARD_BYTES[code], line))
                break
        # Hazard 2: regex literal containing the BOM (U+FEFF) literally.
        # The BOM in a /.../ class doesn't break parsing on its own but it
        # ALMOST ALWAYS appears next to other control bytes that DO break it,
        # and is a strong signal someone tried to paste binary chars into a
        # regex. Flag it.
        if "/[" in line and "﻿" in line:
            issues.append((i, "BOM (U+FEFF) inside a regex literal", line))
        # Hazard 3: regex literal containing C0 control chars (0x00–0x1F)
        # in literal form rather than as \xNN escapes.
        if "/[" in line:
            for ch in line:
                if 0x00 <= ord(ch) <= 0x08 or ord(ch) in (0x0B, 0x0C) or 0x0E <= ord(ch) <= 0x1F:
                    issues.append((i, f"control char U+{ord(ch):04X} in regex literal (use \\xNN)", line))
                    break
    return issues


def scan_apply_log_for_jsx_errors(log_path):
    """Scan apply_log.txt for ExtendScript runtime errors that would otherwise
    be hidden behind try/catch blocks. Returns a list of finding dicts ready
    to merge into findings.json — empty list if the run was clean.

    Recognized error patterns:
      • 'SyntaxError' / 'ReferenceError' / 'TypeError' — language-level errors
      • 'step err:' / 'place err:' — our own JSX log markers for caught errs
      • 'Error:' — generic InDesign DOM errors
    """
    if not Path(log_path).exists():
        return []
    text = Path(log_path).read_text(errors="replace")
    findings = []
    seen = set()
    patterns = [
        (r"\bSyntaxError\b[^\n\r]*", "JSX_SYNTAX_ERROR", "ERROR"),
        (r"\bReferenceError\b[^\n\r]*", "JSX_REFERENCE_ERROR", "ERROR"),
        (r"\bTypeError\b[^\n\r]*", "JSX_TYPE_ERROR", "ERROR"),
        (r"step err:\s*[^\n\r]+", "JSX_STEP_ERROR", "WARNING"),
        (r"place err:\s*[^\n\r]+", "JSX_PLACE_ERROR", "WARNING"),
    ]
    for pat, fid, severity in patterns:
        for m in re.finditer(pat, text):
            snippet = m.group(0).strip()
            key = (fid, snippet[:120])
            if key in seen: continue
            seen.add(key)
            findings.append({
                "id": fid,
                "severity": severity,
                "scope": "doc",
                "message": f"JSX runtime issue detected in apply_log.txt: {snippet[:200]}",
                "auto_fixable": False,
            })
    return findings


def run_indesign_script(jsx_path, timeout=1200, engine=None):
    """Run a JSX file in the host app. The active engine determines which
    application AppleScript talks to. Kept the original name so the rest of
    the code reads naturally — this is a thin shim onto Engine.run_script().
    """
    if engine is None:
        # Backwards compat: assume InDesign if caller didn't supply one.
        from engines.indesign import InDesignEngine
        engine = InDesignEngine()
    return engine.run_script(jsx_path, timeout=timeout)


DATA_MERGE_TEMPLATE       = Path(__file__).parent.parent / "jsx" / "data_merge.jsx"
TAG_TEMPLATE_JSX          = Path(__file__).parent.parent / "jsx" / "tag_template.jsx"
RESTRUCTURE_STYLES_JSX    = Path(__file__).parent.parent / "jsx" / "restructure_styles.jsx"
CREATE_HYPERLINKS_JSX     = Path(__file__).parent.parent / "jsx" / "create_hyperlinks.jsx"


def _count_csv_rows(csv_path):
    import csv
    with open(csv_path, "r", encoding="utf-8", newline="") as f:
        return sum(1 for _ in csv.reader(f)) - 1  # minus header

def _count_csv_cols(csv_path):
    import csv
    with open(csv_path, "r", encoding="utf-8", newline="") as f:
        r = csv.reader(f)
        try: return len(next(r))
        except StopIteration: return 0

def _read_csv_states(csv_path):
    import csv
    out = []
    with open(csv_path, "r", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            s = (row.get("state") or "").strip()
            if s: out.append(s)
    return out


def _resolve_unique_output(input_path, requested_output, suffix="_TAGGED"):
    """Return an output path that's guaranteed not to overwrite anything.

    Rules:
      - If `requested_output` is empty / None / equals `input_path`, build a
        sibling path with `suffix` inserted before the extension.
      - If the chosen path already exists on disk, append " 2", " 3", … until
        a free filename is found. Never overwrites.
    """
    inp = Path(input_path)
    if requested_output and Path(requested_output).resolve() != inp.resolve():
        target = Path(requested_output)
    else:
        target = inp.with_name(f"{inp.stem}{suffix}{inp.suffix}")
    # Collision guard
    if not target.exists():
        return str(target)
    n = 2
    while True:
        candidate = target.with_name(f"{target.stem} {n}{target.suffix}")
        if not candidate.exists():
            return str(candidate)
        n += 1


def main_tag_template(payload):
    """Auto-tag an InDesign template with <<placeholder>> tokens.

    Payload shape:
      {
        "mode": "tag_template",
        "templatePath": "/path/to/untagged.indd",
        "xlsxPaths": [...]           — OR — "csvPath": "/path/to/data.csv",
        "refState": "California",   (optional; default 'California')
        "outputPath": "/path/...",  (optional; default = save in place)
      }
    """
    sys.path.insert(0, str(HERE))
    from data_merge import flatten_xlsx_to_csv
    from tag_template_driver import build_tag_pairs, load_ref_row, LIST_COLS

    template_path = payload["templatePath"]
    xlsx_paths    = payload.get("xlsxPaths") or []
    csv_path      = payload.get("csvPath")
    ref_state     = (payload.get("refState") or "California").strip()
    output_path   = payload.get("outputPath")
    settings      = payload.get("settings") or {}

    # Never overwrite the input. If no output path was supplied (or it points
    # at the input), generate "<stem>_TAGGED.indd" next to the input, falling
    # back to "_TAGGED 2.indd" / "_TAGGED 3.indd" if that already exists.
    output_path = _resolve_unique_output(template_path, output_path, "_TAGGED")

    log(f"[orchestrate] MODE: tag_template")
    log(f"[orchestrate] template:  {template_path}")
    log(f"[orchestrate] ref state: {ref_state}")
    log(f"[orchestrate] output:    {output_path}")

    work_dir = get_work_dir(Path(output_path).parent, template_path,
                             settings.get("cacheRetention", DEFAULT_CACHE_RETENTION))
    log(f"[orchestrate] WORK: {work_dir}")
    _emit_work_dir(work_dir)

    # Step 1: get a CSV — either flatten the Excel files or use the one provided
    if not csv_path:
        if not xlsx_paths:
            log("[orchestrate] ERROR: need either xlsxPaths or csvPath")
            sys.exit(2)
        log("[orchestrate] step 1: flattening xlsx → csv")
        csv_path = work_dir / "data_merge.csv"
        flatten_xlsx_to_csv(xlsx_paths, csv_path,
                             out_placeholders_md=work_dir / "placeholders.md")
        log(f"[orchestrate]   csv → {csv_path}")
    else:
        log(f"[orchestrate] step 1: using existing csv → {csv_path}")

    # Step 2: pull the reference state's row
    ref_row = load_ref_row(csv_path, ref_state)
    if not ref_row:
        log(f"[orchestrate] ERROR: reference state '{ref_state}' not found in CSV")
        sys.exit(3)
    log(f"[orchestrate] step 2: ref row has {len(ref_row)} columns")

    # Step 3: build tag pairs + write JSON sidecars
    pairs = build_tag_pairs(ref_row, ref_state)
    list_tokens = sorted(LIST_COLS)
    pairs_json    = work_dir / "tag_pairs.json"
    list_tokens_j = work_dir / "tag_list_tokens.json"
    pairs_json.write_text(json.dumps(pairs, indent=2))
    list_tokens_j.write_text(json.dumps(list_tokens))
    log(f"[orchestrate] step 3: built {len(pairs)} tag pair(s) + "
        f"{len(list_tokens)} list-token(s)")

    # Step 4: render + run the tagging JSX
    log_path   = work_dir / "tag_log.txt"
    report_md  = work_dir / "tag_report.md"
    log_path.write_text("")
    jsx_out    = work_dir / "tag_template.jsx"
    render_template(TAG_TEMPLATE_JSX, {
        "__TEMPLATE_INDD__":         str(template_path),
        "__OUTPUT_INDD__":           str(output_path),
        "__PAIRS_JSON_PATH__":       str(pairs_json),
        "__LIST_TOKENS_JSON_PATH__": str(list_tokens_j),
        "__REPORT_PATH__":           str(report_md),
        "__LOG_PATH__":              str(log_path),
    }, jsx_out)

    log("[orchestrate] step 4: running InDesign auto-tagger…")
    from engines.indesign import InDesignEngine
    engine = InDesignEngine()
    proc = run_indesign_script(jsx_out, timeout=600, engine=engine)
    if proc.returncode != 0:
        log(f"[orchestrate] tag step failed: {proc.stderr}")
        sys.exit(proc.returncode)

    # Tail the JSX log
    try:
        for line in log_path.read_text().split("\n"):
            if line.strip():
                log(f"[indesign] {line}")
    except Exception:
        pass

    # Surface the report inline as well
    try:
        report_text = report_md.read_text()
        log("[orchestrate] --- tag report ---")
        for line in report_text.split("\n"):
            log(f"[orchestrate] {line}")
    except Exception:
        pass

    (work_dir / "result.json").write_text(json.dumps({
        "mode": "tag_template",
        "template_input": str(template_path),
        "template_output": str(output_path),
        "csv_path": str(csv_path),
        "report": str(report_md),
        "n_pairs": len(pairs),
    }))
    log(f"[orchestrate] done — tagged template → {output_path}")


def main_restructure_styles(payload):
    """Apply a paragraph-style restructure proposal that the user reviewed.

    Payload shape:
      {
        "mode": "restructure_styles",
        "inddPath": "/path/to/doc.indd",
        "proposalsPath": "/path/to/style_proposals.json",
            (with each candidate annotated `apply: true|false` + optional
             `proposed_name` rename — the renderer writes this back)
        "pdfOutPath": "/path/to/out.pdf"   (optional; re-export after applying)
      }
    """
    indd_path     = payload["inddPath"]
    proposals_in  = payload["proposalsPath"]
    pdf_out       = payload.get("pdfOutPath") or ""
    settings      = payload.get("settings") or {}

    log(f"[orchestrate] MODE: restructure_styles")
    log(f"[orchestrate] indd:  {indd_path}")
    log(f"[orchestrate] props: {proposals_in}")
    log(f"[orchestrate] pdf:   {pdf_out or '(skip re-export)'}")

    out_dir = Path(indd_path).parent
    work_dir = get_work_dir(out_dir, indd_path,
                             settings.get("cacheRetention", DEFAULT_CACHE_RETENTION))
    log(f"[orchestrate] WORK: {work_dir}")
    _emit_work_dir(work_dir)

    log_path = work_dir / "restructure_log.txt"
    log_path.write_text("")
    jsx_out  = work_dir / "restructure_styles.jsx"
    render_template(RESTRUCTURE_STYLES_JSX, {
        "__INDD_PATH__":      str(indd_path),
        "__PROPOSALS_PATH__": str(proposals_in),
        "__LOG_PATH__":       str(log_path),
        "__PDF_OUT_PATH__":   str(pdf_out),
    }, jsx_out)

    from engines.indesign import InDesignEngine
    engine = InDesignEngine()
    proc = run_indesign_script(jsx_out, timeout=600, engine=engine)
    if proc.returncode != 0:
        log(f"[orchestrate] restructure failed: {proc.stderr}")
        sys.exit(proc.returncode)

    try:
        for line in log_path.read_text().split("\n"):
            if line.strip(): log(f"[indesign] {line}")
    except Exception:
        pass

    (work_dir / "result.json").write_text(json.dumps({
        "mode": "restructure_styles",
        "indd_out": str(indd_path),
        "pdf_out": pdf_out or None,
    }))
    log("[orchestrate] done — styles created + applied")


def main_create_hyperlinks(payload):
    """Apply user-reviewed hyperlink proposals.

    Payload shape:
      {
        "mode": "create_hyperlinks",
        "inddPath": "/path/to/doc.indd",
        "proposalsPath": "/path/to/hyperlink_proposals.json"
            (with each proposal annotated `apply: true|false`),
        "pdfOutPath": "/path/..."   (optional; re-export after applying)
      }
    """
    indd_path    = payload["inddPath"]
    proposals_in = payload["proposalsPath"]
    pdf_out      = payload.get("pdfOutPath") or ""
    settings     = payload.get("settings") or {}

    log(f"[orchestrate] MODE: create_hyperlinks")
    log(f"[orchestrate] indd:  {indd_path}")
    log(f"[orchestrate] props: {proposals_in}")

    out_dir = Path(indd_path).parent
    work_dir = get_work_dir(out_dir, indd_path,
                             settings.get("cacheRetention", DEFAULT_CACHE_RETENTION))
    log(f"[orchestrate] WORK: {work_dir}")
    _emit_work_dir(work_dir)

    log_path = work_dir / "create_hyperlinks_log.txt"
    log_path.write_text("")
    jsx_out  = work_dir / "create_hyperlinks.jsx"
    render_template(CREATE_HYPERLINKS_JSX, {
        "__INDD_PATH__":      str(indd_path),
        "__PROPOSALS_PATH__": str(proposals_in),
        "__LOG_PATH__":       str(log_path),
        "__PDF_OUT_PATH__":   str(pdf_out),
    }, jsx_out)

    from engines.indesign import InDesignEngine
    engine = InDesignEngine()
    proc = run_indesign_script(jsx_out, timeout=600, engine=engine)
    if proc.returncode != 0:
        log(f"[orchestrate] create_hyperlinks failed: {proc.stderr}")
        sys.exit(proc.returncode)

    try:
        for line in log_path.read_text().split("\n"):
            if line.strip(): log(f"[indesign] {line}")
    except Exception:
        pass

    (work_dir / "result.json").write_text(json.dumps({
        "mode": "create_hyperlinks",
        "indd_out": str(indd_path),
        "pdf_out": pdf_out or None,
    }))
    log("[orchestrate] done — hyperlinks created")


def main_data_merge(payload):
    """Run the Excel → tagged-template → per-state .indd pipeline.

    Payload shape:
      {
        "mode": "data_merge",
        "templatePath": "/path/to/template.indd",
        "xlsxPaths": ["/path/to/batch1.xlsx", "/path/to/batch2.xlsx", …],
        "outputDir": "/path/to/where/the/per_state_files/should/land",
        "nameColumn": "state"   (optional; default 'state')
      }
    """
    sys.path.insert(0, str(HERE))
    from data_merge import flatten_xlsx_to_csv

    template_path = payload["templatePath"]
    xlsx_paths    = payload.get("xlsxPaths") or []
    csv_input     = payload.get("csvPath")  # optional pre-built CSV
    output_dir    = payload["outputDir"]
    name_column   = (payload.get("nameColumn") or "state").strip()
    maps_folder   = payload.get("mapsFolder") or None
    settings      = payload.get("settings") or {}

    log(f"[orchestrate] MODE: data_merge")
    log(f"[orchestrate] template: {template_path}")
    if csv_input:
        log(f"[orchestrate] csv input: {csv_input}")
    else:
        log(f"[orchestrate] xlsx ({len(xlsx_paths)}):")
        for p in xlsx_paths: log(f"[orchestrate]   - {p}")
    log(f"[orchestrate] maps folder: {maps_folder or '(none)'}")
    log(f"[orchestrate] output: {output_dir}")

    Path(output_dir).mkdir(parents=True, exist_ok=True)
    work_dir = get_work_dir(output_dir, template_path,
                             settings.get("cacheRetention", DEFAULT_CACHE_RETENTION))
    log(f"[orchestrate] WORK: {work_dir}")
    _emit_work_dir(work_dir)

    # Step 1: get a CSV — either flatten Excel files or use the provided one
    md_path  = work_dir / "placeholders.md"
    if csv_input:
        log("[orchestrate] step 1: using existing CSV (skipping xlsx flatten)")
        csv_path = Path(csv_input)
        summary = {
            "n_states": _count_csv_rows(csv_path),
            "n_columns": _count_csv_cols(csv_path),
            "states": _read_csv_states(csv_path),
            "n_maps_matched": 0, "maps_missing": [],
        }
    else:
        log("[orchestrate] step 1: flattening xlsx → csv…")
        csv_path = work_dir / "data_merge.csv"
        summary = flatten_xlsx_to_csv(xlsx_paths, csv_path, md_path,
                                       maps_folder=maps_folder)
    log(f"[orchestrate]   {summary['n_states']} states, "
        f"{summary['n_columns']} columns → {csv_path}")
    if maps_folder and summary.get("n_maps_matched") is not None:
        log(f"[orchestrate]   maps matched: {summary['n_maps_matched']}/{summary['n_states']}")
        if summary["maps_missing"]:
            log(f"[orchestrate]   no map for: {', '.join(summary['maps_missing'][:6])}"
                + ("…" if len(summary['maps_missing']) > 6 else ""))
    if not csv_input:
        log(f"[orchestrate]   placeholder reference → {md_path}")

    # Step 2: Run the InDesign data-merge JSX. One pass through, produces
    # one .indd per record under output_dir.
    log("[orchestrate] step 2: running InDesign Data Merge…")
    log_path = work_dir / "merge_log.txt"
    log_path.write_text("")  # JSX appends with "a"
    merge_jsx = work_dir / "data_merge.jsx"
    render_template(DATA_MERGE_TEMPLATE, {
        "__TEMPLATE_INDD__": str(template_path),
        "__CSV_PATH__":      str(csv_path),
        "__OUTPUT_DIR__":    str(output_dir),
        "__LOG_PATH__":      str(log_path),
        "__NAME_COLUMN__":   name_column,
    }, merge_jsx)

    # Use InDesign engine for now (only engine that supports Data Merge)
    from engines.indesign import InDesignEngine
    engine = InDesignEngine()
    proc = run_indesign_script(merge_jsx, timeout=1800, engine=engine)
    if proc.returncode != 0:
        log(f"[orchestrate] Data Merge failed: {proc.stderr}")
        sys.exit(proc.returncode)

    # Tail the merge log for the user
    try:
        merge_output = log_path.read_text()
        for line in merge_output.split("\n"):
            if line.strip():
                log(f"[indesign] {line}")
    except Exception:
        pass

    # Write result.json so the renderer knows what got generated
    generated = sorted(Path(output_dir).glob("*.indd"))
    (work_dir / "result.json").write_text(json.dumps({
        "mode": "data_merge",
        "states": summary["states"],
        "n_states": summary["n_states"],
        "n_columns": summary["n_columns"],
        "csv_path": str(csv_path),
        "placeholders_md": str(md_path),
        "generated_files": [str(g) for g in generated],
        "output_dir": str(output_dir),
    }))
    log(f"[orchestrate] done — generated {len(generated)} .indd file(s)")


def main():
    payload = json.loads(sys.argv[1])
    mode = payload.get("mode") or "markup"

    try:
        return _dispatch(payload, mode)
    except BaseException as e:
        # Tee the traceback so the timing investigator (watching /tmp/pb_orchestrate.log)
        # can see what blew up. Also writes to stderr as before.
        import traceback as _tb
        tb_text = _tb.format_exc()
        print(tb_text, file=sys.stderr, flush=True)
        try:
            _tee("[orchestrate] !!! EXCEPTION !!!")
            for line in tb_text.rstrip().splitlines():
                _tee(line)
        except Exception:
            pass
        raise
    finally:
        # Always emit timing summary, even on error — that's when timing data
        # is most useful (which step blew up?).
        _timer.finalize(_LAST_WORK_DIR)


def _dispatch(payload, mode):
    # Mode dispatch — the original "markup" mode handles PDF-annotation →
    # InDesign edits. The "data_merge" mode is a separate pipeline: takes a
    # tagged template + Excel files, produces one .indd per data record.
    if mode == "data_merge":
        return main_data_merge(payload)
    if mode == "tag_template":
        return main_tag_template(payload)
    if mode == "restructure_styles":
        return main_restructure_styles(payload)
    if mode == "create_hyperlinks":
        return main_create_hyperlinks(payload)

    pdf_path = payload["pdfPath"]
    indd_path = payload["inddPath"]
    output_dir = payload["outputDir"]
    ref_files = payload.get("refFiles", []) or []
    settings = payload.get("settings") or {}

    # Pre-warm Ollama in a background thread so the model is loaded by the
    # time step 3b runs (~2s into the pipeline). Saves ~5s of cold-load
    # `load_duration` on the first Ollama call. Fire-and-forget — silently
    # no-ops if Ollama isn't running or the model isn't pulled.
    if settings.get("useOllama", True):
        try:
            from ollama_client import warmup as _ollama_warmup
            _ollama_warmup()
        except Exception:
            pass

    # Pick the engine based on the source file extension.
    engine = get_engine(indd_path)

    log(f"[orchestrate] PDF: {pdf_path}")
    log(f"[orchestrate] SOURCE ({engine.label}): {indd_path}")
    log(f"[orchestrate] OUT: {output_dir}")
    if ref_files:
        log(f"[orchestrate] REF FILES ({len(ref_files)}):")
        for rf in ref_files: log(f"[orchestrate]   - {rf}")

    Path(output_dir).mkdir(parents=True, exist_ok=True)

    # Set up a per-run scratch dir for all intermediates. Only the .indd /
    # .pdf deliverables go into output_dir; everything else (generated JSX,
    # logs, JSON dumps, findings) lives here so the user's job folder
    # stays clean. We emit a marker on stdout so the Electron main process
    # knows where to read findings/result from.
    work_dir = get_work_dir(output_dir, indd_path, settings.get("cacheRetention", DEFAULT_CACHE_RETENTION))
    log(f"[orchestrate] WORK: {work_dir}")
    _emit_work_dir(work_dir)
    if settings.get("run508Check"):
        log("[orchestrate] 508 compliance check: ENABLED")

    # 1. Extract annotations
    log("[orchestrate] step 1: extracting PDF annotations…")
    annotations = extract_annotations(pdf_path)
    log(f"[orchestrate]   found {len(annotations)} annotation(s)")
    annot_file = work_dir / "annotations.json"
    annot_file.write_text(json.dumps(annotations, indent=2))

    # 2. Copy .indd to working location with version-bumped filename.
    # The .indd lives in output_dir (it's a deliverable); InDesign opens
    # and saves it in place.
    base = Path(indd_path).stem
    new_base = bump_version(base)
    log(f"[orchestrate] output base name: {base} → {new_base}")
    work_indd = Path(output_dir) / f"{new_base}.indd"   # deliverable
    out_pdf   = Path(output_dir) / f"{new_base}.pdf"    # deliverable
    log_path        = work_dir / "apply_log.txt"
    flags_path      = work_dir / "flags_for_review.txt"
    findings_path   = work_dir / "findings.json"
    hyperlinks_path = work_dir / "hyperlinks.json"
    inspect_out     = work_dir / "doc_inspection.json"
    edits_path      = work_dir / "edits.json"

    if work_indd.exists():
        work_indd.unlink()
    shutil.copy(indd_path, work_indd)
    log(f"[orchestrate] copied .indd to {work_indd}")

    # 3. Inspect document → JSON
    log("[orchestrate] step 2: inspecting document structure…")
    inspect_jsx = work_dir / "inspect_doc.jsx"
    render_template(engine.inspect_template, {
        "__INDD_PATH__": str(work_indd),
        "__INSPECT_OUT_PATH__": str(inspect_out),
    }, inspect_jsx)
    proc = run_indesign_script(inspect_jsx, timeout=300, engine=engine)
    if proc.returncode != 0:
        log(f"[orchestrate] inspect step failed: {proc.stderr}")
        sys.exit(1)
    doc_inspection = {}
    try:
        doc_inspection = json.loads(inspect_out.read_text())
        log(f"[orchestrate]   inspected: {doc_inspection.get('page_count')} page(s), "
            f"{len(doc_inspection.get('hyperlinks', []))} hyperlink(s)")
    except Exception as e:
        log(f"[orchestrate]   inspection JSON parse failed: {e}")

    # Refine annotations using cell geometry: for any annotation falling
    # inside a table cell, re-clip its line_text to that single cell's
    # x-range. Replaces the brittle "40pt x-gap" cell-boundary heuristic
    # with InDesign's own cell column widths.
    try:
        refined = _refine_annotations_with_cell_geometry(annotations, doc_inspection, pdf_path)
        if refined:
            log(f"[orchestrate]   refined {refined} annotation line_text(s) using cell geometry")
    except Exception as e:
        log(f"[orchestrate]   line_text refinement skipped: {e}")

    # 3.5: Auto-discover reference files in the source folder if the annotations
    # reference a file ID (4-6 digit) that exists locally and the user didn't
    # already provide it via the UI.
    auto_discovered = auto_discover_ref_files(annotations, indd_path, ref_files)
    if auto_discovered:
        log(f"[orchestrate]   auto-discovered {len(auto_discovered)} ref file(s) in source folder:")
        for p in auto_discovered: log(f"[orchestrate]     + {Path(p).name}")
        ref_files = list(ref_files) + auto_discovered

    # 3.6: Inspect each reference file (basic metadata + content preview)
    log("[orchestrate] step 2.5: inspecting reference files…")
    ref_inventory = build_ref_inventory(ref_files)
    log(f"[orchestrate]   inspected {len(ref_inventory)} reference file(s)")
    if ref_inventory:
        (work_dir / "reference_inventory.json").write_text(json.dumps(ref_inventory, indent=2))

    # 4. Classify annotations — cascade: rule-based → Ollama → Claude
    sys.path.insert(0, str(HERE))
    edits_plan = run_classifier_cascade(annotations, doc_inspection, ref_inventory, log, settings)

    # Write QA config for the JSX to consume
    qa_config_path = work_dir / "qa_config.json"
    qa_config_path.write_text(json.dumps({
        "min_dpi":         settings.get("minDpi", 300),
        "max_fonts":       settings.get("maxFonts", 4),
        "body_size_pt":    settings.get("bodySize", 14),
        "disabled_checks": settings.get("disabledChecks", {}),
        "confidence":      settings.get("confidence", 0.6),
        "run_508_check":   bool(settings.get("run508Check", False)),
    }))
    edits_path.write_text(json.dumps(edits_plan, indent=2))
    log(f"[orchestrate]   {len(edits_plan.get('edits', []))} edit op(s), "
        f"{len(edits_plan.get('human_notes', []))} human note(s)")

    # 5. Generate and run apply_edits_v2.jsx
    log("[orchestrate] step 4: applying edits + QA scan in InDesign…")
    apply_jsx = work_dir / "apply_edits_v2.jsx"
    style_proposals_path     = work_dir / "style_proposals.json"
    hyperlink_proposals_path = work_dir / "hyperlink_proposals.json"
    render_template(engine.apply_template, {
        "__INDD_PATH__":                 str(work_indd),
        "__PDF_OUT_PATH__":              str(out_pdf),
        "__LOG_PATH__":                  str(log_path),
        "__FLAGS_PATH__":                str(flags_path),
        "__FINDINGS_PATH__":             str(findings_path),
        "__HYPERLINKS_PATH__":           str(hyperlinks_path),
        "__EDITS_PATH__":                str(edits_path),
        "__QA_CONFIG_PATH__":            str(qa_config_path),
        "__STYLE_PROPOSALS_PATH__":      str(style_proposals_path),
        "__HYPERLINK_PROPOSALS_PATH__":  str(hyperlink_proposals_path),
    }, apply_jsx)
    proc = run_indesign_script(apply_jsx, engine=engine)
    if proc.returncode != 0:
        log(f"[orchestrate] apply step failed: {proc.stderr}")
        sys.exit(proc.returncode)

    # Forward the JSX's sub-step timing breakdown so it shows up in our
    # tee log alongside the top-level summary. Lets us see where step 4's
    # seconds went (open doc / apply edits / canon / QA / 508 / save+export).
    try:
        if Path(log_path).exists():
            for line in Path(log_path).read_text(errors="replace").splitlines():
                if "[jsx-timing]" in line:
                    log("[orchestrate]   " + line.strip())
    except Exception:
        pass

    # 5b. Scan apply_log.txt for ExtendScript errors that would otherwise be
    # silently swallowed by enclosing try/catch blocks (SyntaxError, ReferenceError,
    # etc.). Surface them as findings so the user — and we — see them.
    jsx_err_findings = scan_apply_log_for_jsx_errors(log_path)
    if jsx_err_findings:
        log(f"[orchestrate] apply_log scan found {len(jsx_err_findings)} JSX runtime issue(s):")
        for f in jsx_err_findings:
            log(f"[orchestrate]   [{f['severity']}] {f['id']}: {f['message'][:160]}")
        merge_findings(findings_path, jsx_err_findings)

    # 6. Python-side QA checks (Box search, hyperlink reachability, spellcheck)
    log("[orchestrate] step 5: Python-side QA checks…")
    py_findings = run_python_qa_checks(work_dir, output_dir)
    if py_findings:
        merge_findings(findings_path, py_findings)

    # 7. Auto-relink: for each LINK_MISSING with an exact-filename Box match,
    # apply the relink and re-export. Skipped for engines without a relink
    # template (currently only InDesign has one).
    if settings.get("autoRelink", True) and engine.relink_template:
        relinked = run_auto_relink(work_dir, work_indd, out_pdf, log_path, log, engine)
        if relinked:
            log(f"[orchestrate]   auto-relinked {len(relinked)} missing asset(s); PDF re-exported")

    # 7b. Hi-res image swap: if the user provided a hi-res images folder,
    # find every placed image whose filename looks like a watermarked
    # stock-photo comp (Getty / AdobeStock / Shutterstock / iStock pattern)
    # and re-link to the matching hi-res file by photo ID.
    hires_folder = payload.get("hiResImagesFolder")
    if hires_folder and engine.relink_template:
        run_hires_swap(work_dir, work_indd, out_pdf, log_path, log,
                       doc_inspection, hires_folder, engine)

    # 8. Auto-activate fonts: for each FONT_UNAVAILABLE finding, try
    # FontExplorer X Pro activation; for the rest, surface Adobe Fonts URL.
    if settings.get("autoActivateFonts", True):
        run_font_activation(work_dir, work_indd, out_pdf, log_path, log, engine)

    # Write result.json into the work_dir (the Electron main process reads
    # it from there via the [work_dir] stdout marker).
    (work_dir / "result.json").write_text(json.dumps({
        "indd_out": str(work_indd),
        "pdf_out": str(out_pdf),
        "base_name": new_base,
        "work_dir": str(work_dir),
        "style_proposals_path":     str(style_proposals_path)     if style_proposals_path.exists()     else None,
        "hyperlink_proposals_path": str(hyperlink_proposals_path) if hyperlink_proposals_path.exists() else None,
    }))

    log("[orchestrate] done")


def run_classifier_cascade(annotations, doc_inspection, ref_inventory, log_fn, settings=None):
    settings = settings or {}
    """Cascade: 1) rule-based local (always); 2) for HUMAN_REVIEW results, escalate
    to Ollama if running; 3) for any still-unresolved, escalate to Claude if API key.
    Each annotation is classified by the highest-quality classifier that resolved it."""
    log_fn("[orchestrate] step 3a: rule-based local classifier…")
    from local_classifier import classify_edits_local
    plan = classify_edits_local(annotations, doc_inspection, ref_inventory)
    rule_resolved = sum(1 for e in plan["edits"] if e["op"] != "HUMAN_REVIEW")
    log_fn(f"[orchestrate]   rule-based resolved {rule_resolved}/{len(plan['edits'])}")

    # Identify annotations eligible for LLM escalation. Skip those the rule-based
    # classifier explicitly marked _no_escalate (short / non-instructional content
    # that LLMs tend to hallucinate ops on).
    unresolved = []
    for i, edit in enumerate(plan["edits"]):
        if edit.get("op") != "HUMAN_REVIEW":
            continue
        if edit.get("_no_escalate"):
            continue
        src = edit.get("source_annotation", "")
        for ann in annotations:
            if ann.get("content", "").startswith(src[:50]):
                unresolved.append((i, ann))
                break
    if not unresolved:
        return plan

    # Try Ollama for unresolved (if enabled in settings)
    use_ollama = settings.get("useOllama", True)
    ollama_model = settings.get("ollamaModel") or "llama3.1:8b"
    if ollama_model:
        os.environ["OLLAMA_MODEL"] = ollama_model
    try:
        from ollama_client import is_running, classify_annotations as ollama_classify
        if use_ollama and is_running():
            log_fn(f"[orchestrate]   Ollama model: {ollama_model}")
            log_fn(f"[orchestrate] step 3b: Ollama escalation for {len(unresolved)} unresolved annotation(s)…")
            ollama_plan = ollama_classify([a for _, a in unresolved], doc_inspection, ref_inventory)
            if ollama_plan and ollama_plan.get("edits"):
                upgraded = 0
                for j, (orig_idx, _ann) in enumerate(unresolved):
                    new_op = ollama_plan["edits"][j] if j < len(ollama_plan["edits"]) else None
                    if new_op and new_op["op"] != "HUMAN_REVIEW":
                        plan["edits"][orig_idx] = new_op
                        upgraded += 1
                log_fn(f"[orchestrate]   Ollama upgraded {upgraded}/{len(unresolved)}")
                # Re-compute unresolved
                unresolved = [(i, ann) for i, ann in unresolved if plan["edits"][i]["op"] == "HUMAN_REVIEW"]
    except Exception as e:
        log_fn(f"[orchestrate]   Ollama step skipped: {e}")

    return plan


def run_hires_swap(work_dir, work_indd, out_pdf, log_path, log_fn,
                   doc_inspection, hires_folder, engine=None):
    """For every placed image whose filename looks like a watermarked stock
    comp, search `hires_folder` for a hi-res counterpart (matched by photo
    ID) and re-link via the existing relink.jsx pipeline. Also re-exports
    the PDF so the final output uses the hi-res versions.

    Surfaces findings as IMG_HIRES_SWAPPED (info, autoFix=True) per swap and
    IMG_HIRES_NOT_FOUND (warning) for stock comps with no match.
    """
    sys.path.insert(0, str(HERE))
    try:
        from hires_swap import plan_swaps, looks_like_stock_comp, extract_photo_id
    except Exception as e:
        log_fn(f"[orchestrate]   hi-res swap: import failed: {e}")
        return []

    placed = (doc_inspection or {}).get("placed_images") or []
    placed_paths = [p.get("path") or p.get("name") or "" for p in placed]
    if not placed_paths:
        log_fn("[orchestrate]   hi-res swap: no placed images in inspection — skipping")
        return []

    swaps = plan_swaps(placed_paths, hires_folder)
    log_fn(f"[orchestrate] step 7b: hi-res swap — folder={hires_folder}")
    log_fn(f"[orchestrate]   placed images: {len(placed_paths)}, "
           f"stock comps: {sum(1 for p in placed_paths if looks_like_stock_comp(Path(p).name))}, "
           f"matched: {len(swaps)}")

    findings_path = Path(work_dir) / "findings.json"

    # Surface "no match" findings for stock comps that had no hi-res hit.
    matched_names = {s["source_filename"] for s in swaps}
    not_found = []
    for p in placed_paths:
        name = Path(p).name
        if not looks_like_stock_comp(name):
            continue
        if name in matched_names:
            continue
        pid = extract_photo_id(name)
        not_found.append({"name": name, "id": pid or ""})

    if not_found:
        sample = ", ".join(n["name"] for n in not_found[:5])
        merge_findings(findings_path, [{
            "severity": "warning",
            "id": "IMG_HIRES_NOT_FOUND",
            "category": "links",
            "location": "doc",
            "message": f"{len(not_found)} stock-photo comp(s) had no hi-res match in folder: {sample}",
            "autoFix": False,
            "fixAction": "Verify the hi-res folder contains the licensed versions, "
                         "or download the hi-res files into Box first.",
        }])

    if not swaps:
        return []

    # Write relinks.json + run relink.jsx (same template as auto-relink)
    relinks_path = Path(work_dir) / "relinks_hires.json"
    relinks_path.write_text(json.dumps(swaps, indent=2))

    relink_jsx = Path(work_dir) / "relink_hires.jsx"
    render_template(engine.relink_template, {
        "__INDD_PATH__":    str(work_indd),
        "__PDF_OUT_PATH__": str(out_pdf),
        "__RELINKS_PATH__": str(relinks_path),
        "__LOG_PATH__":     str(log_path),
    }, relink_jsx)
    proc = run_indesign_script(relink_jsx, timeout=600, engine=engine)
    if proc.returncode != 0:
        log_fn(f"[orchestrate]   hi-res swap relink failed: {proc.stderr}")
        return []

    # Surface success findings — one summary entry plus per-swap detail
    sample = ", ".join(s["source_filename"] for s in swaps[:5])
    merge_findings(findings_path, [{
        "severity": "info",
        "id": "IMG_HIRES_SWAPPED",
        "category": "links",
        "location": "doc",
        "message": f"Auto-swapped {len(swaps)} watermarked comp(s) → hi-res: {sample}",
        "autoFix": True,
        "fixAction": "Verify each replacement matches the design intent.",
    }])
    log_fn(f"[orchestrate]   hi-res swap: relinked {len(swaps)} image(s); PDF re-exported")
    return swaps


def run_auto_relink(work_dir, work_indd, out_pdf, log_path, log_fn, engine=None):
    """For every LINK_MISSING finding, search Box for an exact filename match.
    If found, write a relinks.json and run relink.jsx to apply + re-export.
    Returns list of successfully relinked filenames.
    """
    sys.path.insert(0, str(HERE))
    try:
        from qa_checks.check_link_recovery import parse_missing_links_from_findings, search_box
    except Exception as e:
        log_fn(f"[orchestrate]   auto-relink: import failed: {e}")
        return []

    findings_path = Path(work_dir) / "findings.json"
    missing = parse_missing_links_from_findings(findings_path)
    if not missing:
        return []

    candidates = []
    for filename in missing:
        results = search_box(filename)
        # Pick the result whose basename exactly matches (case-sensitive)
        exact = [r for r in results if Path(r).name == filename]
        if exact:
            candidates.append({"source_filename": filename, "target_path": exact[0]})

    if not candidates:
        log_fn("[orchestrate]   auto-relink: no exact Box matches for missing links")
        return []

    log_fn(f"[orchestrate] step 6: auto-relinking {len(candidates)} missing asset(s)…")
    relinks_path = Path(work_dir) / "relinks.json"
    relinks_path.write_text(json.dumps(candidates, indent=2))

    relink_jsx = Path(work_dir) / "relink.jsx"
    render_template(engine.relink_template, {
        "__INDD_PATH__":    str(work_indd),
        "__PDF_OUT_PATH__": str(out_pdf),
        "__RELINKS_PATH__": str(relinks_path),
        "__LOG_PATH__":     str(log_path),
    }, relink_jsx)
    proc = run_indesign_script(relink_jsx, timeout=600, engine=engine)
    if proc.returncode != 0:
        log_fn(f"[orchestrate]   auto-relink failed: {proc.stderr}")
        return []

    # Update findings.json: append AUTO_RELINKED entries, downgrade or remove
    # the LINK_MISSING entries that were satisfied
    try:
        existing = json.loads(findings_path.read_text())
    except Exception:
        existing = {"findings": []}

    relinked_names = {c["source_filename"] for c in candidates}
    new_findings = []
    for f in existing.get("findings", []):
        if f.get("id") == "LINK_MISSING":
            msg = f.get("message", "")
            after = msg.split(":", 1)[-1] if ":" in msg else msg
            still_missing = [n.strip() for n in after.split(",") if n.strip() and n.strip() not in relinked_names]
            if not still_missing:
                continue  # all relinked → drop the original error
            # Re-emit with reduced list
            new_findings.append({
                **f,
                "message": f"{len(still_missing)} missing link(s) (still): " + ", ".join(still_missing),
            })
        else:
            new_findings.append(f)
    for c in candidates:
        new_findings.append({
            "severity": "info",
            "id": "LINK_AUTO_RELINKED",
            "category": "links",
            "location": c["source_filename"],
            "message": f"Auto-relinked '{c['source_filename']}' → {c['target_path']}",
            "autoFix": True,
            "fixAction": "Verify the relinked asset matches the design intent.",
        })
    findings_path.write_text(json.dumps({"findings": new_findings}, indent=2))

    return list(relinked_names)


def run_font_activation(work_dir, work_indd, out_pdf, log_path, log_fn, engine=None):
    """Activate any FONT_UNAVAILABLE fonts via FontExplorer X Pro.
    For ones that can't be activated locally, append a finding with the
    Adobe Fonts URL. If anything was activated, re-export the PDF.
    """
    sys.path.insert(0, str(HERE))
    try:
        from font_activator import activate_missing_fonts
    except Exception as e:
        log_fn(f"[orchestrate]   font-activator import failed: {e}")
        return

    findings_path = Path(work_dir) / "findings.json"
    result = activate_missing_fonts(findings_path)
    activated = result.get("activated", [])
    suggested = result.get("suggested", [])

    if not activated and not suggested:
        return

    log_fn(f"[orchestrate] step 7: font activation — activated {len(activated)}, surfaced {len(suggested)} suggestion(s)")

    # Re-export PDF if any fonts were activated (so they're embedded properly).
    # Skipped for engines without a re-export template (apply step handles it).
    if activated and engine and engine.reexport_template:
        reexport_jsx = Path(work_dir) / "re_export.jsx"
        render_template(engine.reexport_template, {
            "__INDD_PATH__":    str(work_indd),
            "__PDF_OUT_PATH__": str(out_pdf),
            "__LOG_PATH__":     str(log_path),
        }, reexport_jsx)
        # Brief delay to let FontExplorer finish loading fonts
        import time; time.sleep(2)
        proc = run_indesign_script(reexport_jsx, timeout=300, engine=engine)
        if proc.returncode != 0:
            log_fn(f"[orchestrate]   re-export after font activation failed: {proc.stderr}")

    # Update findings.json
    try:
        existing = json.loads(findings_path.read_text())
    except Exception:
        existing = {"findings": []}

    activated_set = {a["font"] for a in activated}
    suggested_set = {s["font"] for s in suggested}
    new_findings = []
    for f in existing.get("findings", []):
        if f.get("id") == "FONT_UNAVAILABLE":
            msg = f.get("message", "")
            after = msg.split(":", 1)[-1] if ":" in msg else msg
            still_missing = [n.strip() for n in after.split(",") if n.strip() and n.strip() in suggested_set]
            if not still_missing:
                continue  # all activated → drop the original error
            new_findings.append({
                **f,
                "message": f"{len(still_missing)} font(s) still not activated: " + ", ".join(still_missing),
            })
        else:
            new_findings.append(f)
    for a in activated:
        new_findings.append({
            "severity": "info", "id": "FONT_AUTO_ACTIVATED", "category": "fonts",
            "location": a["font"],
            "message": f"Auto-activated '{a['font']}' from {a['source']}; PDF re-exported.",
            "autoFix": True, "fixAction": "Verify the font matches your design intent.",
        })
    for s in suggested:
        new_findings.append({
            "severity": "warning", "id": "FONT_ADOBE_FONTS_URL", "category": "fonts",
            "location": s["font"],
            "message": f"Font '{s['font']}' not in FontExplorer or Box. Adobe Fonts: {s['adobe_fonts_url']}",
            "autoFix": False,
            "fixAction": f"Visit {s['adobe_fonts_url']} and click Activate; then re-run.",
        })
    findings_path.write_text(json.dumps({"findings": new_findings}, indent=2))


def auto_discover_ref_files(annotations, indd_path, already_provided):
    """If annotations contain '4-6 digit file ID' references and matching .indd
    or .pdf files exist in the source folder (NOT already in already_provided),
    add them to the reference list automatically."""
    import re as _re
    already = {Path(p).resolve() for p in (already_provided or [])}
    src_folder = Path(indd_path).parent
    if not src_folder.exists():
        return []

    # Collect IDs mentioned in annotations
    ids = set()
    for a in annotations:
        for m in _re.finditer(r"\b(\d{4,6})\b", a.get("content", "") or ""):
            ids.add(m.group(1))
    if not ids:
        return []

    discovered = []
    seen = set()
    for ext in (".indd", ".pdf", ".ai", ".psd", ".jpg", ".jpeg", ".png", ".tif", ".tiff"):
        for p in src_folder.glob(f"*{ext}"):
            if p.resolve() in already:
                continue
            # Don't pick up the input file itself
            if p.resolve() == Path(indd_path).resolve():
                continue
            for fid in ids:
                if fid in p.name:
                    rp = str(p.resolve())
                    if rp not in seen:
                        seen.add(rp)
                        discovered.append(rp)
                    break
    return discovered


def build_ref_inventory(ref_paths):
    """For each reference file, capture basic metadata + a content hint so
    Claude can match annotations to the right file. Multiple files supported.
    Returns: list of { path, name, ext, type, page_count?, text_preview?, image_dims? }"""
    inventory = []
    for path in ref_paths:
        p = Path(path)
        if not p.exists():
            continue
        ext = p.suffix.lower().lstrip(".")
        item = {"path": str(p), "name": p.name, "ext": ext, "size_kb": round(p.stat().st_size / 1024)}
        # Categorize
        if ext == "indd":
            item["type"] = "indesign_document"
            # Can't easily inspect .indd from Python without InDesign; let executor handle on placement
            item["hint"] = "InDesign document — use APPEND_PAGES_FROM_INDD or PLACE_PAGE_FROM_INDD"
        elif ext == "pdf":
            item["type"] = "pdf"
            try:
                from pdf_text import quick_pdf_info
                info = quick_pdf_info(str(p))
                if "page_count" in info:
                    item["page_count"] = info["page_count"]
                if "first_page_preview" in info and info["first_page_preview"]:
                    item["text_preview"] = info["first_page_preview"]
            except Exception:
                pass
            item["hint"] = "PDF — use PLACE_ASSET_NEW_PAGE or PLACE_ASSET_IN_FRAME"
        elif ext in ("ai",):
            item["type"] = "illustrator"
            item["hint"] = "Illustrator file — use PLACE_ASSET_NEW_PAGE or PLACE_ASSET_IN_FRAME"
        elif ext == "psd":
            item["type"] = "photoshop"
            item["hint"] = "Photoshop file — use PLACE_ASSET_IN_FRAME"
        elif ext in ("jpg", "jpeg", "png", "tif", "tiff"):
            item["type"] = "raster_image"
            try:
                from pdf_text import quick_image_dims
                dims = quick_image_dims(str(p))
                if dims:
                    item["image_dims"] = list(dims)
            except Exception:
                pass
            item["hint"] = "Raster image — use PLACE_ASSET_IN_FRAME"
        else:
            item["type"] = "unknown"
        inventory.append(item)
    return inventory


def run_python_qa_checks(work_dir, deliverables_dir):
    """Run each Python QA check.

    work_dir          → where intermediates live (hyperlinks.json, findings.json)
    deliverables_dir  → where .indd/.pdf live (some checks read the PDF)

    Each module's run() takes (work_dir, deliverables_dir). For backwards
    compatibility we fall back to a single-arg call if a module's signature
    hasn't been updated yet.
    """
    import inspect as _inspect
    findings = []
    sys.path.insert(0, str(HERE))
    for module_name in ["check_hyperlinks_reachability", "check_spelling", "check_link_recovery"]:
        t0 = time.perf_counter()
        try:
            mod = __import__(f"qa_checks.{module_name}", fromlist=["run"])
            sig = _inspect.signature(mod.run)
            if len(sig.parameters) >= 2:
                mod_findings = mod.run(work_dir, deliverables_dir)
            else:
                # Legacy single-arg signature — pass work_dir; modules that
                # need the PDF will fail gracefully.
                mod_findings = mod.run(work_dir)
            findings += mod_findings
            dt = time.perf_counter() - t0
            log(f"[orchestrate]   {module_name}: ok in {dt:.2f}s ({len(mod_findings)} finding(s))")
        except Exception as e:
            dt = time.perf_counter() - t0
            log(f"[orchestrate]   {module_name}: failed in {dt:.2f}s ({e})")
    return findings


def merge_findings(findings_json_path, additional):
    try:
        existing = json.loads(Path(findings_json_path).read_text())
    except Exception:
        existing = {"findings": []}
    existing.setdefault("findings", []).extend(additional)
    Path(findings_json_path).write_text(json.dumps(existing, indent=2))


if __name__ == "__main__":
    main()
