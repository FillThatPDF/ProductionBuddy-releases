"""Engine base class. Subclasses describe a host application (InDesign,
Illustrator, etc.) by binding the AppleScript app name + the JSX templates
the orchestrator should run. Concrete engines override paths only — the
script-running mechanics are shared.
"""
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent

# JSX template root resolution:
#   1. If running inside a PyInstaller bundle (sys.frozen), the binary is at
#      Contents/Resources/python-engine/orchestrate. Electron-builder ships
#      jsx/ as a sibling at Contents/Resources/jsx/. Resolve via env var
#      (PB_RESOURCES_DIR) which main.js sets to process.resourcesPath.
#   2. Otherwise (dev mode: `npm start`), use the repo layout:
#      python/engines/base.py → ../../jsx/
def _resolve_jsx_root():
    env_dir = os.environ.get("PB_RESOURCES_DIR")
    if env_dir:
        return Path(env_dir) / "jsx"
    if getattr(sys, "frozen", False):
        # PyInstaller bundle — sys.executable is the binary inside python-engine/
        return Path(sys.executable).parent.parent / "jsx"
    return HERE.parent.parent / "jsx"


JSX_ROOT = _resolve_jsx_root()


class Engine:
    # File extensions this engine handles, e.g. (".indd",)
    extensions = ()
    # AppleScript application name, e.g. "Adobe InDesign 2026"
    app_name = ""
    # Human label, used in logs / UI
    label = ""

    # Paths to JSX templates this engine ships. None for templates that
    # don't apply (e.g. relink doesn't apply to Word).
    inspect_template = None
    apply_template = None
    relink_template = None
    reexport_template = None

    def run_script(self, jsx_path, timeout=1200):
        """Run a JSX file inside the host app via osascript."""
        return subprocess.run([
            "osascript",
            "-e", f"with timeout of {timeout} seconds",
            "-e", f'tell application "{self.app_name}"',
            "-e", f'do script (POSIX file "{jsx_path}") language javascript',
            "-e", "end tell",
            "-e", "end timeout",
        ], capture_output=True, text=True, timeout=timeout)
