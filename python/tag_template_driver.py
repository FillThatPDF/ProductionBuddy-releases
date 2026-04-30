"""Build the tag-pair list that drives jsx/tag_template.jsx.

Given the CSV of state data (produced by data_merge.flatten_xlsx_to_csv) and
a reference state name (the one the template was originally designed for —
typically "California"), this builds the find/replace pairs we apply to the
template to turn hardcoded values into <<placeholders>>.

Heuristics:
  - Monetary / "$"-prefixed values: literal find/replace
  - Workforce + clinical-trial-total counts: paragraph-anchored grep so
    "15,213" alone in its own paragraph becomes "<<wf_total>>" without
    matching any other "15,213" elsewhere
  - Clinical-trial sub-counts (Oncology, Inflammation, Virology): inline
    labeled find — "Cell Therapy: 31" → "Cell Therapy: <<ct_onco>>" — so a
    bare "31" elsewhere isn't accidentally tagged
  - State name: whole-frame match (the headline) + the "  |  State" footer
    pattern + "Investment in {State} Facilities" label
  - Multi-row list columns (top20, grant_prog): NOT auto-tagged — they need
    to be inserted by the user (or already-present), then the JSX clears any
    leftover hardcoded list lines after the placeholder.
"""
from __future__ import annotations

import csv
from pathlib import Path
from typing import Dict, List


# Column-type tables. Mirror what's in data_merge.py for value formatting.
MONEY_COLS = {"total", "capital", "cmo", "cro", "giving", "grant_val",
              "g_hiv", "g_liv", "g_onc", "g_oth"}
COUNT_COLS = {"wf_total", "wf_ft", "wf_ct"}
STANDALONE_COLS = {"ct_total"}  # paragraph-anchored standalone count
LIST_COLS = {"top20", "grant_prog"}
SKIP_COLS = {"state", "@image", "facilities", "racial_eq", "compass"}

# Inline labeled numbers — column → label that precedes the value in the doc
LABELED_COLS = {
    "ct_onco":   "Cell Therapy: ",
    "ct_inflam": "Inflammation: ",
    "ct_virol":  "Virology: ",
}

# Workforce-style "number + paragraph break + label" patterns. The auto-tagger
# scans for any frame whose contents start with a number followed by a paragraph
# break and one of these labels — useful when the template's hardcoded value
# disagrees with the CSV (e.g., the template was made with last year's numbers).
NEAR_LABEL_COLS = {
    "wf_total": "Workers",
    "wf_ft":    "Full-time Employees",
    "wf_ct":    "Contingent Workers",
}


def _is_blank(v) -> bool:
    if v is None:
        return True
    s = str(v).strip()
    return s == "" or s.upper() == "NA"


def build_tag_pairs(ref_row: Dict[str, str], ref_state: str) -> List[dict]:
    pairs: List[dict] = []

    # 1) State-name pairs — try a few patterns we know about. These are
    #    template-specific heuristics; ones that don't match will simply be
    #    reported as "unmatched" and the user can add them manually.
    pairs.append({
        "kind": "state_word",
        "find": ref_state,
        "replace": "<<state>>",
        "name": "state name (whole-frame match — headline)",
    })
    pairs.append({
        "kind": "footer",
        "find": f"  |  {ref_state}",
        "replace": "  |  <<state>>",
        "name": "footer | <state>",
    })
    pairs.append({
        "kind": "literal",
        "find": f"Investment in {ref_state} Facilities",
        "replace": "Investment in <<state>> Facilities",
        "name": "investment label '...in <state> Facilities'",
    })

    # 2) Per-column value pairs. Order matters: more-specific first, so a
    #    "Cell Therapy: 31" labeled match runs before a bare "31" literal.
    labeled_pairs = []
    standalone_pairs = []
    near_label_pairs = []
    money_pairs = []
    other_pairs = []

    # Near-label pairs run regardless of CSV value (template's number may not
    # match the CSV's, e.g., last year's data still in the template).
    for col, label in NEAR_LABEL_COLS.items():
        near_label_pairs.append({
            "kind": "near_label",
            "label": label,
            "replace": f"<<{col}>>",
            "find": f"<number> followed by paragraph break and '{label}'",
            "name": f"{col} (near label '{label}')",
        })

    # List-block pairs: use the FIRST line of the reference state's list value
    # as an anchor to find the frame containing the hardcoded California list,
    # then collapse the whole story to a single placeholder. The merge step
    # later flows each state's actual list into that placeholder via
    # paragraph-break-separated lines.
    list_block_pairs = []
    for col in LIST_COLS:
        raw = ref_row.get(col, "")
        if _is_blank(raw):
            continue
        anchor = str(raw).split("\n", 1)[0].strip()
        if not anchor:
            continue
        list_block_pairs.append({
            "kind": "list_block",
            "anchor": anchor,
            "replace": f"<<{col}>>",
            "find": f"story starting with '{anchor[:40]}…'",
            "name": f"{col} (multi-row list block)",
        })

    for col, val in ref_row.items():
        if col in SKIP_COLS or col in LIST_COLS:
            continue
        if col in NEAR_LABEL_COLS:
            continue  # handled by near_label pass above
        if _is_blank(val):
            continue

        v = str(val).strip()
        token = f"<<{col}>>"

        if col in LABELED_COLS:
            label = LABELED_COLS[col]
            labeled_pairs.append({
                "kind": "labeled",
                "find": label + v,
                "replace": label + token,
                "name": f"{col} (inline label '{label.rstrip(': ')}')",
            })
            continue

        if col in COUNT_COLS or col in STANDALONE_COLS:
            # Paragraph-anchored grep — value is alone in its paragraph
            standalone_pairs.append({
                "kind": "grep",
                "find": f"^{v}\\s*$",
                "replace": token,
                "name": f"{col} (standalone paragraph value '{v}')",
            })
            continue

        if col in MONEY_COLS:
            # Try variants in priority order (most-specific first). InDesign's
            # findText is substring-aware, so "$494,563,635" also matches
            # "$494,563,635.00" and leaves a stray ".00" behind. Try the
            # ".00"-suffixed form first to swallow it cleanly.
            variants = []
            if "." not in v:
                variants.append(v + ".00")  # monetary with cents
            variants.append(v)              # bare CSV value
            money_pairs.append({
                "kind": "literal_variants",
                "variants": variants,
                "find": v,                  # display in report
                "replace": token,
                "name": f"{col} (monetary value '{v}')",
            })
            continue

        # Generic literal find for anything else (top20_orig, grant_val, …)
        other_pairs.append({
            "kind": "literal",
            "find": v,
            "replace": token,
            "name": f"{col} (literal value '{v}')",
        })

    # Specific-first ordering: labeled → standalone → money → other. This
    # avoids a generic literal "31" match swallowing a labeled "Cell Therapy: 31".
    # List blocks first: they collapse a multi-row list to a single placeholder,
    # which avoids any later literal/grep pass accidentally matching content
    # from inside the list.
    pairs.extend(list_block_pairs)
    # Near-label next: they replace just the number, leaving the label intact,
    # so the standalone-paragraph-number heuristic later won't accidentally
    # match the same number in a different role.
    pairs.extend(near_label_pairs)
    pairs.extend(labeled_pairs)
    pairs.extend(standalone_pairs)
    money_pairs.sort(key=lambda p: -len(p["find"]))
    pairs.extend(money_pairs)
    pairs.extend(other_pairs)

    return pairs


def load_ref_row(csv_path: str | Path, ref_state: str) -> Dict[str, str] | None:
    with open(csv_path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if (row.get("state") or "").strip().lower() == ref_state.strip().lower():
                return row
    return None
