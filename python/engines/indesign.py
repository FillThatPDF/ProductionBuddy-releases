"""InDesign engine — the original target app.

Templates live at the repo's jsx/ root (kept there to avoid breaking history
and any external reference paths). Other engines have their own subdir.
"""
from .base import Engine, JSX_ROOT


class InDesignEngine(Engine):
    extensions = (".indd",)
    app_name = "Adobe InDesign 2026"
    label = "InDesign"

    inspect_template  = JSX_ROOT / "inspect_doc.jsx"
    apply_template    = JSX_ROOT / "apply_edits_v2.jsx"
    relink_template   = JSX_ROOT / "relink.jsx"
    reexport_template = JSX_ROOT / "re_export.jsx"
