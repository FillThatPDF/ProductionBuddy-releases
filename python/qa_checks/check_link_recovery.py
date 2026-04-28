"""For each missing-link finding, search Box cloud storage and recognize stock-photo
filename patterns to give the user actionable recovery paths.

Box search uses Spotlight (`mdfind`) restricted to the mounted Box folder.
Tries the exact filename, plus common prefix variants ('ICF_' on/off).

Stock-photo recognition:
  shutterstock_<id>... → https://www.shutterstock.com/image-photo/-<id>
  gettyimages_<id>... or gi_<id>... → https://www.gettyimages.com/detail/<id>
  istock_<id>... → https://www.istockphoto.com/photo/<id>
  adobestock_<id>... → https://stock.adobe.com/<id>
"""
import os
import re
import shlex
import subprocess
from pathlib import Path


BOX_ROOT_CANDIDATES = [
    Path.home() / "Library/CloudStorage/Box-Box",
    Path.home() / "Box",
    Path.home() / "Box Sync",
]


def find_box_root():
    for p in BOX_ROOT_CANDIDATES:
        if p.exists() and p.is_dir():
            return p
    return None


def mdfind_in(folder, query, limit=10):
    try:
        proc = subprocess.run(
            ["mdfind", "-onlyin", str(folder), query],
            capture_output=True, text=True, timeout=15,
        )
        lines = [l for l in proc.stdout.strip().split("\n") if l]
        return lines[:limit]
    except Exception:
        return []


def search_box(filename):
    """Return list of paths in Box that match the filename, with/without ICF_ prefix."""
    box_root = find_box_root()
    if not box_root:
        return []
    results = []
    seen = set()
    base = Path(filename).stem
    ext = Path(filename).suffix.lower()

    candidates = [filename, base + ext]
    if not filename.startswith("ICF_"):
        candidates.append("ICF_" + filename)
    if filename.startswith("ICF_"):
        candidates.append(filename[4:])
    # Also try base name without prefix
    if base.startswith("ICF_"):
        candidates.append(base[4:] + ext)

    for cand in candidates:
        # Match exact filename
        for path in mdfind_in(box_root, f'kMDItemFSName == "{cand}"cd'):
            if path not in seen:
                results.append(path); seen.add(path)
        # Also fuzzy match by base name as content
        if len(base) >= 8:
            for path in mdfind_in(box_root, f'kMDItemFSName == "*{base}*"cd'):
                if path not in seen:
                    results.append(path); seen.add(path)
    return results[:5]  # cap


STOCK_PATTERNS = [
    (re.compile(r"shutterstock[_-]?(\d{6,})", re.I), "Shutterstock", "https://www.shutterstock.com/image-photo/-{id}"),
    (re.compile(r"gettyimages?[_-]?(\d{6,})", re.I), "Getty Images", "https://www.gettyimages.com/detail/{id}"),
    (re.compile(r"\bgi[_-]?(\d{8,})", re.I),         "Getty Images", "https://www.gettyimages.com/detail/{id}"),
    (re.compile(r"istock[_-]?(\d{6,})", re.I),       "iStock",       "https://www.istockphoto.com/photo/{id}"),
    (re.compile(r"adobestock[_-]?(\d{6,})", re.I),   "Adobe Stock",  "https://stock.adobe.com/{id}"),
]


def detect_stock_source(filename):
    for pat, source, url_tpl in STOCK_PATTERNS:
        m = pat.search(filename)
        if m:
            return {"source": source, "asset_id": m.group(1), "url": url_tpl.format(id=m.group(1))}
    return None


def parse_missing_links_from_findings(findings_path):
    """Return list of missing-link filenames found in findings.json."""
    import json
    try:
        data = json.loads(Path(findings_path).read_text())
    except Exception:
        return []
    missing = []
    for f in data.get("findings", []):
        if f.get("id") == "LINK_MISSING":
            # Message is like "2 missing link(s): foo.jpg, bar.eps"
            msg = f.get("message", "")
            after = msg.split(":", 1)[-1] if ":" in msg else msg
            for piece in after.split(","):
                name = piece.strip()
                if name and "." in name:
                    missing.append(name)
    return missing


def run(work_dir, deliverables_dir=None):
    findings = []
    missing = parse_missing_links_from_findings(Path(work_dir) / "findings.json")
    if not missing:
        return findings

    box_root = find_box_root()
    has_box = box_root is not None

    for filename in missing:
        candidates = search_box(filename) if has_box else []
        stock = detect_stock_source(filename)
        bits = []
        if candidates:
            bits.append("Box matches: " + " | ".join(c.replace(str(box_root) + "/", "") for c in candidates))
        if stock:
            bits.append(f"{stock['source']} asset (ID {stock['asset_id']}) — {stock['url']}")
        if not bits:
            bits.append("No Box match found.  Search Box manually or re-acquire the asset.")
            if not has_box:
                bits.append("(Box folder not mounted at expected location.)")
        findings.append({
            "severity": "warning",
            "id": "LINK_RECOVERY",
            "category": "links",
            "location": filename,
            "message": "Recovery options for missing link '" + filename + "': " + " ; ".join(bits),
            "autoFix": False,
            "fixAction": "Re-link in InDesign (Window → Links → click missing-link icon → choose recovered file)",
        })
    return findings
