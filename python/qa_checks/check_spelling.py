"""Spellcheck.

Extracts all text from the output PDF and runs tokens through a dictionary.
Text engine: pypdfium2 primary, pdfplumber fallback (via PdfTextExtractor).
"""
import json
import re
import sys
from pathlib import Path


def run(work_dir, deliverables_dir=None):
    findings = []
    search_dir = Path(deliverables_dir) if deliverables_dir else Path(work_dir)
    pdfs = list(search_dir.glob("*.pdf"))
    if not pdfs:
        return findings
    pdf_path = max(pdfs, key=lambda p: p.stat().st_mtime)

    # Make sure the parent python/ dir is importable so we can pick up pdf_text
    parent = Path(__file__).resolve().parent.parent
    if str(parent) not in sys.path:
        sys.path.insert(0, str(parent))

    try:
        from pdf_text import PdfTextExtractor
        with PdfTextExtractor(str(pdf_path)) as ext:
            text = "\n".join(ext.get_full_page_text(i) for i in range(ext.page_count))
    except Exception as e:
        findings.append({
            "severity": "info",
            "id": "SPELLCHECK_SKIPPED",
            "category": "text",
            "location": "doc",
            "message": f"Spellcheck skipped (PDF read error: {e})",
            "autoFix": False,
            "fixAction": "",
        })
        return findings

    try:
        from spellchecker import SpellChecker
    except ImportError:
        findings.append({
            "severity": "info",
            "id": "SPELLCHECK_UNAVAILABLE",
            "category": "text",
            "location": "doc",
            "message": "Spellcheck unavailable. `pip install pyspellchecker` to enable.",
            "autoFix": False,
            "fixAction": "Install pyspellchecker",
        })
        return findings

    # Tokenize: words only (4+ chars), strip punctuation
    tokens = set()
    for tok in re.findall(r"[A-Za-z][A-Za-z'-]{3,}", text):
        # Skip ALL CAPS (likely acronyms) and tokens with digits/symbols already filtered
        if tok.isupper():
            continue
        tokens.add(tok.lower())

    spell = SpellChecker()
    # Add common business / proper-noun terms to dictionary as workaround
    spell.word_frequency.load_words([
        "esa", "hers", "fiberclass", "mcneely", "redfox", "mcneelybuilding",
        "leedforhomes", "energydiagnostics", "ecoachievers",
    ])
    misspelled = spell.unknown(tokens)
    # Filter out tokens that look like proper nouns (likely names, companies, emails)
    suspicious = []
    for w in sorted(misspelled):
        # Skip words that contain @ or .
        if "@" in w or w.count(".") > 0:
            continue
        # Skip if it appears in a context with an uppercase first letter only (proper noun)
        # heuristic: if the word has multiple capitals in source, likely proper noun
        # Just take a sample for human review
        suspicious.append(w)
        if len(suspicious) >= 25:
            break

    if suspicious:
        findings.append({
            "severity": "warning",
            "id": "SPELLCHECK_SUSPICIOUS",
            "category": "text",
            "location": "doc",
            "message": f"{len(misspelled)} unrecognized word(s) (showing first {len(suspicious)}): " + ", ".join(suspicious),
            "autoFix": False,
            "fixAction": "Review for typos vs proper nouns / domain terms",
        })

    return findings
