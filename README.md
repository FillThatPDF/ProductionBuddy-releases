# InDesignEditor

Apply marked-up PDF edits to InDesign documents with automated production QA.

## Status: v0.3 — generic, works on any document

The pipeline is now **document-agnostic**. The previous proof-of-concept was hardcoded for the rater-directory case; v0.3 inspects whatever .indd you give it, sends a structured map to Claude for natural-language edit interpretation, and runs a generic edit dispatcher + post-edit canonicalization + comprehensive QA scan.

## What it does

1. **Extract** every annotation from the marked-up PDF (page, position, content)
2. **Inspect** the .indd deeply: every table (id, rows, cols, headers, first-body-row formatting, alternating-fill detection), every text frame, every paragraph/character/cell style with property values, swatches, hyperlinks, story samples, document-type hint
3. **Classify** annotations via Claude API (with a tool-use schema that returns structured ops). Supports: `ADD_TABLE_ROW`, `INSERT_ROW_AT`, `DELETE_ROW`, `SET_CELL_VALUE` (incl. check marks), `SORT_TABLE`, `REPLACE_TEXT`, `HUMAN_REVIEW`. Confidence threshold gates auto-application.
4. **Execute** edits in InDesign with multi-table-aware target resolution (by `table_id`, by `header_match` substring, by shape, fallback)
5. **Canonicalize** post-edit (generic, runs on any modified table):
   - Disable hyphenation in modified cells
   - Atomic-content single-line fit (emails, URLs, phones) via tracking
   - Detect existing alternating-fill scheme and re-stamp consistently (so new rows don't break it)
   - Auto-extend overflowing frames to a safe ceiling that doesn't collide with other page items
6. **QA scan** — 27 checks covering text, color, fonts, images, links, layout, print readiness
7. **Output** edited `.indd` + exported PDF + structured `findings.json`

## Architecture: offline-first with optional LLM upgrades

The app is ~95% local. Annotation extraction, document inspection, edit execution, all 27 QA checks, spellcheck, hyperlink reachability, layout fit, alternating-fill, and PDF export all run on your machine with no network calls.

The only step that *can* use an LLM is translating natural-language markup ("Please add: ...", "Add a check mark to X") into structured edit ops. That step runs through a **cascade**:

1. **Rule-based local classifier** (always runs first, no setup) — handles common production markup patterns: `Please add: <data>`, `Add a check mark for X`, `Sort alphabetically`, `Replace X with Y`, asset placement requests, note-style annotations. Resolves ~70-80% of typical markup. Anything ambiguous is marked `HUMAN_REVIEW`.
2. **Ollama escalation** (optional, if running) — for any annotations the rules couldn't classify, sends them to a local LLM via Ollama. Default model `llama3.1:8b` (~5GB). Fully offline, no API cost.
3. **Claude escalation** (optional, if `ANTHROPIC_API_KEY` set) — for any *still* unresolved, sends to Claude for highest accuracy on ambiguous markup.

Each annotation is classified by the highest-quality classifier that resolved it. Use whatever combination fits your workflow:
- **Just want offline daily use** → set up rule-based only (default, zero config)
- **Better offline accuracy** → install Ollama + pull a model
- **Best accuracy for messy markup** → set Claude API key

## Setup

```bash
cd InDesignEditor
npm install
pip3 install --user --break-system-packages anthropic pyspellchecker pymupdf
```

**Optional — local LLM via Ollama:**
```bash
brew install ollama
ollama serve &              # daemon
ollama pull llama3.1:8b     # one-time download (~5GB)
```

**Optional — Claude API:**
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Run

```bash
npm start
```

Then in the UI: pick PDF → pick .indd → pick output folder → click **Extract & Apply Edits**.

The app:
- Always copies the .indd to a working location (never touches your original)
- Streams progress to the UI
- Shows findings grouped by severity with summary pills
- Outputs the edited .indd + exported PDF

Without `ANTHROPIC_API_KEY` the pipeline still runs everything except edit classification — it routes all annotations to HUMAN_REVIEW so you can see what was detected. With the key, edits with confidence ≥ 0.6 are applied automatically; the rest are flagged.

## Edit operations supported

| Op | What | Targeting |
|---|---|---|
| `ADD_TABLE_ROW` | Append row to a table | `table_id` / `header_match` |
| `INSERT_ROW_AT` | Insert at a body-row index | `table_id` + `params.index` |
| `DELETE_ROW` | Remove a row | `table_id` + `row_match` or `row_index` |
| `SET_CELL_VALUE` | Set a specific cell's text (incl. ✓ → Wingdings glyph) | `table_id` + `row_match`/`row_index` + `column` |
| `SORT_TABLE` | Alphabetize body rows | `table_id` + `params.column` |
| `REPLACE_TEXT` | Find/replace in any story | `target.find` |
| `HUMAN_REVIEW` | Flag for human, no edit | — |

## QA Checks (27 implemented)

### Auto-fixed silently
- `TEXT_WHITESPACE` — multiple spaces, trailing whitespace
- `TEXT_SMART_QUOTES` — straight → typographic quotes/apostrophes
- `TEXT_DOUBLE_PUNCT` — `...` → `…`, doubled commas
- `TEXT_TM_SUPERSCRIPT` — ®/™/© → superscript
- (Plus generic post-edit: hyphenation off, atomic single-line fit, alternating-fill re-stamp, overflow extension)

### Flagged for review
- `TEXT_HYPHEN_VS_DASH`, `TEXT_EMPTY_PARAS`
- `STYLE_PARA_OVERRIDES`, `STYLE_COLOR_MISMATCH`
- `FONT_INVENTORY`, `FONT_TOO_MANY`, `FONT_UNAVAILABLE`
- `IMG_LOW_RES`, `IMG_COUNT`
- `LINK_MISSING`, `LINK_OUT_OF_DATE`
- `COLOR_RGB_SWATCH`, `COLOR_SPOT_COLORS`, `COLOR_RICH_BLACK_SMALL`
- `HYPERLINK_INVENTORY`, `HYPERLINK_TEXT_MISMATCH` (displayed URL ≠ destination — caught a real bug)
- `HYPERLINK_BROKEN`, `HYPERLINK_UNREACHABLE` (Python-side HTTP probes)
- `URL_NOT_HYPERLINKED`
- `TEXT_OVERSET`
- `LAYER_HIDDEN_WITH_CONTENT`, `ITEM_LOCKED`, `MASTER_OVERRIDES`
- `DOC_COLOR_PROFILE`, `DOC_DIMENSIONS`, `DOC_BLEED`, `DOC_NO_BLEED`
- `SPELLCHECK_SUSPICIOUS` (Python-side, pyspellchecker)

## Architecture

```
InDesignEditor/
├── package.json, main.js, index.html, renderer.js, styles.css
├── python/
│   ├── orchestrate.py            # main pipeline
│   ├── claude_client.py          # Anthropic SDK + tool-use schema
│   └── qa_checks/
│       ├── check_hyperlinks_reachability.py
│       └── check_spelling.py
└── jsx/
    ├── inspect_doc.jsx           # deep doc inspector (multi-table aware)
    └── apply_edits_v2.jsx        # generic dispatcher + canonicalization + QA
```

## Roadmap

- v0.4: Visual diff comparing original PDF vs edited PDF (precise cell-level color sampling using actual table geometry)
- v0.5: Image swap operations, frame moves, color/style change ops
- v0.6: Batch processing (folder → folder)
- v1.0: Document-class-specific QA profiles (e.g. brochure vs. directory vs. form)
