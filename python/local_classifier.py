"""Rule-based annotation classifier — works fully offline, no API needed.

For each PDF annotation, attempts to recognize common production-markup patterns
and emit a structured edit op. Anything ambiguous routes to HUMAN_REVIEW.

This is the default classifier when ANTHROPIC_API_KEY is not set. It handles
~70-80% of typical jobs; the rest goes to human review and you fix them manually.
"""
import os
import re
from pathlib import Path


EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
PHONE_RE = re.compile(r"\d{3}[\s.-]?\d{3}[\s.-]?\d{4}")
URL_RE   = re.compile(r"https?://\S+|www\.\S+")
TERRITORY_HINTS = re.compile(r"\b(?:Northern|Southern|Eastern|Western|Central|Southeastern|Southwestern|Northeastern|Northwestern|Upper Peninsula|Lower Peninsula|Thumb)\b", re.I)
CHECK_HINT = re.compile(r"\b(?:check\s*-?\s*mark|certified|yes|✓|checkmark)\b", re.I)


def detect_column_types(doc_inspection):
    """For each table, infer column types from the first body row.
    Returns dict: { table_id → [column_type per col] }, where types are:
      'email', 'phone', 'territory', 'check', 'name', 'text'
    """
    out = {}
    for page in doc_inspection.get("pages", []):
        for frame in page.get("frames", []):
            for tbl in frame.get("tables", []):
                types = []
                for cell in tbl.get("firstBodyRow", []):
                    contents = cell.get("contents", "") or ""
                    if EMAIL_RE.search(contents):
                        types.append("email")
                    elif PHONE_RE.search(contents):
                        types.append("phone")
                    elif TERRITORY_HINTS.search(contents):
                        types.append("territory")
                    elif len(contents.strip()) <= 2 or contents.strip() == "":
                        # Short/empty cells are usually check-mark or boolean columns
                        types.append("check")
                    else:
                        types.append("text")  # name / company / generic
                out[tbl["id"]] = types
    return out


def find_table_for_annotation(annotation, doc_inspection):
    """Best-effort match an annotation to a table id.
    For now: pick the largest table on the same page if available."""
    page_num = annotation.get("page", 1)
    candidates = []
    for page in doc_inspection.get("pages", []):
        if page.get("page") != page_num:
            continue
        for frame in page.get("frames", []):
            for tbl in frame.get("tables", []):
                candidates.append(tbl)
    if not candidates:
        # Pick first table anywhere
        for page in doc_inspection.get("pages", []):
            for frame in page.get("frames", []):
                for tbl in frame.get("tables", []):
                    candidates.append(tbl)
    if not candidates:
        return None
    candidates.sort(key=lambda t: t.get("rows", 0), reverse=True)
    return candidates[0]


def parse_add_row(annotation_content, table, column_types):
    """Parse a 'Please add: ...' annotation into structured row values.

    Strategy: split the body by newlines, classify each line by content type
    (email, phone, territory, check-marker, plain text), then map each to its
    column based on column_types.
    """
    body = re.sub(r"^\s*please\s+add\s*:?\s*", "", annotation_content, flags=re.I).strip()
    # Strip out 'Note: ...' tail blocks (those are human notes, not row data)
    notes = []
    parts = re.split(r"\bNote\s*:", body, maxsplit=1, flags=re.I)
    body_main = parts[0].strip()
    if len(parts) > 1:
        notes.append("Note: " + parts[1].strip())

    # Split into lines or by clear separators
    lines = [ln.strip() for ln in re.split(r"[\r\n]+", body_main) if ln.strip()]
    # If the markup ran together, try to split by capital-letter starts as a heuristic
    if len(lines) == 1 and len(lines[0]) > 30:
        # Insert split before phone numbers and emails
        text = lines[0]
        text = re.sub(r"(?<=\S)(\d{3}[\s.-]?\d{3}[\s.-]?\d{4})", r"\n\1", text)
        text = re.sub(r"(?<=\S)([\w.+-]+@[\w.-]+)", r"\n\1", text)
        lines = [ln.strip() for ln in text.split("\n") if ln.strip()]

    if not lines:
        return None, notes

    # Classify each line
    classified = []
    for ln in lines:
        if EMAIL_RE.search(ln):
            classified.append(("email", ln))
        elif PHONE_RE.search(ln) and len(ln) < 30:
            classified.append(("phone", ln))
        elif TERRITORY_HINTS.search(ln):
            classified.append(("territory", ln))
        elif CHECK_HINT.search(ln):
            classified.append(("check", "✓" if re.search(r"yes|✓|check", ln, re.I) else ""))
        else:
            classified.append(("text", ln))
    # Map to column order. For each column type, find the next matching classified line.
    used = [False] * len(classified)
    values = []
    for col_idx, col_type in enumerate(column_types):
        match_idx = None
        for i, (cls, val) in enumerate(classified):
            if used[i]:
                continue
            if col_type == cls:
                match_idx = i
                break
        if match_idx is None:
            # If not found by type, use next unused 'text' line for the column
            for i, (cls, val) in enumerate(classified):
                if used[i] or cls != "text":
                    continue
                match_idx = i
                break
        if match_idx is not None:
            used[match_idx] = True
            val = classified[match_idx][1]
            # For email/phone, extract the actual value
            if col_type == "email":
                m = EMAIL_RE.search(val); val = m.group(0) if m else val
            elif col_type == "phone":
                m = PHONE_RE.search(val); val = m.group(0) if m else val
            values.append(val)
        else:
            values.append("")
    return values, notes


_NOTE_PREFIXES = re.compile(r"^\s*(note|fyi|info|please\s+see|comment)\s*[:.,]?", re.I)
_SINGLE_CAPITALIZED_WORD = re.compile(r"^[A-Z][a-z]+$")
_TWO_CAP_WORDS = re.compile(r"^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}$")  # "Bay Fixtures", "Lumen Ranges"


def is_actionable(content):
    """Heuristic: route obvious non-instructions directly to HUMAN_REVIEW
    without sending to LLMs (they hallucinate ops on bare nouns).

    Block only clear non-instructions:
      - Very short fragments (<5 chars: "for", "and", "s", "the")
      - Reviewer name stamps ("Marked set by …")
      - Single capitalized words ("Program", "Subtype", "Fixtures")
      - Two-to-three capitalized words with no punctuation/verbs
        ("Bay Fixtures", "Lumen Ranges", "All Lumen Ranges") — likely
        text-selection stamps from Acrobat
      - Note prefixes ("Note:", "FYI:", …)

    Everything longer or with sentence-like punctuation/verbs goes to Ollama,
    where stricter validation will catch any hallucinated ops.
    """
    s = (content or "").strip()
    if len(s) < 5:
        return False
    if _NOTE_PREFIXES.match(s):
        return False
    if re.match(r"^Marked set by\b", s, re.I):
        return False
    if _SINGLE_CAPITALIZED_WORD.match(s):
        return False
    if _TWO_CAP_WORDS.match(s):
        return False
    return True


def classify_annotation(annotation, doc_inspection, reference_files, column_types_by_table):
    """Returns a list of edit ops (zero or more), plus list of human notes."""
    content = (annotation.get("content") or "").strip()
    edits = []
    notes = []

    # ---- Strikethrough / Underline / Highlight markup-only annotations ----
    # Reviewer marks text directly on the page (no sticky-note text). Intent is
    # encoded by the annotation TYPE, not the content.
    atype = annotation.get("type")
    marked = (annotation.get("marked_text") or "").strip()
    if marked and atype in ("StrikeOut", "Underline", "Squiggly", "Highlight"):
        if atype == "StrikeOut":
            # Delete the marked text. Also clean up doubled spaces it may leave.
            edits.append({
                "op": "REPLACE_TEXT",
                "target": {"find": marked},
                "params": {"replace_with": ""},
                "confidence": 0.88,
                "rationale": f"Strikethrough annotation → delete '{marked[:50]}'",
                "source_annotation": f"[StrikeOut on page {annotation.get('page')}]",
            })
            return edits, notes
        else:
            # Highlight/Underline are usually emphasis cues, not edits. Surface
            # for human review with the marked text so they know what got flagged.
            notes.append(f"[{atype} on page {annotation.get('page')}] '{marked[:120]}'")
            return edits, notes

    if not content:
        return [], []

    # ---- Reviewer convention: sticky note containing replacement text ----
    # When a reviewer places a sticky note next to a word/phrase and the
    # comment is a replacement word/phrase/symbol, the convention is
    # "replace what's there with this — but ONLY this specific instance,
    # not all occurrences in the doc."
    #
    # To avoid replacing every "&" or every "fixture" in the document, we
    # ALWAYS scope the find string to the surrounding line context. The
    # find = the entire line text the reviewer marked up; replace_with =
    # the same line with the targeted word/phrase substituted.
    nearby = (annotation.get("nearby_text") or "").strip()
    line_text = (annotation.get("line_text") or "").strip()
    if nearby or line_text:
        edit = _try_scoped_replace(content, nearby, line_text)
        if edit:
            edit["source_annotation"] = content[:200]
            edits.append(edit)
            return edits, notes

    # Pre-filter: non-actionable content routes to HUMAN_REVIEW with no-escalate flag
    if not is_actionable(content):
        if _NOTE_PREFIXES.match(content) or re.match(r"^Marked set by\b", content, re.I):
            notes.append(content)
            return [], notes
        rev = _human_review(content, "Annotation too short or no actionable verb (likely a selection stamp); routed to manual review")
        rev["_no_escalate"] = True
        edits.append(rev)
        return edits, notes

    table = find_table_for_annotation(annotation, doc_inspection)
    table_id = table["id"] if table else None
    column_types = column_types_by_table.get(table_id, []) if table_id else []

    # ---- Pattern: "Add a check mark for/to X" → SET_CELL_VALUE
    # (check this BEFORE the "Please add: ..." row pattern, since markup often
    # says "Please add an EnergyStar Certified check mark for X" which is a cell
    # set, not a new row)
    m = re.search(r"add\s+(?:an?\s+)?(?:energy\s*star\s+)?(?:certified\s+)?check(?:\s*-?\s*mark)?\s+(?:for|to|next to)\s+(.+)", content, re.I)
    if m and table_id:
        target_name = m.group(1).strip().rstrip(".")
        check_col = None
        for i, t in enumerate(column_types):
            if t == "check": check_col = i; break
        if check_col is None and column_types:
            check_col = len(column_types) - 1
        if check_col is not None:
            edits.append({
                "op": "SET_CELL_VALUE",
                "target": {"table_id": table_id, "row_match": target_name, "column": check_col},
                "params": {"text": "✓"},
                "confidence": 0.85,
                "rationale": "Matched 'add check mark to X' pattern",
                "source_annotation": content[:200],
            })
            return edits, notes

    # ---- Pattern: "Please add: <multi-line data>" → ADD_TABLE_ROW
    if re.match(r"^\s*please\s+add\s*:", content, re.I) or (
        re.match(r"^\s*please\s+add\b", content, re.I) and "\n" in content
    ):
        if table_id and column_types:
            values, parsed_notes = parse_add_row(content, table, column_types)
            notes.extend(parsed_notes)
            if values:
                edits.append({
                    "op": "ADD_TABLE_ROW",
                    "target": {"table_id": table_id},
                    "params": {"values": values},
                    "confidence": 0.75,
                    "rationale": "Matched 'Please add: <data>' pattern; mapped lines to columns by inferred type",
                    "source_annotation": content[:200],
                })
                return edits, notes
        edits.append(_human_review(content, "Could not parse 'Please add' annotation into row values"))
        return edits, notes

    # ---- Pattern: "Delete this page" / "Remove this page" → DELETE_PAGE
    if re.match(r"^\s*(delete|remove)\s+this\s+page", content, re.I):
        page = annotation.get("page")
        if page:
            edits.append({
                "op": "DELETE_PAGE",
                "target": {"page": page},
                "params": {},
                "confidence": 0.85,
                "rationale": f"'{content[:30]}...' instruction → remove page {page}",
                "source_annotation": content[:200],
            })
            return edits, notes

    # ---- Pattern: appending another .indd via reference file ID
    # → APPEND_PAGES_FROM_INDD (matched against reference_files by ID)
    # Triggers when the annotation contains both an "add/append/include" verb
    # AND a 4-6 digit file ID that matches a reference file's filename.
    m_append = None
    if re.search(r"\b(add|append|attach|insert|include|place)\b", content, re.I):
        # Find any 4-6 digit ID in the annotation
        m_append = re.search(r"\b(?:file\s+)?(\d{4,6})\b", content)
    if m_append and reference_files:
        file_id = m_append.group(1)
        # Find a reference file whose name contains this ID and is an .indd
        match_ref = None
        for rf in reference_files:
            name = rf.get("name", "")
            if file_id in name and rf.get("ext") == "indd":
                match_ref = rf
                break
        if match_ref:
            # Extract a heading from the annotation if it quotes a section title
            heading = None
            m_quote = re.search(r'"([A-Za-z][^"]{2,80})"', content)
            if m_quote:
                heading = m_quote.group(1).strip()
            else:
                m_curly = re.search(r'“([^”]{3,80})”', content)
                if m_curly:
                    heading = m_curly.group(1).strip()
            edits.append({
                "op": "APPEND_PAGES_FROM_INDD",
                "target": {"file_path": match_ref["path"]},
                "params": {"heading": heading} if heading else {},
                "confidence": 0.90,
                "rationale": f"Annotation references file ID {file_id}; matched to reference '{match_ref['name']}'" + (f"; extracted heading: '{heading}'" if heading else ""),
                "source_annotation": content[:200],
            })
            return edits, notes
        else:
            edits.append(_human_review(content,
                f"Annotation references file ID {file_id}, but no matching .indd in reference files. "
                f"Add it via the Reference files picker and re-run."))
            return edits, notes

    # ---- Pattern: "alphabetical order" / "sort" → SORT_TABLE
    if re.search(r"\b(?:alphabetical(?:ly)?|alpha\s+order|sort\s+(?:these|all|the))\b", content, re.I) and table_id:
        edits.append({
            "op": "SORT_TABLE",
            "target": {"table_id": table_id},
            "params": {"column": 0, "ascending": True},
            "confidence": 0.85,
            "rationale": "Matched 'alphabetical/sort' pattern",
            "source_annotation": content[:200],
        })
        # Don't return — there may be additional instructions in the same annotation
        # e.g., "and alternate rows dark/light" — that part goes to human review
        if re.search(r"alternat\w+\s+(?:row|fill|color|grey|gray|light|dark)", content, re.I):
            notes.append("Layout note: " + content)
        return edits, notes

    # ---- Pattern: "replace X with Y" / "change X to Y" → REPLACE_TEXT
    m = re.search(r"(?:replace|change|update)\s+[\"\'']?([^\"\'']{2,80})[\"\'']?\s+(?:with|to)\s+[\"\'']?([^\"\'']{1,80})[\"\'']?", content, re.I)
    if m:
        edits.append({
            "op": "REPLACE_TEXT",
            "target": {"find": m.group(1).strip()},
            "params": {"replace_with": m.group(2).strip()},
            "confidence": 0.7,
            "rationale": "Matched 'replace/change X to Y' pattern",
            "source_annotation": content[:200],
        })
        return edits, notes

    # ---- Pattern: reference-file placement
    if reference_files and re.search(r"\b(?:add|append|place|insert|attach)\b", content, re.I):
        # Try to match by filename overlap
        match_ref = _match_reference_file(content, reference_files)
        if match_ref:
            ext = match_ref.get("ext", "").lower()
            if ext == "indd" and re.search(r"\b(?:end|after|append|attach)\b", content, re.I):
                edits.append({
                    "op": "APPEND_PAGES_FROM_INDD",
                    "target": {"file_path": match_ref["path"]},
                    "params": {},
                    "confidence": 0.75,
                    "rationale": f"Matched reference file '{match_ref['name']}' to annotation requesting append/insert",
                    "source_annotation": content[:200],
                })
                return edits, notes
            elif ext in ("pdf", "ai", "psd"):
                edits.append({
                    "op": "PLACE_ASSET_NEW_PAGE",
                    "target": {"file_path": match_ref["path"]},
                    "params": {},
                    "confidence": 0.7,
                    "rationale": f"Matched reference file '{match_ref['name']}' to annotation requesting placement",
                    "source_annotation": content[:200],
                })
                return edits, notes
            elif ext in ("jpg", "jpeg", "png", "tif", "tiff"):
                edits.append({
                    "op": "PLACE_ASSET_IN_FRAME",
                    "target": {"file_path": match_ref["path"], "page": annotation.get("page", 1)},
                    "params": {},
                    "confidence": 0.6,
                    "rationale": f"Matched raster image '{match_ref['name']}' to placement request",
                    "source_annotation": content[:200],
                })
                return edits, notes

    # ---- Note-style annotations (Note:, FYI, info-only) ----
    if re.match(r"^\s*(?:note|fyi|info|please\s+see)\s*[:.,]?", content, re.I):
        notes.append(content)
        return edits, notes

    # ---- Fallback: HUMAN_REVIEW ----
    edits.append(_human_review(content, "No rule matched; manual review needed"))
    return edits, notes


SYMBOL_SUBS = {
    "&": "and",
    "-": "—",
    "...": "…",
    "(R)": "®",
    "(TM)": "™",
    "(C)": "©",
    '"': "“",  # opening; closing handled separately when contextually needed
    "'": "’",
}

VERBOSE_INSTRUCTIONS = [
    # (annotation-content regex, target-symbol, replacement-symbol)
    (re.compile(r"em\s*dash\s*(with\s*spaces?)?", re.I), "-", "—"),
    (re.compile(r"en\s*dash", re.I), "-", "–"),
    (re.compile(r"ellipsis", re.I), "...", "…"),
]


def _try_scoped_replace(content, nearby, line_text):
    """Generate a REPLACE_TEXT op scoped to the specific line context, so the
    replacement only affects the marked-up instance and not every occurrence
    of the target word/symbol in the doc.

    Returns an edit dict or None.
    """
    # Short-content strategies (A-E) only apply when the comment looks like a
    # replacement word/phrase, not a verbose instruction. Use a length gate
    # for those; verbose-instruction Strategies F/G run regardless of length.
    short_content = len(content) <= 80

    # Strategy A: capitalization fix — content (lower-cased) appears in line_text
    if short_content and line_text and len(content) >= 3:
        idx = line_text.lower().find(content.lower())
        if idx >= 0:
            exact = line_text[idx:idx + len(content)]
            if exact != content:
                # Use the line as scope; replace the matched substring only
                new_line = line_text[:idx] + content + line_text[idx + len(content):]
                if new_line != line_text:
                    return {
                        "op": "REPLACE_TEXT",
                        "target": {"find": line_text},
                        "params": {"replace_with": new_line},
                        "confidence": 0.92,
                        "rationale": f"Capitalization fix scoped to line: '{exact}' → '{content}'",
                    }

    nearby_clean = (nearby or "").strip(".,;:!?\"'()[]{}")

    # Strategy B (verbose instructions, runs regardless of length):
    # e.g. "Revise to an em dash with spaces."
    # find the symbol mentioned in the instruction near the icon; line-scope it.
    for pat, target_sym, replacement_sym in VERBOSE_INSTRUCTIONS:
        if pat.search(content) and line_text and target_sym in line_text:
            # Heuristic: if "with spaces" present, ensure spaces around replacement
            with_spaces = bool(re.search(r"with\s*spaces?", content, re.I))
            new_replacement = f" {replacement_sym} " if with_spaces else replacement_sym
            new_line = line_text.replace(target_sym, new_replacement, 1)
            new_line = re.sub(r"\s+", " ", new_line).strip()
            if new_line != line_text:
                return {
                    "op": "REPLACE_TEXT",
                    "target": {"find": line_text},
                    "params": {"replace_with": new_line},
                    "confidence": 0.85,
                    "rationale": f"Verbose instruction parsed: '{target_sym}' → '{replacement_sym}' in line",
                }

    # Strategy C: symbol-to-word substitution scoped to line (short_content only)
    if short_content and nearby_clean in SYMBOL_SUBS and content.lower() == SYMBOL_SUBS[nearby_clean].lower():
        if line_text and nearby_clean in line_text:
            new_line = line_text.replace(nearby_clean, content, 1)
            return {
                "op": "REPLACE_TEXT",
                "target": {"find": line_text},
                "params": {"replace_with": new_line},
                "confidence": 0.88,
                "rationale": f"Symbol substitution scoped to line: '{nearby_clean}' → '{content}'",
            }

    # Strategy D: short-line whole replacement ("Sub Type" → "Subtype")
    if (short_content and line_text and content != line_text and len(line_text.split()) <= 3
            and len(line_text) <= 25 and _looks_like_correction(line_text, content)):
        return {
            "op": "REPLACE_TEXT",
            "target": {"find": line_text},
            "params": {"replace_with": content},
            "confidence": 0.82,
            "rationale": f"Short-line replacement: '{line_text}' → '{content}'",
        }

    # Strategy E: word-level replacement scoped to line
    # (e.g. "fixture" → "Fixtures" inside "1x4 Recessed fixture")
    if (short_content and nearby_clean and len(nearby_clean) >= 2 and content != nearby_clean
            and _looks_like_correction(nearby_clean, content) and line_text):
        if nearby_clean in line_text:
            new_line = line_text.replace(nearby_clean, content, 1)
            return {
                "op": "REPLACE_TEXT",
                "target": {"find": line_text},
                "params": {"replace_with": new_line},
                "confidence": 0.78,
                "rationale": f"Word replacement scoped to line: '{nearby_clean}' → '{content}'",
            }

    # Strategy F: "insert a space on both sides of a mathematical symbol"
    # — detects digit-symbol-digit patterns. If reviewer says "throughout"
    # or "all", emits a global regex replacement; otherwise line-scoped.
    if re.search(r"(insert|add|put)\s+a?\s*space\s*(on\s+both\s+sides|around|before\s+and\s+after)", content, re.I):
        applies_globally = bool(re.search(r"throughout|all\s+instances|every|each|column-wide|doc-wide", content, re.I))
        # Identify the symbol from nearby_text (e.g. "1x4" → x)
        sym = None
        if nearby:
            m = re.search(r"\d([xX×*])\d", nearby)
            if m:
                sym = m.group(1)
        if not sym and line_text:
            m = re.search(r"\d([xX×*])\d", line_text)
            if m:
                sym = m.group(1)
        if sym:
            if applies_globally:
                # GREP replace for ALL digit-sym-digit patterns in the doc
                return {
                    "op": "REPLACE_TEXT",
                    "target": {"find": r"(\d)" + re.escape(sym) + r"(\d)"},
                    "params": {"replace_with": r"$1 " + sym + r" $2"},
                    "confidence": 0.85,
                    "rationale": f"Verbose instruction (global): add spaces around '{sym}' between digits, throughout doc",
                }
            elif line_text:
                # Single-line scoped fix
                new_line = re.sub(r"(\d)" + re.escape(sym) + r"(\d)", rf"\1 {sym} \2", line_text)
                if new_line != line_text:
                    return {
                        "op": "REPLACE_TEXT",
                        "target": {"find": line_text},
                        "params": {"replace_with": new_line},
                        "confidence": 0.78,
                        "rationale": f"Verbose instruction: insert spaces around '{sym}' in line",
                    }

    return None


def _looks_like_correction(original, replacement):
    """Decide whether `replacement` looks like a plausible corrected form of
    `original`. Conservative — false positives turn into wrong replacements.

    True if any of:
      - Same word, different case ("program" → "Program")
      - Same string after stripping spaces/hyphens ("Sub Type" → "Subtype")
      - One contains the other (capitalization/spelling/pluralization tweaks:
        "fixture" → "Fixtures", "ranges" → "Lumen Ranges")
      - Both are punctuation/symbols (dash family: "-" → "—")
      - Length difference small AND share most characters
    """
    if original == replacement:
        return False
    # Same word, different case
    if original.lower() == replacement.lower():
        return True

    o = original.lower()
    r = replacement.lower()

    # One is a normalized form of the other (spaces/hyphens/case stripped)
    o_norm = re.sub(r"[\s\-]+", "", o)
    r_norm = re.sub(r"[\s\-]+", "", r)
    if o_norm == r_norm and o != r:
        return True

    # One contains the other (capitalization, spelling tweak, pluralization)
    # — require lengths within 2x to avoid replacing entire long lines just
    # because they happen to contain the comment word.
    if len(o_norm) >= 3 and len(r_norm) >= 3 and (o_norm in r_norm or r_norm in o_norm):
        ratio = max(len(o_norm), len(r_norm)) / min(len(o_norm), len(r_norm))
        if ratio <= 2.0:
            return True

    # Both look like punctuation/symbols (dash family etc.)
    if all(not ch.isalnum() for ch in original) and all(not ch.isalnum() for ch in replacement):
        return True

    # Levenshtein-ish: share most characters AND lengths close
    longer = max(len(o_norm), len(r_norm)) or 1
    common = sum(1 for ch in set(o_norm) if ch in r_norm)
    if longer > 0 and common / longer >= 0.5 and abs(len(o_norm) - len(r_norm)) <= 4:
        return True
    return False


def _human_review(content, rationale):
    return {
        "op": "HUMAN_REVIEW",
        "target": {},
        "params": {},
        "confidence": 1.0,
        "rationale": rationale,
        "source_annotation": content[:300],
    }


def _match_reference_file(annotation_text, reference_files):
    """Score each reference file by overlap with annotation text. Return best match or None."""
    text = annotation_text.lower()
    best = None
    best_score = 0
    for ref in reference_files:
        score = 0
        # Tokenize the filename and check word overlap
        name_words = re.findall(r"[a-z0-9]+", ref.get("name", "").lower())
        for w in name_words:
            if len(w) >= 3 and w in text:
                score += 2
        # Bonus if annotation mentions file extension or type
        ext = ref.get("ext", "")
        if ext and ext in text:
            score += 1
        if ref.get("type") == "indesign_document" and re.search(r"\bindesign|indd\b", text):
            score += 1
        if score > best_score:
            best_score = score; best = ref
    return best if best_score >= 2 else None


def classify_edits_local(annotations, doc_inspection, reference_files=None):
    """Main entry. Returns dict with edits + human_notes (matches Claude's output shape).
    REPLACE_TEXT edits are sorted by find-string length DESCENDING so longer
    phrases apply before shorter ones — prevents short-edit ordering from
    invalidating later longer-find edits."""
    column_types_by_table = detect_column_types(doc_inspection)
    all_edits = []
    all_notes = []
    for ann in annotations:
        edits, notes = classify_annotation(ann, doc_inspection, reference_files or [], column_types_by_table)
        all_edits.extend(edits)
        all_notes.extend(notes)

    # Deduplicate identical structured edits (same op + same target). Two reviewer
    # annotations that point to the same file/page often emit the same op twice.
    seen = set()
    deduped = []
    for e in all_edits:
        op = e.get("op")
        if op == "HUMAN_REVIEW":
            deduped.append(e); continue
        target = e.get("target") or {}
        key_parts = [op]
        if op in ("APPEND_PAGES_FROM_INDD", "PLACE_ASSET_NEW_PAGE", "PLACE_ASSET_IN_FRAME"):
            key_parts.append(target.get("file_path", ""))
            key_parts.append(str(target.get("page", "")))
        elif op in ("DELETE_PAGE",):
            key_parts.append(str(target.get("page", "")))
        elif op in ("REPLACE_TEXT",):
            key_parts.append(target.get("find", ""))
            key_parts.append((e.get("params") or {}).get("replace_with", ""))
        elif op in ("ADD_TABLE_ROW", "INSERT_ROW_AT", "DELETE_ROW", "SET_CELL_VALUE", "SORT_TABLE"):
            key_parts.append(target.get("table_id", ""))
            key_parts.append(target.get("row_match", ""))
            key_parts.append(str(target.get("column", "")))
            key_parts.append(str((e.get("params") or {}).get("text", "")))
            key_parts.append(str((e.get("params") or {}).get("values", "")))
        key = tuple(key_parts)
        if key in seen: continue
        seen.add(key)
        deduped.append(e)

    def _sort_key(e):
        if e.get("op") != "REPLACE_TEXT":
            return (1, 0)
        find_str = (e.get("target") or {}).get("find") or ""
        return (0, -len(find_str))
    deduped.sort(key=_sort_key)
    return {"edits": deduped, "human_notes": all_notes}
