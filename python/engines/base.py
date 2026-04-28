"""Engine base class. Subclasses describe a host application (InDesign,
Illustrator, etc.) by binding the AppleScript app name + the JSX templates
the orchestrator should run. Concrete engines override paths only — the
script-running mechanics are shared.
"""
import subprocess
from pathlib import Path

HERE = Path(__file__).parent
JSX_ROOT = HERE.parent.parent / "jsx"


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
