"""Activate missing fonts via FontExplorer X Pro and surface Adobe Fonts URLs.

FontExplorer X Pro: activates the matching font by family/exact name via AppleScript.
Adobe Fonts: builds a creativecloud:// deep-link or web URL for the user to activate
    manually (no public CLI exists for programmatic activation).
"""
import re
import shlex
import subprocess


def _osascript(script, timeout=20):
    try:
        proc = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=timeout,
        )
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except Exception as e:
        return -1, "", str(e)


def fontexplorer_running():
    """Check whether FontExplorer X Pro is installed."""
    code, out, _ = _osascript('tell application "System Events" to return exists application file id "com.linotype.FontExplorerX"', timeout=5)
    if code != 0:
        # Fallback: check Applications folder
        import os
        return any(os.path.exists(p) for p in [
            "/Applications/FontExplorer X Pro.app",
            "/Applications/FontExplorer X.app",
        ])
    return out.strip().lower() == "true"


def normalize_font_name(name):
    """Normalize InDesign's tabbed font names: 'Lexend\\tExtraBold' → 'Lexend ExtraBold'."""
    return re.sub(r"\s+", " ", name.replace("\t", " ")).strip()


def family_from_name(name):
    """Best-effort family extraction: take first word(s) until a known weight/style word."""
    n = normalize_font_name(name)
    style_words = {"thin", "light", "regular", "medium", "semibold", "bold", "extrabold", "black",
                   "italic", "oblique", "condensed", "extended", "narrow", "ultra", "demi"}
    words = n.split()
    out = []
    for w in words:
        if w.lower() in style_words:
            break
        out.append(w)
    return " ".join(out) if out else n


def try_fontexplorer_activate(font_full_name):
    """Attempt to activate a font in FontExplorer X Pro. Tries exact name, then family.
    Returns True if at least one matching font was successfully activated."""
    if not fontexplorer_running():
        return False
    full = normalize_font_name(font_full_name)
    family = family_from_name(font_full_name)

    # Quote-safe AppleScript: escape double-quotes
    def esc(s): return s.replace('"', '\\"')

    attempts = [
        # Exact font name match
        f'''tell application "FontExplorer X Pro"
              try
                  activate fonts (every font whose name is "{esc(full)}")
                  return "ok-exact"
              end try
              return "no-exact"
            end tell''',
        # Family-name match (activates all weights of the family)
        f'''tell application "FontExplorer X Pro"
              try
                  activate fonts (every font whose family name is "{esc(family)}")
                  return "ok-family"
              end try
              return "no-family"
            end tell''',
        # Loose match — name contains family
        f'''tell application "FontExplorer X Pro"
              try
                  activate fonts (every font whose name contains "{esc(family)}")
                  return "ok-loose"
              end try
              return "no-loose"
            end tell''',
    ]
    for script in attempts:
        code, out, err = _osascript(script)
        if code == 0 and out.startswith("ok-"):
            return True
    return False


def adobe_fonts_url(font_full_name):
    """Build an Adobe Fonts search URL for the given font family."""
    family = family_from_name(font_full_name)
    # The search URL accepts free text
    return f"https://fonts.adobe.com/search?query={family.replace(' ', '+')}"


# ---- Box-search font activation ----
import os
import shutil
from pathlib import Path

BOX_ROOT_CANDIDATES = [
    Path.home() / "Library/CloudStorage/Box-Box",
    Path.home() / "Box",
    Path.home() / "Box Sync",
]


def _find_box_root():
    for p in BOX_ROOT_CANDIDATES:
        if p.exists() and p.is_dir():
            return p
    return None


def search_box_for_font(font_full_name):
    """Search Box for matching font files. Strategy:
       1) mdfind for *<query>*<ext> (works for indexed top-level folders)
       2) Walk common Assets/Fonts/<family> paths (works when Box subfolders
          aren't fully Spotlight-indexed because of cloud streaming)
       Returns list of absolute paths, preferring exact-style matches and
       static .ttf/.otf files over variable fonts.
    """
    box_root = _find_box_root()
    if not box_root:
        return []
    family = family_from_name(font_full_name)
    full = normalize_font_name(font_full_name)
    queries = [family, full, full.replace(" ", "-"), full.replace(" ", "")]
    results = []
    seen = set()

    def add(path):
        try:
            p = str(Path(path).resolve())
            if p not in seen and Path(p).is_file():
                seen.add(p)
                results.append(p)
        except Exception:
            pass

    # Strategy 1: mdfind across Box (fast for indexed locations)
    for q in queries:
        for ext in (".otf", ".ttf", ".woff", ".woff2"):
            try:
                proc = subprocess.run(
                    ["mdfind", "-onlyin", str(box_root),
                     f'kMDItemFSName == "*{q}*{ext}"cd'],
                    capture_output=True, text=True, timeout=10,
                )
                for line in proc.stdout.strip().split("\n"):
                    if line:
                        add(line)
            except Exception:
                continue

    # Strategy 2: direct path checks for common asset-folder conventions.
    # We avoid iterdir() because Box cloud-streamed subfolders can hang.
    # Only test specific known filename patterns directly with os.path.exists().
    candidate_subdirs = [
        f"Clients/*/Assets/Fonts/{family}",
        f"Assets/Fonts/{family}",
        f"Fonts/{family}",
        f"Clients/*/Assets/Fonts",
        "Assets/Fonts",
        "Fonts",
    ]
    candidate_filenames = [
        f"{family}-VariableFont_wght.ttf",
        f"{family}-VariableFont.ttf",
        f"{family}.ttf",
        f"{family}.otf",
    ]
    # Also try full font name (e.g. "Lexend-Bold.ttf")
    full_dash = full.replace(" ", "-")
    candidate_filenames += [f"{full_dash}.ttf", f"{full_dash}.otf"]
    for sub_pattern in candidate_subdirs:
        try:
            matched_dirs = list(box_root.glob(sub_pattern)) if "*" in sub_pattern else [box_root / sub_pattern]
        except Exception:
            matched_dirs = []
        for d in matched_dirs:
            for fname in candidate_filenames:
                try:
                    p = d / fname
                    # os.path.exists is FAST — doesn't iterate
                    if p.exists() and p.is_file():
                        add(str(p))
                except Exception:
                    continue

    # Sort: prefer files whose name CONTAINS the full style (e.g. "Lexend-Bold")
    # over variable fonts (those need extra config), and exact extension matches.
    full_style_compact = full.replace(" ", "-").lower()
    def _rank(p):
        name = Path(p).name.lower()
        score = 0
        if full_style_compact in name: score -= 100  # exact style match
        if "variablefont" in name: score += 50      # variable font less preferred
        if name.endswith(".otf"): score -= 5
        return score
    results.sort(key=_rank)
    return results[:10]


def activate_font_from_file(font_path):
    """Activate a font found on disk. Tries FontExplorer X Pro 'open' (which imports
    + activates), falls back to copying into ~/Library/Fonts/."""
    if not os.path.exists(font_path):
        return False, "file not found"
    # Method 1: FontExplorer's `open` command imports and activates
    if fontexplorer_running():
        script = f'''tell application "FontExplorer X Pro"
            try
                open POSIX file "{font_path.replace('"', '\\"')}"
                return "ok-fontexplorer"
            end try
            return "no"
        end tell'''
        code, out, err = _osascript(script, timeout=30)
        if code == 0 and out.startswith("ok"):
            return True, "FontExplorer X Pro"
    # Method 2: copy to user Fonts folder
    user_fonts = Path.home() / "Library" / "Fonts"
    user_fonts.mkdir(parents=True, exist_ok=True)
    target = user_fonts / Path(font_path).name
    if target.exists():
        return True, f"already at {target}"
    try:
        shutil.copy(font_path, target)
        return True, f"copied to {target}"
    except Exception as e:
        return False, f"copy failed: {e}"


def parse_unavailable_fonts_from_findings(findings_path):
    """Return list of font names found in FONT_UNAVAILABLE findings."""
    import json
    from pathlib import Path
    try:
        data = json.loads(Path(findings_path).read_text())
    except Exception:
        return []
    fonts = []
    for f in data.get("findings", []):
        if f.get("id") != "FONT_UNAVAILABLE":
            continue
        msg = f.get("message", "")
        # Format: "N font(s) not properly installed: A, B, C"
        after = msg.split(":", 1)[-1] if ":" in msg else msg
        for name in after.split(","):
            n = name.strip()
            if n:
                fonts.append(n)
    return fonts


def activate_missing_fonts(findings_path):
    """Main entry. Cascade for each missing font:
       1. FontExplorer library activation (via name)
       2. Box file-system search → activate from file
       3. Adobe Fonts URL surfaced as a suggestion

    Returns dict { activated: [{font, source}, ...], suggested: [{font, adobe_fonts_url}, ...] }
    """
    fonts = parse_unavailable_fonts_from_findings(findings_path)
    activated, suggested = [], []
    for f in fonts:
        # 1. FontExplorer activation by family/exact name
        if try_fontexplorer_activate(f):
            activated.append({"font": f, "source": "FontExplorer X Pro library"})
            continue
        # 2. Search Box for the font file → activate from file
        box_hits = search_box_for_font(f)
        if box_hits:
            ok, where = activate_font_from_file(box_hits[0])
            if ok:
                activated.append({"font": f, "source": f"Box: {Path(box_hits[0]).name} ({where})"})
                continue
        # 3. Surface Adobe Fonts URL
        suggested.append({"font": f, "adobe_fonts_url": adobe_fonts_url(f)})
    return {"activated": activated, "suggested": suggested}
