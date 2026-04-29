"""Hi-res stock-photo swap.

Reviewer workflow: designers place WATERMARKED comp images while iterating
("gettyimages-…-Preview.jpg", "AdobeStock_…_Preview.jpeg", "stock-photo-…
.jpg") and download the licensed hi-res versions to a Box "Images" folder
once the design is approved. This module finds every placed image whose
filename matches a stock-photo pattern, extracts the photo's numeric ID,
and looks for a hi-res counterpart in the user-supplied folder.

The match is "filename contains the same numeric ID" — handles the common
"ICF_<id>.jpg" prefix convention but doesn't require it.

Returns a list of {source_filename, target_path, photo_id} that can be
written to relinks.json and applied via the existing relink.jsx pipeline.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import List, Optional


# A stock-photo ID is the longest run of 7+ digits in the filename (after
# stripping any trailing variant-like suffix). Empirically this catches:
#   gettyimages-1176523871-170667a.jpg     → 1176523871
#   AdobeStock_296386160_Preview.jpeg      → 296386160
#   stock-photo-...-1017169942.jpg         → 1017169942
#   shutterstock_2057281913.jpg            → 2057281913
#   istockphoto-1234567890-612x612.jpg     → 1234567890
_NUMERIC_ID_RE = re.compile(r"\d{7,}")


def extract_photo_id(filename: str) -> Optional[str]:
    """Return the longest 7+ digit numeric ID found in the filename, or None."""
    if not filename:
        return None
    name = Path(filename).stem  # drop extension so 1234.jpg's '1234' isn't confused
    matches = _NUMERIC_ID_RE.findall(name)
    if not matches:
        return None
    # Pick the LONGEST match — shorter numbers in the filename are usually
    # variant codes (e.g. "612x612", "170667a") not the photo ID itself.
    matches.sort(key=len, reverse=True)
    return matches[0]


# Common stock-photo filename patterns; if a filename matches any of these
# we're confident it's a comp that should be swapped. Otherwise we skip
# (e.g. project-specific images named by the design team).
_STOCK_FILENAME_HINTS = (
    "getty",
    "adobestock",
    "stock-photo",
    "shutterstock",
    "istockphoto",
    "_preview",
    "-preview",
)


def looks_like_stock_comp(filename: str) -> bool:
    """Heuristic: does the filename look like a downloaded watermarked comp?"""
    n = (filename or "").lower()
    return any(h in n for h in _STOCK_FILENAME_HINTS)


def index_hires_folder(folder: str | Path) -> dict:
    """Walk the hi-res folder and return a dict: photo_id → absolute path.

    For files whose name yields multiple numeric IDs, we index under each
    one — small filenames are cheap and a multi-ID hit is harmless.
    """
    index = {}
    folder_path = Path(folder)
    if not folder_path.exists() or not folder_path.is_dir():
        return index
    for p in folder_path.rglob("*"):
        if not p.is_file():
            continue
        # Index by ALL 7+ digit numeric runs in the filename (not just the
        # longest) — gives us a chance to match a hi-res asset whose name
        # has the photo ID alongside other long numbers (file size, hash).
        for m in _NUMERIC_ID_RE.findall(p.stem):
            # Don't overwrite a previous match — first-found wins (folders
            # walked top-down, deeper duplicates ignored).
            index.setdefault(m, str(p.resolve()))
    return index


def plan_swaps(placed_image_paths: List[str], hires_folder: str | Path) -> List[dict]:
    """For each placed image that looks like a stock-photo comp, find a
    matching hi-res file in `hires_folder`. Returns a list of relink dicts
    suitable for relinks.json:
        [{"source_filename": "<comp.jpg>", "target_path": "<hires.jpg>",
          "photo_id": "<id>"}, ...]
    Images that don't look like stock comps, or don't have a match in the
    hi-res folder, are simply omitted.
    """
    if not hires_folder:
        return []
    index = index_hires_folder(hires_folder)
    if not index:
        return []

    swaps = []
    seen = set()
    for source in placed_image_paths:
        if not source:
            continue
        name = Path(source).name
        if not looks_like_stock_comp(name):
            continue
        photo_id = extract_photo_id(name)
        if not photo_id:
            continue
        target = index.get(photo_id)
        if not target:
            continue
        # Don't propose the same swap twice (same image used multiple times)
        key = (name, target)
        if key in seen:
            continue
        seen.add(key)
        # Also skip if source IS already the target (already hi-res linked)
        try:
            if Path(source).resolve() == Path(target).resolve():
                continue
        except Exception:
            pass
        swaps.append({
            "source_filename": name,
            "target_path": target,
            "photo_id": photo_id,
        })
    return swaps
