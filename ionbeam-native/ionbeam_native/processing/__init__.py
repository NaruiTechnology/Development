"""Processing patterns: JSON-configured data models for the Processing tab.

``config`` loads ``processingPatterns.json``; ``models`` holds the pattern data
models (parameters + the ROI the operator drew). The Qt layer lives in
``ui/processing.py`` and only binds to these objects.
"""
from .config import (  # noqa: F401
    PatternConfigError, PatternSpec, ParameterSpec, ProcessingConfig, load_config, load_models,
)
from .models import MODEL_REGISTRY, PatternModel  # noqa: F401
