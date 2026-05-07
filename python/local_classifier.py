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

# Map plain-English typographic-symbol names to their Unicode equivalents.
# Used by the "replace <X> with <Y>" classifier (e.g. "replace comma with an
# em dash"). Keys are normalized lowercase tokens.
WORD_TO_CHAR = {
    "comma": ",",
    "semicolon": ";",
    "period": ".", "full stop": ".", "dot": ".",
    "colon": ":",
    "exclamation": "!", "exclamation point": "!", "exclamation mark": "!",
    "question mark": "?",
    "hyphen": "-", "dash": "-", "minus": "-",
    "en dash": "–", "endash": "–",
    "em dash": "—", "emdash": "—",
    "space": " ",
    "ampersand": "&", "and sign": "&",
    "apostrophe": "’",                       # curly apostrophe (typographic default)
    "single quote": "'", "single quotation": "'",
    "double quote": "\"", "double quotation": "\"",
    "open paren": "(", "open parenthesis": "(",
    "close paren": ")", "close parenthesis": ")",
    "slash": "/", "forward slash": "/",
    "backslash": "\\",
    "asterisk": "*", "star": "*",
    "plus": "+",
    "tilde": "~",
    "underscore": "_",
    "pipe": "|", "vertical bar": "|",
    "ellipsis": "…", "ellipses": "…",
    "bullet": "•",
}


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

    # ---- Caret = explicit insertion. Content is the text to insert,
    # nearby_text is the word adjacent to the caret position. Acrobat doesn't
    # encode whether the insertion goes BEFORE or AFTER the nearby word —
    # default to AFTER, which matches reviewer convention for parenthetical
    # callouts like "(EV)" / "(LEED Gold)". We only handle this when the
    # caret is NOT paired with a strikethrough (paired carets are absorbed
    # into a REPLACE_TEXT edit by the strikethrough handler).
    if atype == "Caret" and content and not annotation.get("_paired_with_strikethrough"):
        nearby = (annotation.get("nearby_text") or "").strip()
        line_text = (annotation.get("line_text") or "").strip()

        # Special case: comma caret intended as thousands separator on a
        # currency value. Reviewers commonly draw a caret inside a 4+ digit
        # number ("$1750") meaning "format with comma" → "$1,750". But
        # pdfplumber's nearby_text often picks up a word from an adjacent
        # cell ("Rebate") instead of the actual number, which would cause
        # us to insert a stray comma after the wrong word. Detect:
        #   (a) content is just "," — and
        #   (b) line_text contains a 4+ digit run of digits with no commas
        # and rewrite that number with thousands separators instead. If
        # neither marked nor line_text has such a number, route to HUMAN_REVIEW
        # rather than place the comma in a misleading location.
        if content.strip() == ",":
            target_num = None
            target_text = line_text or ""
            num_match = re.search(r"\$?(\d{4,})\b", target_text)
            if num_match:
                target_num = num_match.group(1)
            else:
                # Broaden search to the whole table cell — reviewers often
                # draw the caret on a line BELOW the $XXXX amount in a
                # multi-line cell ("$1000\nRebate includes cost\n..."), so
                # line_text on its own is just "Rebate includes cost". The
                # column_block_text field captures ±2 lines × narrow column
                # width around the caret. Restrict to one unique 4+ digit
                # number — if the cell has multiple, abstain to avoid
                # comma-formatting the wrong one.
                block_text = (annotation.get("column_block_text") or "").strip()
                if block_text:
                    found_nums = re.findall(r"\$?(\d{4,})\b", block_text)
                    # Dedup while preserving order
                    seen = set(); unique_nums = []
                    for n in found_nums:
                        if n not in seen:
                            seen.add(n); unique_nums.append(n)
                    if len(unique_nums) == 1:
                        target_num = unique_nums[0]
            if target_num:
                with_commas = "{:,}".format(int(target_num))
                # Use the BARE number as the find string (line-scoped find
                # often fails because the caret + number live in a table cell
                # that pdfplumber couldn't reconstruct cleanly). The number
                # itself is unique enough to be safe doc-wide as long as it's
                # 4+ digits. Add a fallback to the line scope as well.
                edits.append({
                    "op": "REPLACE_TEXT",
                    "target": {"find": target_num, "fallback_find": target_num},
                    "params": {"replace_with": with_commas, "fallback_replace_with": with_commas},
                    "confidence": 0.85,
                    "rationale": f"Caret + ',' → format '{target_num}' as '{with_commas}'",
                    "source_annotation": f"[Caret on page {annotation.get('page')}]",
                })
                return edits, notes
            # No 4+ digit number nearby — the user's intent is unclear (we
            # can't see the actual cell the caret was placed in), so don't
            # guess and corrupt unrelated text.
            edits.append(_human_review(
                f"Comma caret near '{nearby}' — couldn't locate a 4+ digit "
                f"number to format with thousands separator. Line: '{line_text[:120]}'. "
                f"Place the comma manually.",
                "Comma caret with no clear currency context"))
            return edits, notes

        if nearby and line_text and nearby in line_text:
            # If the inserted content starts with a letter, digit, or opening
            # bracket, prepend a space — otherwise things like "vehicle(EV)"
            # collide. Punctuation that naturally follows a word (.,:;!?-)
            # gets inserted directly without a space.
            first = content[0]
            insert_str = (" " + content) if (first.isalnum() or first in "([{\"'") else content
            # If nearby ends in sentence-final punctuation, the reviewer
            # almost always wants the insertion BEFORE the punctuation
            # (e.g. nearby="level ." + content="(AMI)" → "...level (AMI). For").
            # pdfplumber commonly glues the punctuation onto the trailing
            # word, so without this branch the new content lands AFTER
            # the period instead of before.
            new_line = None
            tail_match = re.search(r"[\.\,\;\:\!\?]+$", nearby)
            if tail_match:
                trailing_punct = tail_match.group(0)
                nearby_clean = nearby[:-len(trailing_punct)].rstrip()
                if nearby_clean:
                    pat = re.escape(nearby_clean) + r"\s*" + re.escape(trailing_punct)
                    candidate, n_subs = re.subn(
                        pat,
                        nearby_clean + insert_str + trailing_punct,
                        line_text, count=1)
                    if n_subs > 0:
                        new_line = candidate
            if new_line is None:
                new_line = line_text.replace(nearby, nearby + insert_str, 1)
            if new_line != line_text:
                edits.append({
                    "op": "REPLACE_TEXT",
                    "target": {"find": line_text},
                    "params": {"replace_with": new_line},
                    "confidence": 0.85,
                    "rationale": f"Caret + content → insert '{content[:40]}' near '{nearby[:40]}'",
                    "source_annotation": f"[Caret on page {annotation.get('page')}]",
                })
                return edits, notes
    # Whitespace-only strike: the reviewer struck through one of two
    # adjacent space characters to delete the redundant one. extract_annotations
    # detected this and stashed surrounding chars in `whitespace_strike_context`.
    # Emit a GREP REPLACE_TEXT that collapses the multi-space to single, scoped
    # by the flanking words so we don't accidentally collapse legitimate
    # multi-space layout (e.g. checkbox columns, table separators).
    ws_ctx = annotation.get("whitespace_strike_context") if atype == "StrikeOut" else None
    if ws_ctx and ws_ctx.get("before") and ws_ctx.get("after"):
        before_grep = re.escape(ws_ctx["before"])
        after_grep = re.escape(ws_ctx["after"])
        edits.append({
            "op": "REPLACE_TEXT",
            "target": {"find": before_grep + r"\s\s+" + after_grep},
            "params": {
                "replace_with": ws_ctx["before"] + " " + ws_ctx["after"],
                "is_regex": True,
            },
            "confidence": 0.85,
            "rationale": (
                f"Strikethrough on extra whitespace between "
                f"'{ws_ctx['before'][:30]}' and '{ws_ctx['after'][:30]}' (GREP) → "
                f"collapsed multi-space to single"
            ),
            "source_annotation": f"[StrikeOut on page {annotation.get('page')}]",
        })
        return edits, notes

    if marked and atype in ("StrikeOut", "Underline", "Squiggly", "Highlight"):
        if atype == "StrikeOut":
            # Determine the operation: replace (when paired with a nearby
            # comment via the pre-pass) vs delete (standalone strikethrough).
            replacement = (annotation.get("replacement_text") or "").strip()
            line_text = (annotation.get("line_text") or "").strip()

            # If the marked text has an unbalanced opening bracket — e.g.
            # marked="Quality Assurance/Quality Control (QA/QC" with a "(" but
            # no matching ")" — pdfplumber clipped the strike at a word
            # boundary inside the parenthetical. Walk forward in line_text
            # to find the matching ")" and extend the marked range so the
            # delete/replace consumes both halves of the parenthetical.
            extended_for_balance = False
            if marked and line_text and marked in line_text:
                open_count = marked.count("(") - marked.count(")")
                if open_count > 0:
                    start = line_text.find(marked)
                    end = start + len(marked)
                    extra = 0
                    while end + extra < len(line_text) and open_count > 0 and extra < 80:
                        ch = line_text[end + extra]
                        if ch == "(": open_count += 1
                        elif ch == ")": open_count -= 1
                        extra += 1
                    if open_count == 0 and extra > 0:
                        marked = line_text[start:end + extra]
                        extended_for_balance = True

            # Preserve TRAILING punctuation that belongs to the marked text
            # but is missing from the replacement. e.g. reviewer struck
            # "program." (with period attached because PDF word boundaries
            # include trailing punctuation) and the comment is just "Program"
            # — we should produce "Program." not "Program" (the period was
            # never meant to be deleted). Skipped when:
            #   - we extended marked to balance parens (trailing ")" was
            #     deliberately consumed)
            #   - the trailing char is a closing bracket whose opening
            #     counterpart is also inside marked — that's a balanced pair
            #     the reviewer deliberately struck through
            if (replacement and marked and len(marked) >= 2 and
                    not extended_for_balance):
                last_ch = marked[-1]
                paired_brackets = {")": "(", "]": "[", "}": "{"}
                opener = paired_brackets.get(last_ch)
                bracket_was_paired = opener is not None and opener in marked
                if (last_ch in ".,;:!?)]}" and
                        not replacement.endswith(last_ch) and
                        not bracket_was_paired):
                    replacement = replacement + last_ch
            # Same for LEADING punctuation: PDF strike geometry can brush up
            # against an opening "(", "[", quote, etc., so marked = "(MFG"
            # while the reviewer only meant to strike "MFG". Without this,
            # we'd produce "Manufactured Home)" — dropping the open paren.
            if replacement and marked and len(marked) >= 2:
                first_ch = marked[0]
                if first_ch in "([{\"'‘“" and not replacement.startswith(first_ch):
                    replacement = first_ch + replacement

            # Single-letter case-only fix on a line with multiple matches:
            # "strike 'p' + comment 'P'" on "program because... perfect place"
            # — we can't tell which `p` the reviewer meant from the strike
            # rect alone. Use the paired Caret's nearby_text to pick the
            # target word; if that's not enough, route to HUMAN_REVIEW.
            if (replacement and marked and len(marked) == 1 and len(replacement) == 1 and
                    marked.lower() == replacement.lower() and marked != replacement and
                    line_text and line_text.lower().count(marked.lower()) > 1):
                paired_nearby = (annotation.get("paired_nearby_text") or "").strip()
                target_word = None

                # FIRST try: marked_word — the actual word the strike rect
                # overlapped (captured by extract_annotations). This is the
                # most reliable disambiguator because it uses the strike's
                # spatial position, not the paired comment's nearby text
                # (which may be on a different line entirely).
                marked_word = (annotation.get("marked_word") or "").strip()
                if marked_word and marked_word in line_text:
                    target_word = marked_word

                if not target_word and paired_nearby:
                    # Strip trailing punctuation pdfplumber attaches to nearby
                    # ("straightforward:" → "straightforward")
                    nb_clean = paired_nearby.rstrip(".,;:!?)]}\"'")
                    # Case A: the nearby word STARTS with the marked letter
                    # (e.g. nearby="program", letter="p") — capitalize the
                    # nearby word itself. We require letter at position 0 to
                    # avoid mid-word capitalizations like "straightforWard".
                    if nb_clean.lower().startswith(marked.lower()):
                        target_word = nb_clean
                    else:
                        # Case B: scan forward in line_text from after `nearby`
                        # for the next word that STARTS with the marked letter.
                        # Handles two situations:
                        #   - nearby doesn't contain the letter at all
                        #     (e.g. nearby="ChargeSmart", letter="p" → "program")
                        #   - nearby contains the letter mid-word but the
                        #     reviewer meant the NEXT word
                        #     (e.g. nearby="straightforward:", letter="w" → "when")
                        idx = line_text.lower().find(nb_clean.lower())
                        if idx >= 0:
                            after = line_text[idx + len(nb_clean):]
                            for m in re.finditer(r"([A-Za-z][A-Za-z'’-]*)", after):
                                w = m.group(1)
                                if w.lower().startswith(marked.lower()):
                                    target_word = w
                                    break
                if target_word and target_word in line_text:
                    # Capitalize the marked letter in target_word (preserve
                    # the rest of the word). Most common case: marked is the
                    # first letter, just capitalize it.
                    pos = target_word.lower().find(marked.lower())
                    if pos == 0:
                        new_word = replacement + target_word[1:]
                    else:
                        new_word = target_word[:pos] + replacement + target_word[pos+1:]
                    new_line = line_text.replace(target_word, new_word, 1)
                    fb_find, fb_replace, fb2_find, fb2_replace = _build_fallback_targets(target_word, new_word, line_text)
                    disambig_via = (
                        f"strike-rect → '{target_word}'"
                        if marked_word and target_word == marked_word
                        else f"paired nearby='{paired_nearby}'"
                    )
                    cap_edit = {
                        "op": "REPLACE_TEXT",
                        "target": {"find": line_text},
                        "params": {"replace_with": new_line},
                        "confidence": 0.88,
                        "rationale": (f"Strikethrough '{marked}' + comment '{replacement}' "
                                      f"→ capitalize '{target_word}' → '{new_word}' "
                                      f"(disambiguated via {disambig_via})"),
                        "source_annotation": f"[StrikeOut+Comment on page {annotation.get('page')}]",
                        "_substitution": (target_word, new_word),
                    }
                    if fb_find: cap_edit["target"]["fallback_find"] = fb_find
                    if fb_replace is not None: cap_edit["params"]["fallback_replace_with"] = fb_replace
                    if fb2_find: cap_edit["target"]["fallback2_find"] = fb2_find
                    if fb2_replace is not None: cap_edit["params"]["fallback2_replace_with"] = fb2_replace
                    edits.append(cap_edit)
                    return edits, notes
                edits.append(_human_review(
                    f"Strikethrough '{marked}' + comment '{replacement}' on a line with "
                    f"multiple '{marked}' — can't determine which one to capitalize. "
                    f"Paired nearby: '{paired_nearby}'. Line: {line_text[:120]}",
                    "Ambiguous single-letter case fix"))
                return edits, notes

            # Paired-with-comment path: reviewer convention is "replace the
            # struck-out text with the comment". Emit ONE scoped replace
            # using line_text as the find anchor. The `_substitution`
            # metadata lets _merge_same_line_replace_edits combine multiple
            # edits on the same line later.
            if replacement and line_text and marked in line_text:
                new_line = line_text.replace(marked, replacement, 1)
                new_line = re.sub(r"\s{2,}", " ", new_line).strip()
                fb_find, fb_replace, fb2_find, fb2_replace = _build_fallback_targets(marked, replacement, line_text)
                edit = {
                    "op": "REPLACE_TEXT",
                    "target": {"find": line_text},
                    "params": {"replace_with": new_line},
                    "confidence": 0.9,
                    "rationale": f"Strikethrough + comment → replace '{marked[:40]}' with '{replacement[:40]}'",
                    "source_annotation": f"[StrikeOut+Comment on page {annotation.get('page')}]",
                    "_substitution": (marked, replacement),
                }
                if fb_find: edit["target"]["fallback_find"] = fb_find
                if fb_replace is not None: edit["params"]["fallback_replace_with"] = fb_replace
                if fb2_find: edit["target"]["fallback2_find"] = fb2_find
                if fb2_replace is not None: edit["params"]["fallback2_replace_with"] = fb2_replace
                edits.append(edit)
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
                fb_find, fb_replace, fb2_find, fb2_replace = _build_fallback_targets(marked, "", line_text)

                # When `marked` is sentence-length (≥25 chars with a space),
                # it's effectively unique in the doc. Prefer a SCOPED-MARKED
                # delete as the primary target — that preserves the formatting
                # of surrounding runs (italic, bold, smaller weight, etc.).
                # InDesign's findText/changeText REPLACES formatting at the
                # match site with the insertion-point style, so a whole-line
                # replace clobbers any per-run formatting inside that line.
                # By deleting only the marked characters, surrounding runs
                # stay intact. The whole-line replace remains as a fallback
                # for cases where the marked text spans a run boundary or
                # has hidden chars and can't be matched literally.
                #
                # We extend the find to include the leading space (or the
                # trailing space if marked is at line start) so the result
                # doesn't end up with a double space between the surviving
                # neighbors. This is what `line_minus` was doing implicitly
                # via its `re.sub(r"\s{2,}", " ", ...)` cleanup.
                is_marked_safe_global = (
                    len(marked.strip()) >= 25 and " " in marked.strip()
                )
                if is_marked_safe_global:
                    marked_pos = line_text.find(marked)
                    if marked_pos > 0 and line_text[marked_pos - 1] == " ":
                        scoped_find = " " + marked
                    elif marked_pos == 0:
                        end_pos = marked_pos + len(marked)
                        if end_pos < len(line_text) and line_text[end_pos] == " ":
                            scoped_find = marked + " "
                        else:
                            scoped_find = marked
                    else:
                        scoped_find = marked
                    del_edit = {
                        "op": "REPLACE_TEXT",
                        "target": {
                            "find": scoped_find,
                            # Whole-line replace as fallback if the marked-
                            # scoped delete doesn't match (run-boundary etc.)
                            "fallback_find": line_text,
                        },
                        "params": {
                            "replace_with": "",
                            "fallback_replace_with": line_minus,
                        },
                        "confidence": 0.88,
                        "rationale": (
                            f"Strikethrough annotation → marked-scoped delete "
                            f"'{marked[:50]}' (preserves surrounding formatting)"
                        ),
                        "source_annotation": f"[StrikeOut on page {annotation.get('page')}]",
                        "_substitution": (marked, ""),
                    }
                    if fb2_find: del_edit["target"]["fallback2_find"] = fb2_find
                    if fb2_replace is not None: del_edit["params"]["fallback2_replace_with"] = fb2_replace
                    edits.append(del_edit)
                    return edits, notes

                del_edit = {
                    "op": "REPLACE_TEXT",
                    "target": {"find": line_text},
                    "params": {"replace_with": line_minus},
                    "confidence": 0.85,
                    "rationale": f"Strikethrough annotation → scoped delete '{marked[:50]}' from its line",
                    "source_annotation": f"[StrikeOut on page {annotation.get('page')}]",
                    "_substitution": (marked, ""),
                }
                if fb_find: del_edit["target"]["fallback_find"] = fb_find
                if fb_replace is not None: del_edit["params"]["fallback_replace_with"] = fb_replace
                if fb2_find: del_edit["target"]["fallback2_find"] = fb2_find
                if fb2_replace is not None: del_edit["params"]["fallback2_replace_with"] = fb2_replace
                edits.append(del_edit)
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
                # "Is there an extra space after period? If so, please remove"
                # — a hedged instruction. Detect the "extra space" + "remove"
                # combination and look in marked_text (or line_text) for an
                # actual `\s{2,}` after a period/comma/colon. If found, fix
                # it; if not, route to HUMAN_REVIEW instead of guessing.
                extra_space_kw = (
                    ("extra" in content_norm and "space" in content_norm and "remove" in content_norm) or
                    ("double" in content_norm and "space" in content_norm and "remove" in content_norm)
                )
                if extra_space_kw:
                    # Determine which punct the reviewer asked about.
                    punct_map = [
                        ("period", r"\."),
                        ("comma", r","),
                        ("colon", r":"),
                        ("semicolon", r";"),
                    ]
                    target_punct_re = None
                    for word, regex in punct_map:
                        if word in content_norm:
                            target_punct_re = regex; break
                    # Default to "after period" if not specified
                    if target_punct_re is None:
                        target_punct_re = r"\."
                    # Look for the offending pattern in marked first, then line_text.
                    # Note: PyMuPDF normalizes whitespace during text extraction, so
                    # `\s{2,}` is rarely present even when InDesign's source DOES
                    # have a double space. We try the literal-find path first
                    # (works if PyMuPDF preserved the spacing); if that fails, we
                    # fall through to a GREP-based REPLACE_TEXT that InDesign's
                    # findGrep runs against its OWN text (which does have the
                    # original spacing). The GREP only collapses runs of 2+
                    # spaces, so already-correct text is left untouched.
                    for scope, scope_text in (("marked", marked), ("line", line_text)):
                        if not scope_text: continue
                        new_text = re.sub(target_punct_re + r"\s{2,}",
                                          lambda m: m.group(0)[0] + " ",
                                          scope_text, count=1)
                        if new_text != scope_text:
                            find_str = scope_text
                            edits.append({
                                "op": "REPLACE_TEXT",
                                "target": {"find": find_str},
                                "params": {"replace_with": new_text},
                                "confidence": 0.9,
                                "rationale": f"Highlight + 'extra space after {target_punct_re}' → collapsed to single space",
                                "source_annotation": f"[Highlight on page {annotation.get('page')}]",
                            })
                            return edits, notes

                    # PyMuPDF normalized the whitespace away — fall back to a
                    # GREP that InDesign runs against its non-normalized source.
                    # Two patterns based on what the reviewer's comment says:
                    is_before = (
                        "in front of" in content_norm
                        or "before" in content_norm
                        or "prior to" in content_norm
                    )
                    is_after = ("after" in content_norm)

                    grep_find = None
                    grep_replace = None
                    rationale_suffix = None
                    if marked:
                        # Build patterns scoped to the marked word so we don't
                        # accidentally collapse a deliberate double-space
                        # somewhere else in the doc (e.g. checkbox separators).
                        marked_grep = re.escape(marked)
                        if is_before:
                            # "extra space in front of <X>" → " +<X>" → "<X>"
                            grep_find = r"  +" + marked_grep
                            grep_replace = marked
                            rationale_suffix = f"removed leading whitespace before '{marked[:30]}'"
                        elif is_after:
                            # "extra space after <X>" — usually X ends with the
                            # punctuation in the comment, so trim spaces AFTER
                            # the marked text.
                            grep_find = marked_grep + r"  +"
                            grep_replace = marked + " "
                            rationale_suffix = f"collapsed multi-space after '{marked[:30]}'"
                    if grep_find:
                        edits.append({
                            "op": "REPLACE_TEXT",
                            "target": {"find": grep_find},
                            "params": {
                                "replace_with": grep_replace,
                                "is_regex": True,
                            },
                            "confidence": 0.85,
                            "rationale": f"Highlight + 'extra space {('before' if is_before else 'after')} <marked>' (GREP) → {rationale_suffix}",
                            "source_annotation": f"[Highlight on page {annotation.get('page')}]",
                        })
                        return edits, notes

                    # No actionable form — surface for manual review.
                    edits.append(_human_review(
                        f"Reviewer asked about extra space ('{content[:80]}'); no double-space "
                        f"found in marked text — please verify visually",
                        "Hedged-instruction extra-space check"))
                    return edits, notes

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
                # Generic "replace <X> with [an|a] <Y>" instruction — e.g.
                # "replace comma with an em dash (no spaces)" / "replace
                # ampersand with and". Maps X and Y to actual characters and
                # applies within the marked text. The "(no spaces)" /
                # "(with spaces)" modifier controls whether surrounding
                # whitespace is consumed/added around the replacement.
                m = re.match(
                    r"^\s*replace\s+(?:the\s+|an?\s+)?(.+?)\s+with\s+(?:an?\s+|the\s+)?(.+?)\s*$",
                    content_norm)
                if m and marked:
                    raw_x = m.group(1).strip()
                    raw_y = m.group(2).strip()
                    # Detect spacing modifier on the Y side
                    no_spaces   = bool(re.search(r"\(?\s*no\s+spaces?\s*\)?", raw_y))
                    with_spaces = bool(re.search(r"\(?\s*with\s+spaces?\s*\)?", raw_y))
                    # Strip modifiers + filler so we get just the symbol name
                    def _clean_token(tok):
                        tok = re.sub(r"\(.*?\)", "", tok)            # drop "(no spaces)"
                        tok = re.sub(r"\b(no|with)\s+spaces?\b", "", tok)
                        tok = re.sub(r"\s+", " ", tok).strip()
                        return tok
                    word_x = _clean_token(raw_x)
                    word_y = _clean_token(raw_y)
                    char_x = WORD_TO_CHAR.get(word_x)
                    char_y = WORD_TO_CHAR.get(word_y)
                    if char_x and char_y and char_x in marked:
                        if no_spaces:
                            # Drop a single space adjacent to the symbol on
                            # whichever side it appears (typographer's choice
                            # — usually the one closer to text).
                            new_marked = re.sub(
                                re.escape(char_x) + r"\s",
                                char_y, marked, count=1)
                            if new_marked == marked:
                                new_marked = re.sub(
                                    r"\s" + re.escape(char_x),
                                    char_y, marked, count=1)
                            if new_marked == marked:
                                new_marked = marked.replace(char_x, char_y, 1)
                        elif with_spaces:
                            new_marked = marked.replace(char_x, " " + char_y + " ", 1)
                        else:
                            new_marked = marked.replace(char_x, char_y, 1)
                        if new_marked != marked:
                            edits.append({
                                "op": "REPLACE_TEXT",
                                "target": {"find": marked},
                                "params": {"replace_with": new_marked},
                                "confidence": 0.88,
                                "rationale": f"Highlight + '{content[:50]}' → '{char_x}' → '{char_y}'",
                                "source_annotation": f"[Highlight on page {annotation.get('page')}]",
                                "_substitution": (char_x, char_y),
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
                if (("en dash" in content_norm or "en-dash" in content_norm)):
                    # Two situations:
                    #   - marked is "-" / "--" and line has " - "  → swap dash type
                    #   - marked spans text containing any dash (-, –, —) with
                    #     possibly-no surrounding spaces → swap dash type AND
                    #     ensure single space on each side ("with spaces" case)
                    want_spaces = "with space" in content_norm
                    if marked in ("-", "--") and line_text and " - " in line_text:
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
                    # Generic dash-anywhere-in-marked case (covers "ge–in"
                    # when reviewer highlights around an en-dash with no
                    # surrounding spaces and asks for "en dash with spaces")
                    if marked and re.search(r"[\-–—]", marked):
                        if want_spaces:
                            # Replace any dash run (with optional surrounding
                            # whitespace) with " – " so the dash always has
                            # exactly one space each side.
                            new_marked = re.sub(r"\s*[\-–—]+\s*", " – ", marked)
                        else:
                            # Just swap dash type, preserve existing spacing
                            new_marked = re.sub(r"[\-—]", "–", marked)
                        if new_marked != marked:
                            find_str = line_text if (line_text and marked in line_text) else marked
                            replace_str = (
                                line_text.replace(marked, new_marked, 1)
                                if line_text and marked in line_text else new_marked
                            )
                            edits.append({
                                "op": "REPLACE_TEXT",
                                "target": {"find": find_str},
                                "params": {"replace_with": replace_str},
                                "confidence": 0.88,
                                "rationale": (f"Highlight + 'en dash"
                                              + (" with spaces" if want_spaces else "")
                                              + f"' → '{marked[:30]}' → '{new_marked[:30]}'"),
                                "source_annotation": f"[Highlight on page {annotation.get('page')}]",
                                "_substitution": (marked, new_marked),
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
            # "Make this same size as other fields" / "match the size of"
            # — emit SET_TEXT_SIZE_MATCH so the JSX side resizes the
            # cell at the annotation's coords to the modal sibling
            # pointSize. Runs before the Ollama fallback because this is
            # a structured op the rule-based path can handle deterministic-
            # ally; the LLM tends to invent a literal size value instead.
            m_size_match = re.search(
                r"\b(?:same|match(?:ing)?|matched)\s+(?:font\s+)?size\b"
                r"|\bsize\s+to\s+match\b"
                r"|\b(?:make|set)\s+(?:this|it)\s+(?:the\s+)?same\s+size\b",
                content, re.I)
            if m_size_match:
                rect = annotation.get("rect") or []
                page = annotation.get("page")
                if page and len(rect) >= 4:
                    cx = (rect[0] + rect[2]) / 2
                    cy = (rect[1] + rect[3]) / 2
                    edits.append({
                        "op": "SET_TEXT_SIZE_MATCH",
                        "target": {
                            "page": page,
                            "at_pdf_coords": [round(cx, 2), round(cy, 2)],
                            "find": (marked or line_text or "").strip() or None,
                        },
                        "params": {},
                        "confidence": 0.8,
                        "rationale": (
                            f"{atype} + 'same size as other fields' → "
                            "resize target text to modal sibling pointSize"
                        ),
                        "source_annotation": content[:200],
                    })
                    return edits, notes

            # "Remove bold from this en dash" / "make this regular" /
            # "unbold" / "make bold" / "make this italic" / "remove italic"
            # — emit SET_TEXT_STYLE with the action (add/remove bold/italic)
            # and the actual marked text as the restyle target. JSX scopes
            # to the page+coords and applies fontStyle.
            #
            # Detection is keyword-anchored so the regex can't accidentally
            # absorb the existing case-change ("uppercase" / "lowercase" /
            # "title case") or color-change patterns above. Order matters:
            # check the explicit "remove bold" / "remove italic" forms
            # before the generic "make bold" / "make italic" forms (a
            # comment containing both would be ambiguous; let the LLM
            # handle it instead).
            m_style = None
            style_action = None
            if re.search(r"\b(?:remove|strip|drop|delete|kill|no)\s+(?:the\s+)?bold\b|\b(?:make|set)\s+(?:this|it|that)\s+(?:to\s+)?regular\b|\bunbold\b", content, re.I):
                m_style = True; style_action = "remove_bold"
            elif re.search(r"\b(?:remove|strip|drop|delete|kill|no)\s+(?:the\s+)?italic(?:s)?\b|\bunitalic\b", content, re.I):
                m_style = True; style_action = "remove_italic"
            elif re.search(r"\b(?:make|set|add|bold(?:\s*ify)?)\s+(?:this|it|that)?\s*(?:to\s+)?(?:be\s+)?bold\b", content, re.I):
                m_style = True; style_action = "add_bold"
            elif re.search(r"\b(?:make|set|add|italic(?:\s*ize)?)\s+(?:this|it|that)?\s*(?:to\s+)?(?:be\s+)?italic(?:s)?\b", content, re.I):
                m_style = True; style_action = "add_italic"

            if m_style and marked:
                rect = annotation.get("rect") or []
                page = annotation.get("page")
                cx = (rect[0] + rect[2]) / 2 if len(rect) >= 4 else None
                cy = (rect[1] + rect[3]) / 2 if len(rect) >= 4 else None
                tgt = {"find": marked, "line_text": line_text or None}
                if page: tgt["page"] = page
                if cx is not None and cy is not None:
                    tgt["at_pdf_coords"] = [round(cx, 2), round(cy, 2)]
                edits.append({
                    "op": "SET_TEXT_STYLE",
                    "target": tgt,
                    "params": {"action": style_action},
                    "confidence": 0.85,
                    "rationale": (
                        f"{atype} + '{style_action.replace('_', ' ')}' "
                        f"instruction → restyle '{marked[:30]}'"
                    ),
                    "source_annotation": f"[{atype} on page {annotation.get('page')}] '{content[:80]}'",
                })
                return edits, notes

            # "Move <word> down to next line" / "wrap <word> to next line"
            # / "break before <word>" — emit a REPLACE_TEXT that prepends
            # a forced line break ( ) before the target word. We
            # anchor the find on the WORD-BEFORE + target so the edit
            # only fires once at the actual location (not every
            # occurrence of the target word doc-wide). LLMs handle this
            # poorly — they often hallucinate a casing change instead.
            m_break_before = re.search(
                r"\bmove\s+([A-Za-z][\w-]*)\s+(?:down\s+)?(?:to\s+)?(?:the\s+)?next\s+line\b"
                r"|\bwrap\s+([A-Za-z][\w-]*)\s+(?:to\s+)?(?:the\s+)?next\s+line\b"
                r"|\bbreak\s+(?:line\s+)?before\s+([A-Za-z][\w-]*)\b"
                r"|\bnew\s+line\s+before\s+([A-Za-z][\w-]*)\b",
                content, re.I)
            if m_break_before:
                target_word = (m_break_before.group(1) or m_break_before.group(2)
                               or m_break_before.group(3) or m_break_before.group(4) or "").strip()
                if target_word and line_text:
                    # Capture as much context BEFORE the target as possible
                    # (1-4 words). A 1-word anchor like "the ENERGY" can
                    # match every "the ENERGY STAR" on the page; a 4-word
                    # anchor like "or exceed the ENERGY" is nearly always
                    # unique within a body paragraph.
                    multi_anchor = re.compile(
                        r"((?:\S+\s+){1,4})" + re.escape(target_word) + r"\b",
                        re.I)
                    am = multi_anchor.search(line_text)
                    if am:
                        prefix = am.group(1)
                        actual_target = line_text[am.end() - len(target_word):am.end()]
                        # changeGrep with a literal "\n" token in the
                        # replacement is the reliable way to insert a
                        # forced line break — InDesign's GREP engine
                        # treats "\n" as the special-character code for
                        # forced-line-break. (U+2028 inserted via
                        # changeText doesn't always trigger the body
                        # composer to actually break.)
                        # Build regex from word splits so spaces become \s+ (which
                        # the GREP engine understands) instead of "\ "
                        # (which Python's re.escape produces but InDesign's
                        # GREP engine may reject).
                        words_before = prefix.rstrip().split()
                        find_grep = r"\s+".join(re.escape(w) for w in words_before) + r"\s+" + re.escape(actual_target)
                        # Python source "\\n" → Python string r"\n" (2
                        # chars: backslash + n). JSON serialises as
                        # "\\n", eval gives back "\n" — the literal
                        # 2-char sequence the GREP engine recognises.
                        replace_grep = prefix.rstrip() + "\\n" + actual_target
                        edits.append({
                            "op": "REPLACE_TEXT",
                            "target": {"find": find_grep},
                            "params": {
                                "replace_with": replace_grep,
                                "is_regex": True,
                            },
                            "confidence": 0.85,
                            "rationale": (
                                f"{atype} + 'move {target_word} to next line' "
                                f"→ GREP insert forced line break before '{target_word}'"
                            ),
                            "source_annotation": f"[{atype} on page {annotation.get('page')}] '{content[:80]}'",
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

    # ---- Pattern: "make this same size as other fields" → SET_TEXT_SIZE_MATCH
    # Sticky-note annotations asking the reviewer to bring a single
    # mis-sized label/cell into line with the rest of the form. The
    # JSX handler walks sibling cells in the same table and applies the
    # modal pointSize, so Python only needs to detect the intent and
    # forward the annotation's coords.
    m_size_match = re.search(
        r"\b(?:same|match(?:ing)?|matched)\s+(?:font\s+)?size\b"
        r"|\bsize\s+to\s+match\b"
        r"|\bmatch(?:ing)?\s+(?:the\s+)?(?:font\s+)?size\s+(?:of|to)\b"
        r"|\bsame\s+(?:font\s+)?size\s+as\b"
        r"|\b(?:make|set)\s+(?:this|it)\s+(?:the\s+)?same\s+size\b",
        content, re.I)
    if m_size_match:
        rect = annotation.get("rect") or []
        page = annotation.get("page")
        if page and len(rect) >= 4:
            cx = (rect[0] + rect[2]) / 2
            cy = (rect[1] + rect[3]) / 2
            edits.append({
                "op": "SET_TEXT_SIZE_MATCH",
                "target": {
                    "page": page,
                    "at_pdf_coords": [round(cx, 2), round(cy, 2)],
                },
                "params": {},
                "confidence": 0.8,
                "rationale": (
                    "Matched 'same size as other fields' instruction → "
                    "resize target cell to modal sibling pointSize"
                ),
                "source_annotation": content[:200],
            })
            return edits, notes

    # ---- Pattern: cell-fill / text-color change → SET_CELL_FILL or SET_TEXT_COLOR
    # Sticky-note annotations like "make this header gray", "change to white",
    # or just "blue" near an element. We detect:
    #   - Color spec in the comment (lexicon word, "light X" / "dark X",
    #     "C=## M=## Y=## K=##" CMYK literal, or "#RRGGBB" hex)
    #   - Element hint (text vs. cell/row/column) to choose the op
    # The JSX side handles the actual color resolution at apply time —
    # Python emits a plain color spec string and the JSX maps it to a
    # Swatch via doc.swatches lookup, CMYK literal parse, hex parse, or
    # a small color-word lexicon, in that order.
    color_change = _detect_color_change(content)
    if color_change:
        rect = annotation.get("rect") or []
        if len(rect) >= 4:
            cx = (rect[0] + rect[2]) / 2
            cy = (rect[1] + rect[3]) / 2
            page = annotation.get("page")
            if color_change.get("element_hint") == "text":
                edits.append({
                    "op": "SET_TEXT_COLOR",
                    "target": {
                        "page": page,
                        "at_pdf_coords": [round(cx, 2), round(cy, 2)],
                        "find": (annotation.get("line_text") or "").strip() or None,
                    },
                    "params": {"color": color_change["color_spec"]},
                    "confidence": 0.78,
                    "rationale": f"Matched color-change comment → set text color to {color_change['color_spec']}",
                    "source_annotation": content[:200],
                })
                return edits, notes
            edits.append({
                "op": "SET_CELL_FILL",
                "target": {
                    "page": page,
                    "at_pdf_coords": [round(cx, 2), round(cy, 2)],
                    "scope": color_change.get("scope", "cell"),
                },
                "params": {"color": color_change["color_spec"]},
                "confidence": 0.78,
                "rationale": (f"Matched color-change comment → set "
                              f"{color_change.get('scope', 'cell')} fill to "
                              f"{color_change['color_spec']}"),
                "source_annotation": content[:200],
            })
            return edits, notes

    # ---- Pattern: table cell-edge stroke change → SET_CELL_STROKE
    # Sticky-note annotations like "can we delete this black line?" or
    # "remove this border" pointing at a column/row separator inside a
    # table. The JSX side resolves the annotation's PDF coords to the
    # nearest table + cell edge at apply time — we just emit the intent.
    m_stroke = re.search(
        r"\b(?:delete|remove|drop|kill|hide|get\s*rid\s*of)\b"
        r"[\s\w]*?"
        r"\b(?:line|rule|border|stroke|divider|separator)s?\b",
        content, re.I)
    m_recolor = None
    if not m_stroke:
        # "make/change this line gray" / "this border should be light gray"
        m_recolor = re.search(
            r"\b(?:line|rule|border|stroke|divider|separator)\b[\s\w]{0,40}?"
            r"\b(?:to|into|in|should\s*be)\s+([A-Za-z][A-Za-z0-9 ]{1,30})",
            content, re.I)
    if m_stroke or m_recolor:
        rect = annotation.get("rect") or []
        if len(rect) >= 4:
            cx = (rect[0] + rect[2]) / 2
            cy = (rect[1] + rect[3]) / 2
            # Orientation: the inspector exports columnEdges per table in
            # spread/POINTS coords. If our annotation's X sits within a
            # few points of an INTERNAL column edge, we know the reviewer
            # is pointing at a vertical column separator — much more
            # reliable than the JSX's frame-relative row-edge math (the
            # frame may contain a title above the table, throwing off row
            # offsets). If the comment names the orientation explicitly,
            # honor that.
            orient = None
            if re.search(r"\bvertical\b", content, re.I):
                orient = "vertical"
            elif re.search(r"\bhorizontal\b", content, re.I):
                orient = "horizontal"
            if orient is None and doc_inspection:
                ann_page = annotation.get("page")
                tol_pt = 6.0
                near_col_edge = False
                for p_info in (doc_inspection.get("pages") or []):
                    if p_info.get("page") != ann_page:
                        continue
                    for fr in (p_info.get("frames") or []):
                        fb = fr.get("bounds") or []  # [y1, x1, y2, x2]
                        if len(fb) < 4: continue
                        # Only consider frames whose bounds (loose) contain cx,cy
                        if not (fb[1] - 5 <= cx <= fb[3] + 5 and fb[0] - 5 <= cy <= fb[2] + 5):
                            continue
                        for tbl_info in (fr.get("tables") or []):
                            edges = tbl_info.get("columnEdges") or []
                            # Skip outer borders (index 0 and last)
                            for ei in range(1, len(edges) - 1):
                                if abs(cx - edges[ei]) <= tol_pt:
                                    near_col_edge = True
                                    break
                            if near_col_edge: break
                        if near_col_edge: break
                    if near_col_edge: break
                orient = "vertical" if near_col_edge else "auto"
            if orient is None:
                orient = "auto"
            params = {"weight": 0}
            if m_recolor:
                # Recolor instead of delete — caller asked for a specific
                # color. Match the captured name to a reasonable Swatch
                # name; if it's a generic word we can't map, fall back to
                # the literal string and let the JSX try doc.swatches.
                color_word = m_recolor.group(1).strip().rstrip(".,;:")
                params = {"weight": 0.25, "color": color_word}
            edits.append({
                "op": "SET_CELL_STROKE",
                "target": {
                    "page": annotation.get("page"),
                    "at_pdf_coords": [round(cx, 2), round(cy, 2)],
                    "orientation": orient,
                },
                "params": params,
                "confidence": 0.8,
                "rationale": (
                    f"Matched '{('delete' if m_stroke else 'recolor')} "
                    f"line/border' near table — "
                    f"{('zero stroke weight' if m_stroke else 'recolor stroke')} "
                    f"on the closest cell edge"),
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

    # ---- Pattern: asset relink — "replace [X] with [filename.ext]"
    # Reviewer wants to swap the contents of an existing image frame, not
    # the page text. Trigger when the comment matches a "replace X with Y"
    # shape AND Y is the filename of a supplied reference file. We emit a
    # RELINK_IMAGE edit that the JSX uses to find the placed graphic by
    # name-substring (e.g. "dabo" matches "DABO LOGO reversed.ai") and
    # re-point its link — preserving the existing frame's bounds, scale,
    # and transforms. Tolerant of the common "Replce / Repalce" typo.
    if reference_files:
        m_relink = re.search(
            r"(?:re?p[lac]+e|replce|swap(?:\s+out)?|change|update)\s+"
            r"(?:the\s+)?([^,\.\n]{2,80}?)\s+"
            r"(?:with|to|for|→|->)\s+"
            r"(?:the\s+)?([\w\-\.\s]+?\.(?:psd|ai|eps|jpg|jpeg|png|tif|tiff|pdf|indd))\b",
            content, re.I)
        if m_relink:
            target_phrase = m_relink.group(1).strip()
            new_filename = m_relink.group(2).strip()
            # Match the cited filename to a reference file (case-insensitive,
            # accept either the full filename or a stem-only mention).
            new_ref = None
            new_filename_lc = new_filename.lower()
            for rf in reference_files:
                if rf.get("name", "").lower() == new_filename_lc:
                    new_ref = rf; break
            if not new_ref:
                # Stem match (cited "ECN_Main_Logo_Color" against
                # "ECN_Main_Logo_Color.psd")
                stem = re.sub(r"\.[a-z0-9]{2,5}$", "", new_filename_lc)
                for rf in reference_files:
                    if rf.get("name", "").lower().startswith(stem + "."):
                        new_ref = rf; break
            if new_ref:
                # Distill `target_phrase` to a short, distinctive substring
                # to match against the existing graphic's link name. Strip
                # generic noun suffixes like "logo", "image", "graphic" so
                # "dabo logo" → "dabo" matches "DABO LOGO reversed.ai" via
                # substring (the noun is usually in the link name already).
                anchor = re.sub(
                    r"\b(?:logo|image|graphic|photo|icon|picture|art|artwork|file)s?\b",
                    "", target_phrase, flags=re.I).strip()
                # Drop articles / leading filler
                anchor = re.sub(r"^(?:the|a|an|this|that|current|old|existing)\s+",
                                "", anchor, flags=re.I).strip()
                # Take the most distinctive word (longest alphanumeric token)
                tokens = re.findall(r"[A-Za-z0-9]{2,}", anchor)
                if tokens:
                    anchor = max(tokens, key=len)
                if anchor and len(anchor) >= 2:
                    # Doc-wide by default: a logo/image swap almost always
                    # means "wherever this asset appears." If a reviewer
                    # only wanted to swap one occurrence, they'd describe it
                    # ("on the back" / "on page 2"); the rule-based path
                    # doesn't try to honor that — let HUMAN_REVIEW handle
                    # ambiguous scoping.
                    edits.append({
                        "op": "RELINK_IMAGE",
                        "target": {"name_match": anchor},
                        "params": {"new_file_path": new_ref["path"]},
                        "confidence": 0.85,
                        "rationale": (f"Matched 'replace {target_phrase} with "
                                      f"{new_ref['name']}' → relink graphics "
                                      f"matching '{anchor}' doc-wide"),
                        "source_annotation": content[:200],
                    })
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


def _build_fallback_targets(marked, replacement, line_text):
    """Build the optional fallback_find / fallback2_find / fallback_replace_with /
    fallback2_replace_with values that get attached to a REPLACE_TEXT edit.

    Returns (fb_find, fb_replace, fb2_find, fb2_replace). Any of them may
    be None if not applicable. Used by strike+comment, strike-only-delete,
    and the disambiguated single-letter-case-fix paths so the JSX can fall
    back when a long line-scoped find doesn't match InDesign's actual text
    (cell boundaries, threaded frames, NBSP, etc.).

    Rules:
      - fb_find: just `marked`, when len(marked) >= 5 AND has alphanumerics.
        Safe doc-wide for unique-ish substrings.
      - fb2_find: marked + 1 word of context on each side from line_text.
        Captures cases like "&" / "from" / "be" — too short to be safe
        globally, but uniquely identifiable with a tiny bit of surrounding
        context. Only emitted when meaningfully longer than the marked itself.
    """
    fb_find = fb_replace = None
    fb2_find = fb2_replace = None
    if marked and len(marked) >= 5 and any(ch.isalnum() for ch in marked):
        fb_find = marked
        fb_replace = replacement
    if marked and line_text:
        idx = line_text.find(marked)
        if idx >= 0:
            before = line_text[:idx].rstrip()
            after = line_text[idx + len(marked):].lstrip()
            bm = re.search(r"(\S+)\s*$", before)
            am = re.match(r"\s*(\S+)", after)
            bw = bm.group(1) if bm else ""
            aw = am.group(1) if am else ""
            # Single non-alphanumeric chars (`:`, `.`, `,`, `;`, `?`, `!`,
            # `§`, `¶`, `†`, `‡`, `✓`, `★`, …) attach DIRECTLY to the
            # preceding word with no whitespace ("Discounts§", "property:",
            # "level."). Use a LEFT-only context with no space between
            # bw and marked so the find string mirrors the actual text:
            #   - ASCII punctuation: avoids consuming form-field glyphs
            #     (☐, ■) on the right side via GREP fallback
            #   - Symbols / dingbats: matches the real "word§" sequence
            #     even when line_text reconstruction grafted on text from
            #     a neighboring cell ("Incentive Unit Lighting Discounts§")
            # `marked.isspace()` is excluded — we never want to bind
            # whitespace to a preceding word.
            is_attached_punct = (len(marked) == 1 and not marked.isalnum()
                                 and not marked.isspace())
            if is_attached_punct and bw:
                ctx_find = bw + marked
                ctx_replace = bw + replacement
                if len(ctx_find) >= max(8, len(marked) + 4) and ctx_find != fb_find:
                    fb2_find = ctx_find
                    fb2_replace = ctx_replace
            elif bw or aw:
                ctx_find = (bw + " " if bw else "") + marked + (" " + aw if aw else "")
                ctx_replace = (bw + " " if bw else "") + replacement + (" " + aw if aw else "")
                if len(ctx_find) >= max(8, len(marked) + 4) and ctx_find != fb_find:
                    fb2_find = ctx_find
                    fb2_replace = ctx_replace
    return fb_find, fb_replace, fb2_find, fb2_replace


# Color-word lexicon for the color-change rule. Single words plus the
# common modifier prefixes ("light X" / "dark X"). Brand swatch names
# like "DTE Blue" aren't on this list — those resolve via doc.swatches
# at apply time when the designer set them up in the source file.
_COLOR_WORDS = {
    "red", "blue", "green", "yellow", "orange", "purple", "violet", "pink",
    "brown", "gray", "grey", "black", "white", "cyan", "magenta", "teal",
    "gold", "silver", "navy", "maroon", "lime", "olive", "tan", "beige",
}
_COLOR_MODIFIERS = {"light", "dark", "bright", "deep", "pale"}
_VERB_RE = re.compile(
    r"\b(?:make|change|changed|set|recolor|recoloured|recolored|fill|filled|"
    r"paint|painted|tint|tinted|swap|swapped"
    r"|should\s+be|needs?\s+to\s+be|must\s+be|has\s+to\s+be|gotta\s+be"
    r"|change\s+to|set\s+to|update\s+to|colou?r\s+to)\b",
    re.I,
)
_CMYK_LITERAL_RE = re.compile(
    r"\bC\s*=\s*(\d+)\s+M\s*=\s*(\d+)\s+Y\s*=\s*(\d+)\s+K\s*=\s*(\d+)\b",
    re.I,
)
_HEX_LITERAL_RE = re.compile(r"#([0-9A-Fa-f]{6})\b")
# Brand swatch tokens look like "DTE Blue" or "Pepco Purple" — capitalized
# multi-word names where the LAST word is a basic color. Captured as-is
# so the JSX swatch lookup gets the original casing.
_BRAND_SWATCH_RE = re.compile(
    r"\b([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){0,2}\s+(?:Blue|Red|Green|Yellow|Purple|Orange|Pink|Black|White|Gray|Grey|Gold))\b"
)


def _detect_color_change(content):
    """Detect a color-change intent in a sticky-note comment.

    Returns a dict like {color_spec, element_hint, scope} on a hit, or
    None when the comment isn't a color change. Tight matching — we
    require either an explicit verb (make/change/set/etc.) OR a comment
    that's basically just a color word, to avoid false-positives on
    body-text edits like "this is too blue compared to..." which use
    color words descriptively rather than as instructions.
    """
    if not content:
        return None
    text = content.strip()
    if not text or len(text) > 120:
        return None
    lc = text.lower()

    # 1. CMYK literal anywhere in the comment
    cmyk = _CMYK_LITERAL_RE.search(text)
    color_spec = None
    if cmyk:
        color_spec = f"C={int(cmyk.group(1))} M={int(cmyk.group(2))} Y={int(cmyk.group(3))} K={int(cmyk.group(4))}"
    if not color_spec:
        # 2. Hex literal
        hx = _HEX_LITERAL_RE.search(text)
        if hx:
            color_spec = "#" + hx.group(1).upper()
    if not color_spec:
        # 3. Brand-style proper-noun swatch (preserve original casing)
        b = _BRAND_SWATCH_RE.search(text)
        if b:
            color_spec = b.group(1).strip()
    if not color_spec:
        # 4. Modifier + color ("light gray", "dark blue") — single space
        m_mod = re.search(
            r"\b(" + "|".join(_COLOR_MODIFIERS) + r")\s+([a-z]+)\b",
            lc,
        )
        if m_mod and m_mod.group(2) in _COLOR_WORDS:
            color_spec = m_mod.group(1) + " " + m_mod.group(2)
    if not color_spec:
        # 5. Plain color word
        for w in re.findall(r"\b([a-z]+)\b", lc):
            if w in _COLOR_WORDS:
                color_spec = w
                break
    if not color_spec:
        return None

    # Intent gate: must have an action verb OR be a color-only comment
    # (the entire content is just the color phrase, possibly with a few
    # filler words like "to" or "should be"). Prevents matching things
    # like a long descriptive paragraph that happens to mention "blue".
    has_verb = bool(_VERB_RE.search(text))
    is_color_only = bool(re.match(
        r"^\s*(?:to\s+|should\s+be\s+|needs\s+to\s+be\s+|=\s*)?"
        + re.escape(color_spec) + r"\s*[.!]?\s*$",
        text, re.I,
    ))
    if not (has_verb or is_color_only):
        return None

    # Element / scope hints
    element_hint = None
    scope = "cell"
    if re.search(r"\b(text|font|type|letters?|characters?|words?)\b", lc):
        element_hint = "text"
    elif re.search(r"\brow\b", lc):
        scope = "row"
    elif re.search(r"\bcolumn\b", lc):
        scope = "column"
    elif re.search(r"\b(header|cell)\b", lc):
        scope = "row"  # "header" usually means the whole header row

    return {
        "color_spec": color_spec,
        "element_hint": element_hint,
        "scope": scope,
    }


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

    def _point_to_rect_offsets(px, py, rect):
        # (dx, dy) from a point to the nearest edge of the rect; (0, 0) if
        # the point is inside. Used so a tall multi-line strike (whose
        # bounding rect spans both lines and centers between them) doesn't
        # blow past the dx threshold when the comment sits at one end.
        x0, y0, x1, y1 = rect[0], rect[1], rect[2], rect[3]
        dx = max(x0 - px, 0.0, px - x1)
        dy = max(y0 - py, 0.0, py - y1)
        return dx, dy

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

    # Process strikethroughs in TWO passes so longer-marked strikes claim
    # comments first. Without this, a punctuation-only strike (e.g. ".")
    # sitting right next to a meaty strike ("whole home assessment") on the
    # same line could steal the reviewer's replacement comment, leaving the
    # meaty edit as a silent delete.
    def _strike_priority(s):
        m = (s.get("marked_text") or "").strip()
        # Trivial = single-char punctuation. Those should pair LAST.
        is_trivial = len(m) <= 2 and not any(ch.isalnum() for ch in m)
        return 0 if is_trivial else 1   # 1 = priority pass, 0 = fallback pass
    ordered_strikes = sorted(
        [a for a in annotations if a.get("type") == "StrikeOut"],
        key=lambda s: -_strike_priority(s)  # priority 1 first
    )

    for stk in ordered_strikes:
        rect = stk.get("rect")
        if not rect or len(rect) < 4:
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
            # Distance from the comment center to the nearest edge of the
            # strike rect (0 if the comment sits inside the rect). Using
            # point-to-rect rather than center-to-center matters when a
            # strike spans a line break — its bounding rect is wide and
            # centers between the two lines, so the actual marked text
            # ("three" at the end of line 1, "month" at the start of line 2)
            # can be 200+pt from the rect's centroid even though the caret
            # comment sits right on top of one of the marked words.
            dx, dy = _point_to_rect_offsets(c2[0], c2[1], rect)
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
            # Propagate the comment's nearby_text — useful for disambiguating
            # single-letter case fixes ("strikeout 'p' + comment 'P'") when
            # the line has multiple matching letters.
            stk["paired_nearby_text"] = (comment.get("nearby_text") or "").strip()
            # Multi-line strikes only carry the FIRST line in their
            # `line_text` (reconstruction is centered on the rect midpoint,
            # which lands between the two lines). When the marked text isn't
            # contained in the strike's line_text, splice in the comment's
            # line_text so the line-scoped REPLACE_TEXT path can build a
            # proper find/replace string covering both lines.
            stk_marked = (stk.get("marked_text") or "").strip()
            stk_line = (stk.get("line_text") or "").strip()
            cmt_line = (comment.get("line_text") or "").strip()
            if (stk_marked and stk_line and cmt_line and
                    stk_line != cmt_line and stk_marked not in stk_line):
                combined = (stk_line + " " + cmt_line).strip()
                if stk_marked in combined:
                    stk["line_text"] = combined
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
        merged_edit = {
            "op": "REPLACE_TEXT",
            "target": {"find": find},
            "params": {"replace_with": running},
            "confidence": min(confs) if confs else 0.85,
            "rationale": " + ".join(r for r in rationales if r) or "Merged line edits",
            "source_annotation": " | ".join(s for s in sources if s),
        }
        # Preserve fallback fields from the LONGEST-marked edit (most
        # likely to be the primary substitution; short companions are
        # usually period-deletes that don't have or need a fallback).
        primary = group[0]
        for fb_key in ("fallback_find", "fallback2_find"):
            if primary.get("target", {}).get(fb_key):
                merged_edit["target"][fb_key] = primary["target"][fb_key]
        for fb_key in ("fallback_replace_with", "fallback2_replace_with"):
            if primary.get("params", {}).get(fb_key):
                merged_edit["params"][fb_key] = primary["params"][fb_key]
        merged.append(merged_edit)
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
        # Tag every REPLACE_TEXT this annotation produces with the
        # annotation's page + rect-center so the JSX can scope find/
        # replace to the text frame the reviewer actually drew on. A
        # strike on "Mini" in one cell shouldn't trigger a doc-wide
        # substitution if the same string appears in another template
        # somewhere else in the doc — the JSX prefers the scoped frame
        # and only falls through to doc-wide when the scoped find finds
        # nothing.
        ann_page = ann.get("page")
        ann_rect = ann.get("rect") or []
        if ann_page and len(ann_rect) >= 4:
            ann_cx = round((ann_rect[0] + ann_rect[2]) / 2, 2)
            ann_cy = round((ann_rect[1] + ann_rect[3]) / 2, 2)
            for e in edits:
                if e.get("op") != "REPLACE_TEXT":
                    continue
                target = e.setdefault("target", {})
                if "page" not in target:
                    target["page"] = ann_page
                if "at_pdf_coords" not in target:
                    target["at_pdf_coords"] = [ann_cx, ann_cy]
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
        elif op in ("SET_CELL_FILL", "SET_TEXT_COLOR"):
            # Two color-change comments at different points in the same
            # doc must stay distinct. Key on coords + scope + color spec.
            coords = target.get("at_pdf_coords") or []
            cx = round(coords[0]) if len(coords) > 0 else ""
            cy = round(coords[1]) if len(coords) > 1 else ""
            key_parts.append(str(target.get("page", "")))
            key_parts.append(f"{cx}x{cy}")
            key_parts.append(target.get("scope", ""))
            key_parts.append(target.get("find", "") or "")
            key_parts.append((e.get("params") or {}).get("color", "") or "")
        elif op == "SET_CELL_STROKE":
            # Each "delete this line" sticky note typically points at a
            # different column or row boundary, so keep them distinct
            # by coordinate. Round to integer points to absorb tiny
            # rect-center jitter from the PDF reader.
            coords = target.get("at_pdf_coords") or []
            cx = round(coords[0]) if len(coords) > 0 else ""
            cy = round(coords[1]) if len(coords) > 1 else ""
            key_parts.append(str(target.get("page", "")))
            key_parts.append(f"{cx}x{cy}")
            key_parts.append(target.get("orientation", ""))
        elif op == "SET_TEXT_SIZE_MATCH":
            coords = target.get("at_pdf_coords") or []
            cx = round(coords[0]) if len(coords) > 0 else ""
            cy = round(coords[1]) if len(coords) > 1 else ""
            key_parts.append(str(target.get("page", "")))
            key_parts.append(f"{cx}x{cy}")
        elif op == "SET_TEXT_STYLE":
            coords = target.get("at_pdf_coords") or []
            cx = round(coords[0]) if len(coords) > 0 else ""
            cy = round(coords[1]) if len(coords) > 1 else ""
            key_parts.append(str(target.get("page", "")))
            key_parts.append(f"{cx}x{cy}")
            key_parts.append(target.get("find", "") or "")
            key_parts.append((e.get("params") or {}).get("action", "") or "")
        elif op == "RELINK_IMAGE":
            # Two annotations of the same swap (e.g. one sticky note per
            # page asking to swap the same logo) collapse to one edit
            # because the JSX walks the whole doc anyway. But two genuinely
            # different relinks ("swap dabo for ECN" + "swap DTE for X")
            # must stay distinct, so the key includes both the anchor
            # we're matching against and the destination file.
            key_parts.append(target.get("name_match", "") or "")
            key_parts.append(target.get("path_match", "") or "")
            key_parts.append((e.get("params") or {}).get("new_file_path", ""))
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
