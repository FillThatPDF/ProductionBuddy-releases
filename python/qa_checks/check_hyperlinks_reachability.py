"""Hyperlink reachability check.

Reads hyperlinks.json (written by the JSX during STEP 13.15) and probes each
HTTP(S) destination with a HEAD request. Flags any 4xx/5xx responses or
connection failures. Mailto: links are skipped (not a network check).
"""
import json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import urllib.request
    import urllib.error
    HAS_URLLIB = True
except ImportError:
    HAS_URLLIB = False


def probe_url(url, timeout=10):
    """Returns (status_code, error_message_or_none)."""
    if not HAS_URLLIB:
        return None, "urllib not available"
    if not url.lower().startswith(("http://", "https://")):
        return None, None  # skip non-HTTP
    try:
        req = urllib.request.Request(url, method="HEAD")
        req.add_header("User-Agent", "InDesignEditor/0.1")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, None
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception as e:
        return None, str(e)[:80]


def run(work_dir, deliverables_dir=None):
    findings = []
    hyperlinks_path = Path(work_dir) / "hyperlinks.json"
    if not hyperlinks_path.exists():
        return findings
    try:
        items = json.loads(hyperlinks_path.read_text())
    except Exception:
        return findings

    http_links = [it for it in items if it.get("dest", "").lower().startswith(("http://", "https://"))]
    if not http_links:
        return findings

    failed, broken = [], []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(probe_url, item["dest"]): item for item in http_links}
        for fut in as_completed(futures):
            item = futures[fut]
            try:
                status, err = fut.result()
            except Exception as e:
                status, err = None, str(e)
            if err:
                failed.append((item, err))
            elif status and status >= 400:
                broken.append((item, status))

    if broken:
        samples = ", ".join(f"\"{it['src'][:40]}\" → {it['dest']} [{status}]" for it, status in broken[:5])
        findings.append({
            "severity": "warning",
            "id": "HYPERLINK_BROKEN",
            "category": "links",
            "location": "doc",
            "message": f"{len(broken)} hyperlink(s) returned 4xx/5xx. Examples: {samples}",
            "autoFix": False,
            "fixAction": "Verify URL or remove hyperlink",
        })
    if failed:
        samples = ", ".join(f"{it['dest']} ({err})" for it, err in failed[:3])
        findings.append({
            "severity": "warning",
            "id": "HYPERLINK_UNREACHABLE",
            "category": "links",
            "location": "doc",
            "message": f"{len(failed)} hyperlink(s) failed to connect. Examples: {samples}",
            "autoFix": False,
            "fixAction": "Verify URL is reachable",
        })
    return findings
