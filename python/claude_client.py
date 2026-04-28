"""Claude API client for parsing marked-up PDF annotations into structured edits.

Uses tool-use to force structured JSON output. Reads ANTHROPIC_API_KEY from env.
"""
import json
import os

try:
    from anthropic import Anthropic
    HAS_SDK = True
except ImportError:
    HAS_SDK = False


MODEL = "claude-opus-4-7"
FALLBACK_MODEL = "claude-sonnet-4-6"


SYSTEM_PROMPT = """You are an InDesign production specialist's assistant. Your job is to read PDF annotations (sticky notes from a marked-up review PDF) and translate them into a structured list of edit operations the production tool can apply to the source InDesign document.

INPUT
You receive:
- annotations: a list of sticky-note annotations from the marked-up PDF. Each has:
    - page: 1-indexed page number
    - rect: [x0, y0, x1, y1] rectangle on the page
    - content: the text the reviewer wrote
- doc_inspection: a deep map of the .indd file structure:
    - paragraph_styles, character_styles, cell_styles, swatches (with property samples)
    - pages → frames → tables (each table has id, rows, columns, headerCells, firstBodyRow with cellStyle and paraStyle, altFill type)
    - hyperlinks, stories_preview, doc_type_hint
- reference_files: a list of additional assets the user provided that the markup may reference. Each has:
    - path: absolute filesystem path (use this verbatim in target.file_path)
    - name: just the filename (use for matching annotations)
    - ext: file extension
    - type: indesign_document | pdf | illustrator | photoshop | raster_image
    - page_count, text_preview, image_dims (when applicable) — useful for matching to annotation language

DOCUMENTS VARY WIDELY. Some are clean directories with one table. Others have multiple tables, complex layouts, brochures, forms, or are even poorly constructed. Use the inspection data to ground your decisions in what actually exists in the doc.

WHEN ANNOTATIONS REFERENCE EXTERNAL FILES
Production reviewers often write things like "add this form at the end" or "place this graphic here". Match such annotations to the appropriate `reference_files` entry by:
- Filename overlap (e.g., annotation mentions "ConEd Resi" → ref file `58958_ConEd_Resi_…indd`)
- File type semantics (e.g., "place this photo" → raster_image; "append this form" → indesign_document)
- Text preview content (e.g., annotation says "the new application form" → ref PDF whose first-page text includes "Application Form")
- Order of mention (last reference is often the one for the last annotation)
If multiple ref files could match, pick the most likely; if uncertain, route to HUMAN_REVIEW with a note.

OUTPUT
Call the `submit_edits` tool with:
- edits: ordered array of operations
- human_notes: short strings surfacing things the reviewer wrote that are notes/questions, not actions

OPERATIONS

ADD_TABLE_ROW
  target: { table_id?, header_match?, rows?, cols? }   # any one is enough
  params: { values: [string, ...] }                     # one per column, in order
  Use when annotation says "Please add: <new entry>" with rater/contact data.

INSERT_ROW_AT
  target: { table_id?, header_match? }
  params: { values: [...], index: int }                 # 1-indexed body row position

DELETE_ROW
  target: { table_id?, row_match: "company name prefix" } OR { row_index: int }

SET_CELL_VALUE
  target: { table_id?, header_match?, row_match: "company prefix", row_index?, column: int }
  params: { text: "value" }
  Use when annotation says "Add a check mark to <row>" — pass text as "✓" or "CHECK"
  (the executor will set the appropriate Wingdings glyph).

SORT_TABLE
  target: { table_id?, header_match? }
  params: { column: int, ascending: bool (default true) }

REPLACE_TEXT
  target: { find: "exact substring or grep" }
  params: { replace_with: "new text" }

APPEND_PAGES_FROM_INDD
  target: { file_path: "<absolute path from reference_files>" }
  params: { source_page_range?: [start, end] (1-indexed; omit = all pages) }
  Use when annotation says "add this other InDesign file at the end" or similar.

PLACE_ASSET_NEW_PAGE
  target: { file_path: "<absolute path>" }
  params: { source_pdf_page?: int (for multi-page PDFs; default 1) }
  Creates a new page at end and places the asset full-bleed. Works with .pdf, .ai, .psd, images.

PLACE_ASSET_IN_FRAME
  target: { file_path: "<absolute path>", page: int (1-indexed), bounds?: [y1,x1,y2,x2] in inches }
  params: { source_pdf_page?: int }
  Places asset into a new frame on the specified page. If bounds omitted, places at center.

HUMAN_REVIEW
  Use for annotations that are notes, questions, or anything ambiguous.
  Be conservative — when unsure, route to HUMAN_REVIEW.

GUIDELINES
1. **Resolve targets specifically.** Prefer `table_id` from the inspection (e.g. "p1_tf4_t0"). If unclear which table, fall back to `header_match` (a substring of the headerCells joined text, e.g. "Rating Company"). Always set at least one selector.
2. **Match the doc's column order.** When emitting `values` for ADD_TABLE_ROW, look at the table's `headerCells` to know what each position represents. Reorder annotation data to match.
3. **Use existing styles.** If the annotation says "make this bold" and there's a `paragraphStyles` entry with the right look, prefer applying that — but currently only REPLACE_TEXT and table ops are exposed; for style changes route to HUMAN_REVIEW.
4. **Don't invent data.** If the annotation says "add check mark" but doesn't say which row, scan annotation rect coordinates against the document structure if possible; otherwise HUMAN_REVIEW.
5. **Confidence.** Pure data adds (Add row with all fields specified): 0.9-1.0. Cell-mark adds with clear row reference: 0.85-0.95. Sort directives: 0.85. Anything ambiguous (vague language, missing data, layout requests, "make this nicer"): drop below 0.6 OR emit HUMAN_REVIEW.
6. **Surface side notes.** Statements like "Note: this person also works at X" should go in `human_notes`, not edits.
7. **Multi-step requests.** A single annotation may imply multiple ops (e.g. "Please add: <new rater> ... and update sorting"). Emit them in order.

Return ONLY through the `submit_edits` tool."""


SUBMIT_EDITS_TOOL = {
    "name": "submit_edits",
    "description": "Submit the structured edit list parsed from PDF annotations.",
    "input_schema": {
        "type": "object",
        "properties": {
            "edits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "op": {
                            "type": "string",
                            "enum": ["ADD_TABLE_ROW", "INSERT_ROW_AT", "DELETE_ROW", "SET_CELL_VALUE", "SORT_TABLE", "REPLACE_TEXT", "APPEND_PAGES_FROM_INDD", "PLACE_ASSET_NEW_PAGE", "PLACE_ASSET_IN_FRAME", "HUMAN_REVIEW"],
                        },
                        "target": {
                            "type": "object",
                            "description": "Where to apply the edit. Shape varies by op. Table ops: table_id, header_match, row_match, row_index, column. Asset ops: file_path (must be absolute, copied verbatim from reference_files), page, bounds. Replace ops: find.",
                            "properties": {
                                "table_id":     {"type": "string"},
                                "header_match": {"type": "string"},
                                "rows":         {"type": "integer"},
                                "cols":         {"type": "integer"},
                                "row_match":    {"type": "string"},
                                "row_index":    {"type": "integer"},
                                "column":       {"type": "integer"},
                                "find":         {"type": "string"},
                                "file_path":    {"type": "string"},
                                "page":         {"type": "integer"},
                                "bounds":       {"type": "array", "items": {"type": "number"}},
                            }
                        },
                        "params": {
                            "type": "object",
                            "description": "Operation parameters. ADD_TABLE_ROW: {values:[...]}. INSERT_ROW_AT: {values:[...], index:int}. SET_CELL_VALUE: {text}. SORT_TABLE: {column, ascending}. REPLACE_TEXT: {replace_with}.",
                        },
                        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                        "rationale":  {"type": "string"},
                        "source_annotation": {"type": "string"},
                    },
                    "required": ["op", "confidence", "rationale", "source_annotation"],
                },
            },
            "human_notes": {
                "type": "array",
                "items": {"type": "string"},
            },
        },
        "required": ["edits", "human_notes"],
    },
}


def classify_edits(annotations, doc_inspection, reference_files=None):
    """Send annotations + doc context (+ optional reference files inventory) to Claude.
    Returns dict with edits + human_notes, or None if no API key / SDK unavailable."""
    if not HAS_SDK:
        return None
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return None

    client = Anthropic(api_key=api_key)
    user_msg = json.dumps({
        "annotations": annotations,
        "doc_inspection": doc_inspection,
        "reference_files": reference_files or [],
    })

    for model in [MODEL, FALLBACK_MODEL]:
        try:
            resp = client.messages.create(
                model=model,
                max_tokens=8192,
                system=SYSTEM_PROMPT,
                tools=[SUBMIT_EDITS_TOOL],
                tool_choice={"type": "tool", "name": "submit_edits"},
                messages=[{"role": "user", "content": user_msg}],
            )
            for block in resp.content:
                if block.type == "tool_use" and block.name == "submit_edits":
                    return block.input
        except Exception as e:
            print(f"[claude_client] model {model} failed: {e}", flush=True)
            continue
    return None
