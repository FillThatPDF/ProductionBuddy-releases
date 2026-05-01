# PyInstaller spec for the Production Buddy orchestrator.
# Builds a --onedir bundle: an executable + _internal/ folder with all
# Python deps + extension modules. We ship that whole folder under
# Contents/Resources/python-engine/ in the .app.
#
# Why --onedir, not --onefile:
#   - --onefile self-extracts to a temp dir on every launch (slow first run,
#     fragile under sandboxing). --onedir is just a folder of files.
#   - Path resolution is predictable: sys.executable's parent IS the bundle.
#   - Easier to debug: ls into the dir and see what's actually shipped.
#
# Hidden imports here are modules that PyInstaller's static analyzer can't
# follow because they're discovered dynamically (e.g. via __import__()).
# orchestrate.run_python_qa_checks does __import__(f"qa_checks.{name}") —
# those need to be listed explicitly.
import sys
from pathlib import Path

block_cipher = None

# Where this spec file lives = python/ folder.
HERE = Path(SPECPATH).resolve()  # noqa: F821 (SPECPATH injected by PyInstaller)

a = Analysis(
    ["orchestrate.py"],
    pathex=[str(HERE)],
    binaries=[],
    datas=[],
    hiddenimports=[
        # Engine plugins
        "engines",
        "engines.base",
        "engines.indesign",
        "engines.illustrator",
        # QA check modules — orchestrator imports these by string name
        "qa_checks",
        "qa_checks.check_hyperlinks_reachability",
        "qa_checks.check_link_recovery",
        "qa_checks.check_spelling",
        # Sibling modules
        "font_activator",
        "local_classifier",
        "pdf_text",
        # PDF stack: pikepdf for metadata, pypdfium2 for fast text extraction,
        # pdfplumber as the fallback for stubborn PDFs. spellchecker has its
        # own dictionary data — pyinstaller-hooks-contrib handles it.
        "pikepdf",
        "pypdfium2",
        "pdfplumber",
        "pdfminer",
        "pdfminer.six",
        "PIL",
        "spellchecker",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Trim things we don't use (saves ~30 MB)
        "tkinter",
        "test",
        "unittest",
        "lib2to3",
        "pydoc_data",
        # The shared venv has heavy ML/data-science deps from unrelated work
        # (pytorch, polars, pyarrow, opencv, transformers, sklearn, pandas,
        # scipy, matplotlib, ...). Production Buddy doesn't use any of them
        # — explicitly exclude so PyInstaller doesn't bundle them. Cuts the
        # bundle from ~960 MB → ~80 MB.
        "torch", "torchvision", "torchaudio",
        "polars", "polars._polars_runtime_32",
        "pyarrow",
        "cv2", "opencv-python", "opencv_python", "opencv-python-headless",
        "transformers", "tokenizers",
        "sklearn", "scipy", "pandas",
        "matplotlib", "seaborn",
        "numba", "llvmlite",
        "tensorflow", "keras", "jax", "jaxlib",
        # Note: lxml + cryptography are transitive deps of pikepdf — keep them.
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="orchestrate",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,                    # UPX often breaks signed/notarized binaries
    console=True,                 # we need stdout/stderr for the orchestrator
    disable_windowed_traceback=False,
    target_arch="arm64",
    codesign_identity=None,       # unsigned per the v1.0.0 plan
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name="orchestrate",
)
