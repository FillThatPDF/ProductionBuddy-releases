"""One-off template auto-tagger for Data Merge.

Given:
  - A "source-of-truth" Excel sheet (e.g. California's row 2)
  - An InDesign template containing those values rendered as text
    ($494,563,635, 21%, etc.)

Produce:
  - A tagged copy of the template where each value is replaced by
    <<placeholder_name>>
  - A CSV ready to feed into InDesign's Data Merge panel

The matching is fuzzy on number FORMATTING, strict on identity:
  - Excel raw value 494563635 → tries "494563635", "494,563,635",
    "$494,563,635", "$494.5M", "$494M", "$0.5B", etc.
  - Picks the formatted variant that appears EXACTLY ONCE in the
    template (low collision risk). Multi-match or no-match → skipped.
  - Tiny numbers (< 1000) are only tagged when their LINE CONTEXT is
    a unique match — otherwise we'd accidentally rewrite "21" anywhere
    it appears.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import List

from data_merge import _sanitize_column_name, _read_sheet_data


HERE = Path(__file__).parent
JSX_DIR = HERE.parent / "jsx"


# ----- Number formatting candidates -----

def _format_candidates(raw):
    """Return all plausible InDesign-rendered forms of a numeric value."""
    s = str(raw).strip()
    if not s or s.upper() in ("NA", "N/A", "NULL", "NONE"):
        return []
    # Already non-numeric → just literal
    try:
        n = float(s.replace(",", ""))
    except ValueError:
        return [s]
    out = set()
    # Integer literal forms
    if n == int(n):
        ni = int(n)
        out.add(str(ni))
        out.add(f"{ni:,}")
        out.add(f"${ni:,}")
        out.add(f"${ni}")
        # With .00 decimals (InDesign sometimes shows currency that way)
        out.add(f"${ni:,}.00")
        out.add(f"{ni:,}.00")
        # The "$X.YYY,ZZZ.00" typo'd format spotted in this template
        # (period and comma swapped in the thousand-separator group)
        if ni >= 1_000_000:
            s_int = f"{ni:,}"  # e.g. "434,297,211"
            parts = s_int.split(",")
            if len(parts) >= 2:
                # First separator becomes "." instead of ","
                weird = parts[0] + "." + ",".join(parts[1:])
                out.add(f"${weird}.00")
                out.add(f"{weird}.00")
        # M / B suffixes
        if abs(ni) >= 1_000_000:
            m = ni / 1_000_000
            for fmt in (f"${m:.1f}M", f"${int(round(m))}M", f"${m:.2f}M"):
                out.add(fmt)
        if abs(ni) >= 1_000_000_000:
            b = ni / 1_000_000_000
            for fmt in (f"${b:.1f}B", f"${int(round(b))}B", f"${b:.2f}B"):
                out.add(fmt)
        # K suffix
        if abs(ni) >= 1_000:
            k = ni / 1_000
            out.add(f"${int(round(k))}K")
            out.add(f"{int(round(k))}K")
    else:
        # Float — keep two decimals + integer-rounded variant
        out.add(f"{n:,.2f}")
        out.add(f"${n:,.2f}")
        out.add(f"{int(round(n)):,}")
        out.add(f"${int(round(n)):,}")
    # Percent (only for small ints/floats — guard against multi-digit large numbers)
    if 0 < n <= 100:
        if n == int(n):
            out.add(f"{int(n)}%")
        out.add(f"{n:.0f}%")
    # Plain rounded integer with no commas
    out.add(str(int(round(n))))
    return [v for v in out if v]


def _header_keywords(header: str) -> list:
    """Extract the distinctive keyword(s) from a column header for context
    matching. e.g. 'Clinical Trials Programs - Inflammation' →
    ['inflammation']; 'Investment - Capital Investment in (State)
    Facilities' → ['capital investment'].
    """
    s = (header or "").strip()
    s = re.sub(r"\([^)]*\)", "", s)         # drop parentheticals
    s = re.sub(r"\s+", " ", s).strip()
    # Take everything after the LAST "-" or ":"
    for sep in (" - ", ":"):
        idx = s.rfind(sep)
        if idx >= 0:
            s = s[idx + len(sep):]
    s = s.strip(" -:,&")
    # Stopwords / generic terms that aren't unique enough
    STOP = {"and", "or", "the", "a", "an", "of", "in", "to", "for",
            "programs", "program", "investments", "investment", "value",
            "specific", "grants", "areas", "area", "research"}
    words = [w for w in re.findall(r"[A-Za-z]+", s) if w.lower() not in STOP]
    if not words:
        return []
    keyword = " ".join(words[:3]).lower()
    return [keyword]


def _find_value_near_keyword(template_text: str, keywords: list,
                             candidates: list, window: int = 80):
    """Look for any of the formatted-value candidates within `window` chars
    of any keyword. Returns a dict {value, context_find, context_replace_template}
    where:
      - `value` is the matched candidate (e.g. "9")
      - `context_find` is a UNIQUE surrounding string that contains the value
        (e.g. "Inflammation: 9") — safe to use as a global find/change target
      - `context_replace_template` is the same surrounding string with the
        value position marked by `{V}` so the caller can splice in the
        placeholder (e.g. "Inflammation: {V}")

    Returns None if no match.

    The wrapping is critical: a bare "9" matches 10+ places across the doc
    so a global REPLACE_TEXT would over-tag. Wrapping the find with its
    label ("Inflammation: 9") makes the replacement surgical.
    """
    if not keywords:
        return None
    lower_text = template_text.lower()
    for kw in keywords:
        for m in re.finditer(re.escape(kw.lower()), lower_text):
            chunk_start = max(0, m.start() - window)
            chunk_end = min(len(template_text), m.end() + window)
            chunk = template_text[chunk_start:chunk_end]
            for c in candidates:
                pos = chunk.find(c)
                if pos < 0:
                    continue
                kw_start_in_chunk = m.start() - chunk_start
                kw_end_in_chunk   = m.end() - chunk_start
                find_start = kw_start_in_chunk
                find_end   = pos + len(c)
                if find_end <= find_start:
                    find_start, find_end = pos, kw_end_in_chunk
                ctx_find = chunk[find_start:find_end]
                if not ctx_find.strip():
                    continue
                # InDesign's findText doesn't reliably match across
                # paragraph breaks (\n in the dump = paragraph in the
                # actual story). Skip wrapped finds that span newlines.
                if "\n" in ctx_find or "\r" in ctx_find:
                    continue
                value_pos_in_ctx = ctx_find.rfind(c)
                if value_pos_in_ctx < 0:
                    continue
                ctx_replace_tmpl = (
                    ctx_find[:value_pos_in_ctx] + "{V}" +
                    ctx_find[value_pos_in_ctx + len(c):]
                )
                return {
                    "value": c,
                    "context_find": ctx_find,
                    "context_replace_template": ctx_replace_tmpl,
                }
    return None


# ----- Driver -----

def collect_template_text(indd_path: str | Path, work_dir: str | Path,
                          app_name: str = "Adobe InDesign 2026") -> str:
    """Run a one-off JSX that reads every story in the .indd and dumps the
    concatenated text to a file. Returns the text."""
    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    out_txt = work_dir / "_template_text_dump.txt"
    jsx_path = work_dir / "_dump_template_text.jsx"
    jsx_src = f'''#target indesign
(function () {{
    var path = "{indd_path}";
    var outPath = "{out_txt}";
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    var doc = app.open(File(path), false);
    var bits = [];
    for (var i = 0; i < doc.stories.length; i++) {{
        try {{ bits.push(String(doc.stories[i].contents)); }} catch (e) {{}}
    }}
    var f = File(outPath); f.encoding = "UTF-8"; f.open("w");
    f.write(bits.join("\\n----STORY----\\n")); f.close();
    doc.close(SaveOptions.NO);
}})();'''
    jsx_path.write_text(jsx_src)
    proc = subprocess.run([
        "osascript",
        "-e", "with timeout of 600 seconds",
        "-e", f'tell application "{app_name}"',
        "-e", f'do script (POSIX file "{jsx_path}") language javascript',
        "-e", "end tell",
        "-e", "end timeout",
    ], capture_output=True, text=True, timeout=600)
    if proc.returncode != 0:
        raise RuntimeError(f"JSX text-dump failed: {proc.stderr}")
    return out_txt.read_text()


def plan_tags(template_text: str, source_row: dict, headers_by_sn: dict,
              tiny_threshold: int = 1000) -> dict:
    """Decide which formatted-value → placeholder substitutions to apply.

    Strategy:
      - Process largest values first (least collision risk).
      - For each column's value, try every formatted variant; keep the
        ones that match anywhere in the template.
      - **Multi-occurrence is OK** — if "$494,563,635" appears 2x in the
        template, both are almost certainly the same metric shown in
        different sections, so we tag both with the same placeholder.
      - If two DIFFERENT columns produce the SAME formatted variant
        (e.g. column A and column B both equal $27,164,139), only the
        first column wins. Subsequent ones are recorded as collisions.
      - Tiny numbers (raw value < `tiny_threshold`) are skipped unless
        a candidate has a $/% prefix or % suffix that makes it
        unmistakably a metric (e.g. "21%", "$5", "2 sites" wouldn't qualify).
    """
    # Each entry: (find_string, replace_string) — replace_string already
    # has the placeholder spliced in.
    pairs = []
    skipped_no_match = []
    skipped_collision = []
    used_finds = set()
    sorted_items = sorted(
        source_row.items(),
        key=lambda kv: -_numeric_size(kv[1]),
    )
    for sn, raw in sorted_items:
        if sn in ("state", "state_area", "@image"):
            continue
        if not raw or not str(raw).strip() or str(raw).upper() in ("NA", "N/A"):
            continue
        size = _numeric_size(raw)
        candidates = _format_candidates(raw)
        keywords = _header_keywords(headers_by_sn.get(sn, ""))
        placeholder = f"<<{sn}>>"

        # Try a global multi-occurrence-safe match first (same value
        # appearing in multiple places of the doc is presumed to be the
        # same metric — tag all instances).
        global_hits = [(c, template_text.count(c)) for c in candidates
                       if template_text.count(c) >= 1]
        chosen_find = None
        chosen_replace = None
        chosen_kind = None  # for logging

        # Decide if a "safe global" candidate exists.
        # SAFE if: candidate has $/% marker (unambiguous metric),
        #          OR raw value is large (>= tiny_threshold),
        #          OR the candidate is unique in the doc,
        #          OR the candidate is a multi-word non-numeric string
        #          (unlikely to accidentally collide).
        is_non_numeric = (size == 0)
        for c, n in sorted(global_hits, key=lambda h: (-len(h[0]), -h[1])):
            is_unambiguous = ("$" in c or "%" in c)
            is_unique = (n == 1)
            is_big = (size and size >= tiny_threshold)
            is_long_text = is_non_numeric and len(c) >= 8
            if is_unambiguous or is_unique or is_big or is_long_text:
                chosen_find = c
                chosen_replace = placeholder
                chosen_kind = "global"
                break

        # If no safe global, try keyword-wrapped context match.
        if not chosen_find and keywords:
            ctx = _find_value_near_keyword(template_text, keywords, candidates)
            if ctx:
                # Use the WRAPPED find ("Inflammation: 9"), splice
                # placeholder where the value sits.
                cf = ctx["context_find"]
                cr = ctx["context_replace_template"].replace("{V}", placeholder)
                # Sanity: the wrapped find should appear in template;
                # if it appears once, that's the safest possible scope.
                if template_text.count(cf) >= 1:
                    chosen_find = cf
                    chosen_replace = cr
                    chosen_kind = "wrapped"

        if not chosen_find:
            skipped_no_match.append((sn, raw))
            continue
        if chosen_find in used_finds:
            skipped_collision.append((sn, raw, chosen_find))
            continue
        used_finds.add(chosen_find)
        pairs.append((chosen_find, chosen_replace, chosen_kind, sn))

    return {
        "pairs": [(f, r) for (f, r, _k, _sn) in pairs],
        "annotated_pairs": pairs,
        "no_match": skipped_no_match,
        "collisions": skipped_collision,
    }


def _numeric_size(v):
    try:
        return abs(float(str(v).replace(",", "")))
    except (ValueError, AttributeError):
        return 0


def emit_tag_jsx(template_path, output_path, pairs, jsx_path, log_path):
    """Generate a JSX that opens template_path, applies all (find, replace)
    pairs via literal text find/change, and saves as output_path.
    `pairs` is a list of (find_string, replace_string) — replace_string
    already contains the <<placeholder>> spliced in.
    """
    def js_str(s):
        return json.dumps(str(s))
    pairs_js = ",\n        ".join(
        f"[{js_str(find)}, {js_str(repl)}]" for find, repl in pairs
    )
    src = f'''#target indesign
(function () {{
    var inPath = {js_str(template_path)};
    var outPath = {js_str(output_path)};
    var logPath = {js_str(log_path)};
    var pairs = [
        {pairs_js}
    ];
    var logBuf = [];
    function L(s) {{ logBuf.push(String(s)); }}
    function flush() {{
        try {{ var lf = File(logPath); lf.encoding = "UTF-8"; lf.open("w");
              lf.write(logBuf.join("\\n")); lf.close(); }} catch (e) {{}}
    }}
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    var doc = app.open(File(inPath));
    L("opened: " + doc.name);
    L("substitutions: " + pairs.length);
    var totalHits = 0;
    for (var i = 0; i < pairs.length; i++) {{
        var find = pairs[i][0], repl = pairs[i][1];
        try {{
            app.findTextPreferences = NothingEnum.NOTHING;
            app.changeTextPreferences = NothingEnum.NOTHING;
            app.findTextPreferences.findWhat = find;
            app.changeTextPreferences.changeTo = repl;
            var hits = doc.changeText().length;
            totalHits += hits;
            L("[" + (i+1) + "/" + pairs.length + "] " + find + " -> " + repl + "  (" + hits + " hit" + (hits===1?"":"s") + ")");
        }} catch (e) {{
            L("[" + (i+1) + "/" + pairs.length + "] FAILED " + find + ": " + e);
        }}
    }}
    app.findTextPreferences = NothingEnum.NOTHING;
    app.changeTextPreferences = NothingEnum.NOTHING;
    L("total replacements: " + totalHits);
    doc.save(File(outPath));
    doc.close(SaveOptions.NO);
    L("saved: " + outPath);
    flush();
}})();'''
    Path(jsx_path).write_text(src)


def run_jsx(jsx_path, app_name="Adobe InDesign 2026", timeout=600):
    proc = subprocess.run([
        "osascript",
        "-e", f"with timeout of {timeout} seconds",
        "-e", f'tell application "{app_name}"',
        "-e", f'do script (POSIX file "{jsx_path}") language javascript',
        "-e", "end tell",
        "-e", "end timeout",
    ], capture_output=True, text=True, timeout=timeout)
    return proc
