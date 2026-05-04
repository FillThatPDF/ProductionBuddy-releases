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
import threading
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed


OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.1:8b")
TIMEOUT = 60

# Parallel Ollama requests for multi-annotation jobs. Modern Ollama (0.2+)
# handles concurrent requests using its OLLAMA_NUM_PARALLEL setting (default
# 4). On M-series Macs the unified GPU means concurrent calls share the same
# silicon — we get ~2-3x speedup with 4 workers, not 4x. Higher workers risks
# saturating the GPU and slowing every request.
PARALLEL = int(os.environ.get("OLLAMA_PARALLEL", "4"))

# Tell Ollama to keep the model resident long after our last request.
# Default Ollama keep-alive is 5 min — back-to-back jobs spaced more than
# 5 min apart pay the full ~5s model-reload cost on every call. 24h covers
# a typical work day. Override via OLLAMA_KEEP_ALIVE env var.
KEEP_ALIVE = os.environ.get("OLLAMA_KEEP_ALIVE", "24h")


SYSTEM_PROMPT = """You are an InDesign production assistant. The user gives you ONE annotation from a marked-up PDF — possibly with extra context fields — and you decide what concrete edit it requests. Output JSON only.

INPUT FIELDS YOU MAY RECEIVE
- annotation: the reviewer's comment text. May be a sticky-note, or an instruction attached to a Highlight/Strikethrough.
- marked_text: the literal text the reviewer's annotation visually covers (highlight/strike). Empty for sticky notes.
- line_text: the full visual line containing the annotation. Use this as the find anchor for scoped edits — it's the smallest unit of original text guaranteed to exist in the InDesign doc.
- annotation_type: "Text" (sticky note), "Highlight", "StrikeOut", "Caret".
- document: a compact summary of the doc (page count, table column counts, etc.).

DECISION RULE
A real edit has BOTH (a) a clear imperative AND (b) enough detail to act on without guessing. If either is missing, return HUMAN_REVIEW with confidence 1.0.

PREFERRED OUTPUT for text edits: REPLACE_TEXT scoped to line_text.
  find = the exact line_text (or a substring of it) — must exist verbatim in the doc.
  replace_with = the line with the requested change applied.

When the annotation says "throughout", "all", "every", "applies to all of these", you may emit REPLACE_TEXT with params.is_regex=true, where find is a GREP regex (use \\d+, \\w+, etc. — InDesign GREP) and replace_with uses $1, $2 backrefs. Only do this when the user explicitly asked for a global pattern. Otherwise stay scoped to line_text.

EXAMPLES (annotation → output)
- annotation: "Insert a comma between X and Y."  marked: "X Y"  line: "Apple X Y banana"
  → REPLACE_TEXT find="Apple X Y banana" replace_with="Apple X, Y banana"

- annotation: "Insert a space on both sides of this mathematical symbol. This applies throughout this column."  marked: "x"
  → REPLACE_TEXT (regex) find="(\\d+)x(\\d+)" replace_with="$1 x $2" is_regex=true

- annotation: "Revise to an em dash with spaces."  marked: "-"  line: "Table 1 - Approved Lamp Measures"
  → REPLACE_TEXT find="Table 1 - Approved Lamp Measures" replace_with="Table 1 — Approved Lamp Measures"

- annotation: "Lowercase"  marked: "Project"  line: "Non-incentivized Project costs:"
  → REPLACE_TEXT find="Non-incentivized Project costs:" replace_with="Non-incentivized project costs:"

- annotation: "If it fits"   ← no actionable edit, just guidance
  → HUMAN_REVIEW

- annotation: "Subtype"  ← bare noun, no imperative
  → HUMAN_REVIEW

Available operations:
- REPLACE_TEXT        target:{find}    params:{replace_with, is_regex?}    find must exist verbatim (literal mode) OR be a valid InDesign GREP regex (regex mode).
- ADD_TABLE_ROW       target:{table_id}                params:{values:[...]}    values length MUST equal the table's column count
- INSERT_ROW_AT       target:{table_id}                params:{values:[...], index:int}
- DELETE_ROW          target:{table_id, row_match}     params:{}     row_match = exact leading text of a real row
- SET_CELL_VALUE      target:{table_id, row_match, column}  params:{text}
- SORT_TABLE          target:{table_id}                params:{column:int}
- APPEND_PAGES_FROM_INDD  target:{file_path}           params:{}
- PLACE_ASSET_NEW_PAGE    target:{file_path}           params:{}
- PLACE_ASSET_IN_FRAME    target:{file_path, page}     params:{}
- HUMAN_REVIEW — DEFAULT when in doubt.

HARD RULES
- NEVER hallucinate. If you can't fill find/replace_with from the input verbatim, return HUMAN_REVIEW.
- NEVER use placeholders or empty strings.
- For REPLACE_TEXT in literal mode, find MUST appear character-for-character in line_text or marked_text.
- For REPLACE_TEXT in regex mode, only use it when the annotation requests a global/throughout-style change.

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


def warmup(model_name=None):
    """Pre-pay both costs that bloat the first real Ollama call:
       1. `load_duration` — model loading into memory (~5s on Mac)
       2. `prompt_eval_duration` — evaluating the SYSTEM_PROMPT (~3-4s for 1126 tokens)

    Sending the real SYSTEM_PROMPT (with `num_predict: 1` so generation is
    near-instant) parks the system-prompt KV state in Ollama's cache. When
    `classify_one` runs later with the same system prompt, Ollama's KV-cache
    reuse skips the prefill of the matching prefix — first real call pays
    only for the per-annotation user-message delta (~50–200 tokens).

    Returns immediately — the actual prefill happens in a background thread
    in parallel with step 1 (PDF extraction) and step 2 (InDesign inspect).

    Safe to call even if Ollama isn't running — silently fails.
    """
    model = model_name or OLLAMA_MODEL

    def _do():
        try:
            body = {
                "model": model,
                "system": SYSTEM_PROMPT,
                # NB: prompt MUST be non-empty. With prompt="" Ollama short-
                # circuits and never evaluates the system prompt — the KV
                # cache stays empty and the next real call pays the full
                # ~3.6s prefill again. A 1-char prompt is enough to force
                # the prefill of system + " ." into Ollama's KV cache, so
                # subsequent classify_one calls skip the system-prompt
                # prefix and only evaluate their per-annotation user delta.
                "prompt": ".",
                "stream": False,
                "keep_alive": KEEP_ALIVE,
                "options": {"num_predict": 1, "temperature": 0.1},
            }
            req = urllib.request.Request(
                f"{OLLAMA_URL}/api/generate",
                data=json.dumps(body).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                # Tee timing so we can see how the warmup actually went.
                try:
                    data = json.loads(resp.read())
                    ld_ms = data.get("load_duration", 0) / 1e6
                    pe_ms = data.get("prompt_eval_duration", 0) / 1e6
                    pe_n  = data.get("prompt_eval_count", 0)
                    line  = (f"[ollama]   warmup complete — load={ld_ms:.0f}ms  "
                             f"prefill={pe_ms:.0f}ms ({pe_n} tok)")
                    print(line, flush=True)
                    try:
                        with open("/tmp/pb_orchestrate.log", "a", encoding="utf-8") as f:
                            f.write(line + "\n")
                    except Exception:
                        pass
                except Exception:
                    pass
        except Exception:
            pass

    threading.Thread(target=_do, daemon=True, name="ollama-warmup").start()


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


def classify_one(annotation_content, doc_summary, reference_files_summary,
                 marked_text=None, line_text=None, annotation_type=None):
    """Send one annotation to Ollama. Returns dict matching the edit-op shape, or None.

    The extra context fields (marked_text, line_text, annotation_type) let
    Ollama produce a properly-scoped REPLACE_TEXT. Without them it tends to
    invent find strings that don't exist in the doc.
    """
    payload = {"annotation": annotation_content, "document": doc_summary,
               "reference_files": reference_files_summary}
    if marked_text:        payload["marked_text"] = marked_text
    if line_text:          payload["line_text"] = line_text
    if annotation_type:    payload["annotation_type"] = annotation_type
    user_msg = json.dumps(payload)
    body = {
        "model": OLLAMA_MODEL,
        "system": SYSTEM_PROMPT,
        "prompt": user_msg,
        "stream": False,
        "format": "json",
        "options": {"temperature": 0.1, "num_predict": 512},
        "keep_alive": KEEP_ALIVE,
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
            # Print Ollama's per-request timing breakdown so the orchestrate
            # tee log shows exactly where the wall time went. Durations are
            # nanoseconds; eval_count is tokens generated.
            try:
                ld_ms = data.get("load_duration", 0) / 1e6
                pe_ms = data.get("prompt_eval_duration", 0) / 1e6
                pe_n  = data.get("prompt_eval_count", 0)
                ev_ms = data.get("eval_duration", 0) / 1e6
                ev_n  = data.get("eval_count", 0)
                tot_ms = data.get("total_duration", 0) / 1e6
                tps = (ev_n / (ev_ms / 1000)) if ev_ms > 0 else 0
                line = (
                    f"[ollama]   load={ld_ms:.0f}ms  prefill={pe_ms:.0f}ms ({pe_n} tok)  "
                    f"gen={ev_ms:.0f}ms ({ev_n} tok, {tps:.1f} tok/s)  total={tot_ms:.0f}ms"
                )
                print(line, flush=True)
                # Tee into the timing-investigation log (matches orchestrate.py's _TEE_PATH).
                try:
                    with open("/tmp/pb_orchestrate.log", "a", encoding="utf-8") as f:
                        f.write(line + "\n")
                except Exception:
                    pass
            except Exception:
                pass
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

    # ---- Parallelized classify loop (Phase 4) ----
    # Each annotation classify_one is an independent HTTP POST to Ollama —
    # I/O-bound, perfect for thread parallelism. We dispatch up to PARALLEL
    # at a time and reassemble in the original annotation order so the
    # downstream edit application is deterministic.
    def _one(idx, ann):
        op = classify_one(
            ann.get("content", ""),
            doc_summary,
            ref_summary,
            marked_text=ann.get("marked_text"),
            line_text=ann.get("line_text"),
            annotation_type=ann.get("type"),
        )
        if not op:
            return idx, {
                "op": "HUMAN_REVIEW", "target": {}, "params": {}, "confidence": 1.0,
                "rationale": "Ollama returned no/unparseable output",
                "source_annotation": ann.get("content", "")[:300],
            }, None
        op = _validate_op(op, doc_summary) or {
            "op": "HUMAN_REVIEW", "target": {}, "params": {}, "confidence": 1.0,
            "rationale": "Validation rejected", "source_annotation": ann.get("content", "")[:300],
        }
        note = ann.get("content", "") if (
            op.get("op") == "HUMAN_REVIEW"
            and str(op.get("rationale", "")).lower().startswith("note")
        ) else None
        return idx, op, note

    workers = min(PARALLEL, max(1, len(annotations)))
    if workers > 1 and len(annotations) > 1:
        line = (f"[ollama]   dispatching {len(annotations)} classify call(s) "
                f"with {workers} parallel worker(s)")
        print(line, flush=True)
        try:
            with open("/tmp/pb_orchestrate.log", "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass

    results = [None] * len(annotations)  # ordered slots
    notes = []
    if workers > 1:
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="ollama") as pool:
            futures = [pool.submit(_one, i, a) for i, a in enumerate(annotations)]
            for fut in as_completed(futures):
                idx, op, note = fut.result()
                results[idx] = op
                if note:
                    notes.append(note)
    else:
        # Single-annotation path — keep serial to avoid thread overhead.
        for i, ann in enumerate(annotations):
            idx, op, note = _one(i, ann)
            results[idx] = op
            if note:
                notes.append(note)

    return {"edits": results, "human_notes": notes}
