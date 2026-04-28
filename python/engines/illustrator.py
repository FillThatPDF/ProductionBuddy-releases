"""Illustrator engine.

JSX templates live under jsx/illustrator/. Inspect + apply are required;
relink and re-export are optional add-ons we'll wire up if needed (for now
the apply template handles the export internally).
"""
from .base import Engine, JSX_ROOT


class IllustratorEngine(Engine):
    extensions = (".ai",)
    app_name = "Adobe Illustrator 2026"
    label = "Illustrator"

    inspect_template  = JSX_ROOT / "illustrator" / "inspect_doc.jsx"
    apply_template    = JSX_ROOT / "illustrator" / "apply_edits.jsx"
    relink_template   = None  # not yet implemented
    reexport_template = None  # apply_edits handles export
