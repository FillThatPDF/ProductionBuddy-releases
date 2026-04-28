"""Ollama client for local-LLM annotation classification.

Talks to a locally-running Ollama daemon (http://localhost:11434). If Ollama
isn't running or the model isn't available, returns None and the caller
falls through to the next classifier.

Default model: llama3.1:8b — fits in ~5GB, runs well on M-series Macs.
Override with OLLAMA_MODEL env var.

Setup:
  1. brew install ollama   (or download from ollama.com)
  2. ollama serve          (runs the daemon)
  3. ollama pull llama3.1:8b
"""
import json
import os
import urllib.error
import urllib.request


OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.1:8b")
TIMEOUT = 60


SYSTEM_PROMPT = """You are an InDesign production assistant. The user gives you a single PDF-annotation sticky-note text plus document context. Decide what edit operation, if any, the annotation requests.

DECISION RULE
A real edit instruction has BOTH (a) a clear imperative ("Replace X with Y", "Delete the X line", "Insert a space before X", "Add a row containing …") AND (b) enough concrete detail to act on. If either is missing, return HUMAN_REVIEW with confidence 1.0.

Examples that should produce structured ops:
- "Replace 'Sub-type' with 'Subtype'" → REPLACE_TEXT find='Sub-type' replace_with='Subtype'
- "Delete the Print Ads line entirely." → HUMAN_REVIEW (target ambiguous — needs human; prefer HUMAN_REVIEW unless you can identify exact line)
- "Insert a space on both sides of this mathematical symbol." → REPLACE_TEXT find='—' replace_with=' — ' (em dash) IF the document context confirms an em dash usage
- "Revise to an em dash with spaces." → REPLACE_TEXT (only if the find string is unambiguous; otherwise HUMAN_REVIEW)
- "Please add: Acme Corp / John Doe / 555-1234 / john@acme.com / NY / ✓" with a 6-column table → ADD_TABLE_ROW values=[…6 values…]
- "Sort alphabetically by company" → SORT_TABLE column=0

Examples that MUST be HUMAN_REVIEW (never invent ops for these):
- Bare nouns: "Program", "Subtype", "Fixtures", "Bay Fixtures", "Lumen Ranges"
- Fragments: "s", "for", "and", "the"
- Stamps: "Marked set by John"
- Notes/FYI without explicit instruction
- Anything where you'd have to guess the find string, file path, target row, or column count

Available operations and their REQUIRED fields:
- ADD_TABLE_ROW       target:{table_id}                params:{values:[...]}  values length MUST equal the table column count
- INSERT_ROW_AT       target:{table_id}                params:{values:[...], index:int}
- DELETE_ROW          target:{table_id, row_match}     params:{}     row_match must be a real row's leading text
- SET_CELL_VALUE      target:{table_id, row_match, column}  params:{text}
- SORT_TABLE          target:{table_id}                params:{column:int}
- REPLACE_TEXT        target:{find}                    params:{replace_with}     find must be an exact substring (no regex, no placeholders)
- APPEND_PAGES_FROM_INDD  target:{file_path}           params:{}
- PLACE_ASSET_NEW_PAGE    target:{file_path}           params:{}
- PLACE_ASSET_IN_FRAME    target:{file_path, page}     params:{}
- HUMAN_REVIEW — DEFAULT when in doubt

NEVER use placeholders, regex literals, or null values in target/params. If you can't fill them concretely, return HUMAN_REVIEW.

Output ONLY a JSON object with keys: op, target, params, confidence (0..1), rationale, source_annotation. NO surrounding text."""


def is_running():
    """Quick check that Ollama daemon is reachable."""
    try:
        req = urllib.request.Request(f"{OLLAMA_URL}/api/tags", method="GET")
        with urllib.request.urlopen(req, timeout=3) as resp:
            return resp.status == 200
    except Exception:
        return False


def model_available(model_name=None):
    """Check whether the desired model is pulled locally."""
    model = model_name or OLLAMA_MODEL
    try:
        req = urllib.request.Request(f"{OLLAMA_URL}/api/tags", method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            for m in data.get("models", []):
                if m.get("name", "").startswith(model.split(":")[0]):
                    return True
    except Exception:
        pass
    return False


def _validate_op(obj, doc_summary):
    """Drop or downgrade ops that look hallucinated. Returns the op (possibly
    rewritten as HUMAN_REVIEW) or None."""
    if not isinstance(obj, dict):
        return None
    op = obj.get("op")
    if op == "HUMAN_REVIEW":
        return obj
    target = obj.get("target")
    params = obj.get("params") or {}

    # target must be an object (some local-LLMs emit strings or regex literals)
    if not isinstance(target, dict):
        obj["op"] = "HUMAN_REVIEW"
        obj["rationale"] = "Malformed target (" + str(target)[:50] + ") — manual review"
        return obj

    # ADD_TABLE_ROW / INSERT_ROW_AT — values list must match a real table's column count (±1)
    if op in ("ADD_TABLE_ROW", "INSERT_ROW_AT"):
        values = params.get("values") or []
        if not isinstance(values, list) or len(values) == 0:
            obj["op"] = "HUMAN_REVIEW"; obj["rationale"] = "ADD_TABLE_ROW with no values — manual review"; return obj
        # Find table candidate
        table_id = target.get("table_id")
        match = None
        for tbl in doc_summary.get("tables", []):
            if table_id and tbl.get("id") == table_id: match = tbl; break
        if not match and len(doc_summary.get("tables", [])) == 1:
            match = doc_summary["tables"][0]
        if match:
            cols = match.get("columns", 0)
            if cols and len(values) < cols - 1:
                obj["op"] = "HUMAN_REVIEW"
                obj["rationale"] = f"ADD_TABLE_ROW with only {len(values)} value(s) for {cols}-column table — manual review"
                return obj

    # SET_CELL_VALUE / DELETE_ROW need a row_match or row_index
    if op in ("SET_CELL_VALUE", "DELETE_ROW"):
        if not target.get("row_match") and target.get("row_index") is None:
            obj["op"] = "HUMAN_REVIEW"; obj["rationale"] = op + " missing row identifier — manual review"; return obj

    # REPLACE_TEXT requires a non-empty `find`
    if op == "REPLACE_TEXT":
        find = target.get("find")
        if not find or not isinstance(find, str) or len(find.strip()) == 0:
            obj["op"] = "HUMAN_REVIEW"; obj["rationale"] = "REPLACE_TEXT missing find string — manual review"; return obj

    return obj


def classify_one(annotation_content, doc_summary, reference_files_summary):
    """Send one annotation to Ollama. Returns dict matching the edit-op shape, or None."""
    user_msg = json.dumps({
        "annotation": annotation_content,
        "document": doc_summary,
        "reference_files": reference_files_summary,
    })
    body = {
        "model": OLLAMA_MODEL,
        "system": SYSTEM_PROMPT,
        "prompt": user_msg,
        "stream": False,
        "format": "json",
        "options": {"temperature": 0.1, "num_predict": 512},
    }
    try:
        req = urllib.request.Request(
            f"{OLLAMA_URL}/api/generate",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = json.loads(resp.read())
            txt = data.get("response", "")
            if not txt:
                return None
            try:
                obj = json.loads(txt)
            except Exception:
                return None
            obj.setdefault("source_annotation", annotation_content[:300])
            obj.setdefault("rationale", "Classified by local Ollama (" + OLLAMA_MODEL + ")")
            obj.setdefault("confidence", 0.7)
            return obj  # validation happens in caller (needs doc context)
    except Exception:
        return None


def classify_annotations(annotations, doc_inspection, reference_files=None):
    """Classify a list of annotations using local Ollama. Returns plan dict
    matching the Claude/local schema, or None if Ollama unavailable."""
    if not is_running() or not model_available():
        return None

    # Build a compact doc summary (full inspection is too much for an 8B model)
    doc_summary = {
        "page_count": doc_inspection.get("page_count"),
        "doc_type_hint": doc_inspection.get("doc_type_hint"),
        "tables": [],
    }
    for page in doc_inspection.get("pages", []):
        for frame in page.get("frames", []):
            for tbl in frame.get("tables", []):
                doc_summary["tables"].append({
                    "id": tbl.get("id"),
                    "rows": tbl.get("rows"),
                    "columns": tbl.get("columns"),
                    "headerCells": tbl.get("headerCells", []),
                })

    ref_summary = []
    for r in reference_files or []:
        ref_summary.append({
            "path": r.get("path"),
            "name": r.get("name"),
            "type": r.get("type"),
            "ext": r.get("ext"),
        })

    edits = []
    notes = []
    for ann in annotations:
        op = classify_one(ann.get("content", ""), doc_summary, ref_summary)
        if not op:
            edits.append({
                "op": "HUMAN_REVIEW", "target": {}, "params": {}, "confidence": 1.0,
                "rationale": "Ollama returned no/unparseable output",
                "source_annotation": ann.get("content", "")[:300],
            })
            continue
        # Validate against doc context — drops malformed/hallucinated ops to HUMAN_REVIEW
        op = _validate_op(op, doc_summary) or {
            "op": "HUMAN_REVIEW", "target": {}, "params": {}, "confidence": 1.0,
            "rationale": "Validation rejected", "source_annotation": ann.get("content", "")[:300],
        }
        if op.get("op") == "HUMAN_REVIEW" and op.get("rationale", "").lower().startswith("note"):
            notes.append(ann.get("content", ""))
        edits.append(op)
    return {"edits": edits, "human_notes": notes}
