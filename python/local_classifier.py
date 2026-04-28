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
            # Determine the operation: replace (when paired with a nearby
            # comment via the pre-pass) vs delete (standalone strikethrough).
            replacement = (annotation.get("replacement_text") or "").strip()
            line_text = (annotation.get("line_text") or "").strip()

            # Preserve trailing punctuation that belongs to the marked text
            # but is missing from the replacement. e.g. reviewer struck
            # "program." (with period attached because PDF word boundaries
            # include trailing punctuation) and the comment is just "Program"
            # — we should produce "Program." not "Program" (the period was
            # never meant to be deleted).
            if replacement and marked and len(marked) >= 2:
                last_ch = marked[-1]
                if last_ch in ".,;:!?)]}" and not replacement.endswith(last_ch):
                    replacement = replacement + last_ch

            # Paired-with-comment path: reviewer convention is "replace the
            # struck-out text with the comment". Emit ONE scoped replace
            # using line_text as the find anchor. The `_substitution`
            # metadata lets _merge_same_line_replace_edits combine multiple
            # edits on the same line later.
            if replacement and line_text and marked in line_text:
                new_line = line_text.replace(marked, replacement, 1)
                new_line = re.sub(r"\s{2,}", " ", new_line).strip()
                edits.append({
                    "op": "REPLACE_TEXT",
                    "target": {"find": line_text},
                    "params": {"replace_with": new_line},
                    "confidence": 0.9,
                    "rationale": f"Strikethrough + comment → replace '{marked[:40]}' with '{replacement[:40]}'",
                    "source_annotation": f"[StrikeOut+Comment on page {annotation.get('page')}]",
                    "_substitution": (marked, replacement),
                })
                return edits, notes
            # Paired but line_text doesn't contain marked (mismatched
            # line reconstruction) — fall back to a non-scoped replace.
            if replacement and marked:
                edits.append({
                    "op": "REPLACE_TEXT",
                    "target": {"find": marked},
                    "params": {"replace_with": replacement},
                    "confidence": 0.82,
                    "rationale": f"Strikethrough + comment → replace '{marked[:40]}' with '{replacement[:40]}'",
                    "source_annotation": f"[StrikeOut+Comment on page {annotation.get('page')}]",
                })
                return edits, notes

            # Delete-only path: scoped delete via line_text when available.
            # A global delete (find=marked, replace_with="") is dangerous
            # when `marked` is short or common — e.g. a strikethrough on "3"
            # or "Up" would nuke every digit/word from the whole doc. We
            # only fall back to global delete when the marked text is long
            # enough that collateral damage is unlikely.
            if line_text and marked in line_text:
                line_minus = line_text.replace(marked, "", 1)
                line_minus = re.sub(r"\s{2,}", " ", line_minus).strip()
                edits.append({
                    "op": "REPLACE_TEXT",
                    "target": {"find": line_text},
                    "params": {"replace_with": line_minus},
                    "confidence": 0.85,
                    "rationale": f"Strikethrough annotation → scoped delete '{marked[:50]}' from its line",
                    "source_annotation": f"[StrikeOut on page {annotation.get('page')}]",
                    "_substitution": (marked, ""),
                })
                return edits, notes
            # No line context available. Only do a global delete if the
            # marked text is long enough to be unique (≥4 chars and contains
            # at least one space or unusual punctuation). Otherwise route to
            # human review — a global delete on "3" or "&" is too risky.
            is_safe_global = len(marked) >= 4 and (
                " " in marked or any(c in marked for c in "$%@#/():")
            )
            if is_safe_global:
                edits.append({
                    "op": "REPLACE_TEXT",
                    "target": {"find": marked},
                    "params": {"replace_with": ""},
                    "confidence": 0.88,
                    "rationale": f"Strikethrough annotation → delete '{marked[:50]}'",
                    "source_annotation": f"[StrikeOut on page {annotation.get('page')}]",
                })
            else:
                notes.append(
                    f"[StrikeOut on page {annotation.get('page')}] '{marked[:80]}' "
                    "— too short to safely auto-delete without surrounding context"
                )
            return edits, notes
        else:
            # Highlight/Underline with comment → reviewer wrote an instruction.
            # Common patterns we can act on automatically:
            #   - "Lowercase" / "lowercase" → lowercase the marked text
            #   - "UPPERCASE" / "Caps" → uppercase the marked text
            #   - "Title case" → title-case the marked text
            # Anything else surfaces as HUMAN_REVIEW with the instruction visible.
            content_norm = (content or "").strip().lower().rstrip(".")
            line_text = (annotation.get("line_text") or "").strip()
            if atype == "Highlight" and content:
                if content_norm.startswith("lowercase") and marked:
                    new_marked = marked.lower()
                    if new_marked != marked:
                        find_str = line_text if line_text and marked in line_text else marked
                        replace_str = (
                            line_text.replace(marked, new_marked, 1)
                            if line_text and marked in line_text else new_marked
                        )
                        edits.append({
                            "op": "REPLACE_TEXT",
                            "target": {"find": find_str},
                            "params": {"replace_with": replace_str},
                            "confidence": 0.85,
                            "rationale": f"Highlight + 'Lowercase' instruction → '{marked[:30]}' → '{new_marked[:30]}'",
                            "source_annotation": f"[Highlight on page {annotation.get('page')}]",
                            "_substitution": (marked, new_marked),
                        })
                        return edits, notes
                # "Revise to an em dash with spaces" / "use en dash" — replace
                # the marked hyphen with the requested dash, scoped to the line.
                # Convention: en/em dash usually used between space-separated
                # tokens, so we look for " - " in line_text.
                if (("em dash" in content_norm or "em-dash" in content_norm) and
                        marked in ("-", "--", "–")):
                    if line_text and " - " in line_text:
                        new_line = line_text.replace(" - ", " — ", 1)
                        edits.append({
                            "op": "REPLACE_TEXT",
                            "target": {"find": line_text},
                            "params": {"replace_with": new_line},
                            "confidence": 0.9,
                            "rationale": "Highlight + 'em dash with spaces' → ' - ' → ' — '",
                            "source_annotation": f"[Highlight on page {annotation.get('page')}]",
                            "_substitution": (" - ", " — "),
                        })
                        return edits, notes
                if (("en dash" in content_norm or "en-dash" in content_norm) and
                        marked in ("-", "--")):
                    if line_text and " - " in line_text:
                        new_line = line_text.replace(" - ", " – ", 1)
                        edits.append({
                            "op": "REPLACE_TEXT",
                            "target": {"find": line_text},
                            "params": {"replace_with": new_line},
                            "confidence": 0.9,
                            "rationale": "Highlight + 'en dash' → ' - ' → ' – '",
                            "source_annotation": f"[Highlight on page {annotation.get('page')}]",
                            "_substitution": (" - ", " – "),
                        })
                        return edits, notes

                # "Insert a space on both sides of this mathematical symbol"
                # The reviewer can highlight either:
                #   - The full pattern (e.g. "1x4") — we extract the symbol
                #   - Just the symbol character (e.g. "x") — most common
                # When the comment says "throughout this column" or
                # "throughout" we emit a regex GREP replacement that spaces
                # every \d+symbol\d+ pattern in the doc. Otherwise scoped.
                if "space on both sides" in content_norm or "math" in content_norm:
                    MATH_SYMBOLS = "xX×+÷*<>=≤≥"
                    symbol = None
                    # Case A: marked is the full d+symbol+d+ pattern
                    m = re.match(r"^\s*(\d+)\s*([" + re.escape(MATH_SYMBOLS) + r"])\s*(\d+)\s*$", marked or "")
                    if m:
                        symbol = m.group(2)
                    # Case B: marked is JUST the symbol (single char)
                    elif marked and len(marked.strip()) == 1 and marked.strip() in MATH_SYMBOLS:
                        symbol = marked.strip()
                    if symbol:
                        is_global = ("throughout" in content_norm or "all" in content_norm)
                        if is_global:
                            grep_find = r"(\d+)" + re.escape(symbol) + r"(\d+)"
                            grep_repl = r"$1 " + symbol + r" $2"
                            edits.append({
                                "op": "REPLACE_TEXT",
                                "target": {"find": grep_find},
                                "params": {"replace_with": grep_repl, "is_regex": True},
                                "confidence": 0.9,
                                "rationale": f"Highlight + 'space on both sides' (throughout) → \\d+{symbol}\\d+ → \\d+ {symbol} \\d+",
                                "source_annotation": f"[Highlight on page {annotation.get('page')}]",
                            })
                        elif m:
                            # Scoped (only if we know the full pattern from marked)
                            spaced = f"{m.group(1)} {symbol} {m.group(3)}"
                            if line_text and marked in line_text:
                                new_line = line_text.replace(marked, spaced, 1)
                                edits.append({
                                    "op": "REPLACE_TEXT",
                                    "target": {"find": line_text},
                                    "params": {"replace_with": new_line},
                                    "confidence": 0.85,
                                    "rationale": f"Highlight + 'space on both sides' → '{marked}' → '{spaced}'",
                                    "source_annotation": f"[Highlight on page {annotation.get('page')}]",
                                    "_substitution": (marked, spaced),
                                })
                        return edits, notes

                if "curly apostrophe" in content_norm and marked == "'":
                    # Reviewer pointed out a straight apostrophe that should
                    # be a curly one (’). Auto-fix is the same as our
                    # TEXT_SMART_QUOTES sweep, but this targets the specific
                    # location (no global apostrophe replace).
                    if line_text and "'" in line_text:
                        new_line = line_text.replace("'", "’", 1)
                        edits.append({
                            "op": "REPLACE_TEXT",
                            "target": {"find": line_text},
                            "params": {"replace_with": new_line},
                            "confidence": 0.85,
                            "rationale": "Highlight + 'curly apostrophe' instruction → ' → ’",
                            "source_annotation": f"[Highlight on page {annotation.get('page')}]",
                            "_substitution": ("'", "’"),
                        })
                        return edits, notes
                if content_norm.startswith("close up space") and marked:
                    # Reviewer wants the spaces ON EITHER SIDE of the marked
                    # character closed up. e.g. "Audit – cost" → "Audit–cost".
                    # Most common case: en-dash being used as a range
                    # ("3 – 5" → "3–5"). We do a scoped replacement on the
                    # surrounding line so we don't accidentally close up
                    # ALL spaces around every "–" in the doc.
                    if line_text:
                        spaced = f" {marked} "
                        if spaced in line_text:
                            new_line = line_text.replace(spaced, marked, 1)
                            edits.append({
                                "op": "REPLACE_TEXT",
                                "target": {"find": line_text},
                                "params": {"replace_with": new_line},
                                "confidence": 0.9,
                                "rationale": f"Highlight + 'Close up space' → remove spaces around '{marked}'",
                                "source_annotation": f"[Highlight on page {annotation.get('page')}]",
                                "_substitution": (spaced, marked),
                            })
                            return edits, notes
                    # No line context — fall back to a global tightening
                    edits.append({
                        "op": "REPLACE_TEXT",
                        "target": {"find": f" {marked} "},
                        "params": {"replace_with": marked},
                        "confidence": 0.85,
                        "rationale": f"Highlight + 'Close up space' → remove spaces around '{marked}'",
                        "source_annotation": f"[Highlight on page {annotation.get('page')}]",
                    })
                    return edits, notes
                if (content_norm.startswith("uppercase") or content_norm in ("caps", "all caps")) and marked:
                    new_marked = marked.upper()
                    if new_marked != marked:
                        find_str = line_text if line_text and marked in line_text else marked
                        replace_str = (
                            line_text.replace(marked, new_marked, 1)
                            if line_text and marked in line_text else new_marked
                        )
                        edits.append({
                            "op": "REPLACE_TEXT",
                            "target": {"find": find_str},
                            "params": {"replace_with": replace_str},
                            "confidence": 0.85,
                            "rationale": f"Highlight + uppercase instruction → '{marked[:30]}' → '{new_marked[:30]}'",
                            "source_annotation": f"[Highlight on page {annotation.get('page')}]",
                            "_substitution": (marked, new_marked),
                        })
                        return edits, notes
            # Fallback — when the highlight has verbose-instruction content
            # we don't have a hand-coded rule for, emit a HUMAN_REVIEW edit so
            # the Ollama escalation path picks it up. Without this, verbose
            # instructions like "Insert a comma between X and Y" get dropped
            # to a passive note instead of being attempted dynamically.
            #
            # Bare highlights with no content stay as notes (no instruction
            # for an LLM to act on).
            label = f"[{atype} on page {annotation.get('page')}] '{marked[:80]}'"
            if content:
                label += f" — instruction: '{content[:160]}'"
            if content and len((content or "").split()) >= 4:
                edits.append({
                    "op": "HUMAN_REVIEW",
                    "target": {},
                    "params": {},
                    "confidence": 0.5,
                    "rationale": f"{atype} with verbose instruction — escalating to LLM",
                    "source_annotation": content[:300],
                    # Hints the Ollama escalation path uses to build a
                    # focused prompt (vs. just sending the comment text).
                    "_force_ollama": True,
                    "_marked_text": marked,
                    "_line_text": line_text,
                    "_atype": atype,
                })
            else:
                notes.append(label)
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

    # Strategy 0: short punctuation insert. Reviewer placed a Caret with
    # content like ":", ";", ".", "?", "!", "—" at a position to mean
    # "insert this after the nearby word". E.g. caret with content=":" near
    # the word "started" → "Here's how to get started:".
    if (content and len(content) <= 3 and
            re.match(r"^[\.\,\;\:\?\!\-–—]+$", content) and
            nearby and line_text and nearby in line_text):
        new_line = line_text.replace(nearby, nearby + content, 1)
        if new_line != line_text:
            return {
                "op": "REPLACE_TEXT",
                "target": {"find": line_text},
                "params": {"replace_with": new_line},
                "confidence": 0.85,
                "rationale": f"Insert '{content}' after '{nearby}'",
                "_substitution": (nearby, nearby + content),
            }

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
                        "_substitution": (exact, content),
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
                    "_substitution": (target_sym, new_replacement),
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
                "_substitution": (nearby_clean, content),
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
                "_substitution": (nearby_clean, content),
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


def _pair_strikethroughs_with_comments(annotations, max_y_pt=15.0, max_x_pt=200.0):
    """Reviewer convention: a strikethrough + a nearby Caret/Text sticky-note
    means "replace the struck text with the comment text" — NOT two independent
    edits. We need to detect these pairs upfront and merge them, otherwise the
    standalone delete and standalone replace edits collide on the same line.

    Mutates the StrikeOut annotations to add a `replacement_text` field when a
    paired comment is found, and returns the set of annotation INDICES to skip
    in the main loop (the partner comments — they're now represented by the
    merged edit on the StrikeOut side).

    Proximity rule (matches typical reviewer behavior):
      - Y distance ≤ max_y_pt (default 15pt — one line of body text). This is
        the strict requirement: comments on different visual lines do NOT pair.
        That's how we avoid false-positive pairings when reviewers leave
        directional notes on adjacent lines.
      - X distance ≤ max_x_pt (default 200pt — a half-page horizontal reach).
      - Among comments meeting both bounds, pick the closest by Euclidean.
    """
    skip_indices = set()
    if not annotations:
        return skip_indices

    def _center(rect):
        if not rect or len(rect) < 4:
            return None
        return ((rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2)

    # Comments that look like directional / instructional human notes
    # ("If it fits...", "See note about...", "Move this above...") are NOT
    # meant to be inserted as replacement text — they're guidance for the
    # editor. Excluding them from pairing routes them to HUMAN_REVIEW
    # instead. Match is case-insensitive on the first word + space.
    DIRECTIONAL_PREFIXES = (
        "if ", "when ", "where ", "while ", "since ", "because ",
        "see ", "note ", "remove ", "delete ", "move ", "look ",
        "change ", "replace ", "throughout", "this ", "that ",
        "they ", "make ", "ignore ", "skip ",
    )

    def _is_directional(content):
        c = (content or "").strip().lower()
        if not c:
            return False
        return any(c.startswith(p) for p in DIRECTIONAL_PREFIXES)

    # Index pair-eligible comments by page (skip directional ones)
    comments_by_page = {}
    for i, a in enumerate(annotations):
        if a.get("type") not in ("Caret", "Text"):
            continue
        ct = (a.get("content") or "").strip()
        if not ct:
            continue
        if _is_directional(ct):
            continue  # guidance, not replacement — leave for the main loop
        comments_by_page.setdefault(a.get("page"), []).append((i, a))

    for stk in annotations:
        if stk.get("type") != "StrikeOut":
            continue
        c1 = _center(stk.get("rect"))
        if not c1:
            continue
        candidates = comments_by_page.get(stk.get("page"), [])
        best = None
        best_dist = float("inf")
        for i, comment in candidates:
            if i in skip_indices:
                continue
            c2 = _center(comment.get("rect"))
            if not c2:
                continue
            dy = abs(c1[1] - c2[1])
            dx = abs(c1[0] - c2[0])
            # STRICT: must be on the same visual line as the strikethrough.
            # Comments above/below count as separate intent.
            if dy > max_y_pt or dx > max_x_pt:
                continue
            d = (dx * dx + dy * dy) ** 0.5
            if d < best_dist:
                best_dist = d
                best = (i, comment)
        if best:
            i, comment = best
            stk["replacement_text"] = (comment.get("content") or "").strip()
            stk["paired_comment_page"] = comment.get("page")
            skip_indices.add(i)
    return skip_indices


def _merge_same_line_replace_edits(edits):
    """Combine multiple REPLACE_TEXT edits whose `find` is the same line into
    a single edit so all substitutions land. Without this, two strikethroughs
    on the same line would compete: whichever applies first mutates the line
    and the second's `find` no longer matches.

    Each edit must carry `_substitution`: (marked, replacement) on its
    private metadata for the merger to combine them. Edits without it (e.g.
    short-line replacements where the find isn't a clean line, or
    HUMAN_REVIEW) pass through unchanged.
    """
    # Group line-scoped REPLACE_TEXTs by their `find` string
    groups = {}
    passthrough = []
    for e in edits:
        if e.get("op") != "REPLACE_TEXT":
            passthrough.append(e); continue
        sub = e.get("_substitution")
        if not sub:
            passthrough.append(e); continue
        find = (e.get("target") or {}).get("find") or ""
        groups.setdefault(find, []).append(e)

    merged = []
    for find, group in groups.items():
        if len(group) == 1:
            e = group[0]
            e.pop("_substitution", None)
            merged.append(e)
            continue
        # Apply each substitution in order to build the final replace_with.
        # Sort by len(marked) descending so longer struck-out tokens are
        # replaced before shorter substrings that might appear inside them.
        # Also dedupe identical substitutions — two reviewer marks on the
        # same word (e.g. two "3" strikethroughs paired with two "Three"
        # comments) shouldn't run the substitution twice, or the second
        # pass hits a different "3" inside the line ("30%" → "Three0%").
        group.sort(key=lambda e: -len(e["_substitution"][0]))
        seen_subs = set()
        running = find
        rationales = []
        confs = []
        sources = []
        for e in group:
            marked, repl = e["_substitution"]
            sub_key = (marked, repl)
            if sub_key in seen_subs:
                continue
            seen_subs.add(sub_key)
            if marked and marked in running:
                running = running.replace(marked, repl, 1)
            rationales.append(e.get("rationale", "") or "")
            confs.append(e.get("confidence", 0) or 0)
            sources.append(e.get("source_annotation", "") or "")
        running = re.sub(r"\s{2,}", " ", running).strip()
        merged.append({
            "op": "REPLACE_TEXT",
            "target": {"find": find},
            "params": {"replace_with": running},
            "confidence": min(confs) if confs else 0.85,
            "rationale": " + ".join(r for r in rationales if r) or "Merged line edits",
            "source_annotation": " | ".join(s for s in sources if s),
        })
    return passthrough + merged


def classify_edits_local(annotations, doc_inspection, reference_files=None):
    """Main entry. Returns dict with edits + human_notes (matches Claude's output shape).
    REPLACE_TEXT edits are sorted by find-string length DESCENDING so longer
    phrases apply before shorter ones — prevents short-edit ordering from
    invalidating later longer-find edits."""
    column_types_by_table = detect_column_types(doc_inspection)

    # Pre-pass: pair StrikeOuts with their replacement-text comments so we
    # emit one merged edit per pair instead of two conflicting ones.
    skip_indices = _pair_strikethroughs_with_comments(annotations)

    all_edits = []
    all_notes = []
    for idx, ann in enumerate(annotations):
        if idx in skip_indices:
            continue  # comment was paired with a StrikeOut — handled there
        edits, notes = classify_annotation(ann, doc_inspection, reference_files or [], column_types_by_table)
        all_edits.extend(edits)
        all_notes.extend(notes)

    # Merge multiple line-scoped REPLACE_TEXTs that target the same `find`
    # so all substitutions land. Without this, two edits on the same line
    # would compete (whichever applies first mutates the line and the
    # second's `find` stops matching).
    all_edits = _merge_same_line_replace_edits(all_edits)

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
