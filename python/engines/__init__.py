"""Per-app engines. Each engine encapsulates the parts of the pipeline that
talk directly to a native application — currently InDesign, with Illustrator
coming next. Shared concerns (PDF annotation extraction, the classifier
cascade, findings aggregation, font activation) stay in the orchestrator.
"""
from pathlib import Path

from .base import Engine
from .indesign import InDesignEngine
from .illustrator import IllustratorEngine


_REGISTRY = (InDesignEngine, IllustratorEngine)


def get_engine(source_path):
    """Pick the engine whose extensions match the source file. Falls back to
    InDesign for unrecognized extensions (current default behavior).
    """
    ext = Path(source_path).suffix.lower()
    for engine_cls in _REGISTRY:
        if ext in engine_cls.extensions:
            return engine_cls()
    return InDesignEngine()


__all__ = ["Engine", "InDesignEngine", "IllustratorEngine", "get_engine"]
