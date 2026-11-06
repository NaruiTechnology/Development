"""Load ``processingPatterns.json`` (same one-key-object layout as the deploy
workflow's ``Actions`` list) and instantiate the data models.

``Skip: true`` entries are parsed for validation only: they get no model and
therefore no icon / card. A broken entry never takes the others down; it is
reported in ``ProcessingConfig.errors`` for the UI to show.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .models import MODEL_REGISTRY, ParameterSpec

log = logging.getLogger(__name__)
ROI_KINDS = ("rect", "circle", "ring", "polygon")
PARAM_TYPES = ("int", "float", "bool", "choice")


class PatternConfigError(ValueError):
    """The file as a whole is unusable (missing, not JSON, wrong top-level shape)."""


@dataclass
class PatternSpec:
    key: str
    skip: bool
    model: str
    caption: str
    icon: str
    roi: str
    parameters: list = field(default_factory=list)


@dataclass
class ProcessingConfig:
    header: dict = field(default_factory=dict)
    specs: list = field(default_factory=list)       # every well-formed entry, skipped or not
    errors: list = field(default_factory=list)      # human-readable problems with single entries
    path: Optional[Path] = None

    @property
    def active_specs(self) -> list:
        return [s for s in self.specs if not s.skip]


def _parameters(key: str, raw) -> list:
    if raw is None:
        return []
    if not isinstance(raw, dict):
        raise ValueError(f"{key}: 'parameters' must be an object")
    out = []
    for name, d in raw.items():
        if not isinstance(d, dict):
            raise ValueError(f"{key}.{name}: parameter must be an object")
        ptype = d.get("type", "float")
        if ptype not in PARAM_TYPES:
            raise ValueError(f"{key}.{name}: unknown type {ptype!r}")
        spec = ParameterSpec(name=name, label=str(d.get("label", name)), type=ptype,
                             default=d.get("default", 0), minimum=d.get("min"), maximum=d.get("max"),
                             step=d.get("step", 1) or 1, unit=str(d.get("unit", "")),
                             choices=list(d.get("choices", [])))
        if ptype == "choice" and not spec.choices:
            raise ValueError(f"{key}.{name}: choice parameter needs 'choices'")
        spec.default = spec.coerce(spec.default)
        out.append(spec)
    return out


def parse_config(data) -> ProcessingConfig:
    if not isinstance(data, dict) or not isinstance(data.get("Patterns"), list):
        raise PatternConfigError("processing patterns file needs a top-level 'Patterns' list")
    cfg = ProcessingConfig(header=data.get("Header") if isinstance(data.get("Header"), dict) else {})
    seen = set()
    for i, entry in enumerate(data["Patterns"]):
        try:
            if not isinstance(entry, dict) or len(entry) != 1:
                raise ValueError(f"entry {i}: expected an object with exactly one key (the pattern name)")
            (key, body), = entry.items()
            if key in seen:
                raise ValueError(f"{key}: duplicate pattern name")
            if not isinstance(body, dict):
                raise ValueError(f"{key}: value must be an object")
            roi = body.get("roi", "rect")
            if roi not in ROI_KINDS:
                raise ValueError(f"{key}: unknown roi kind {roi!r}")
            model = body.get("model")
            if not isinstance(model, str) or not model:
                raise ValueError(f"{key}: missing 'model'")
            skip = bool(body.get("skip", False))
            if not skip and model not in MODEL_REGISTRY:
                raise ValueError(f"{key}: model {model!r} is not implemented")
            if not skip and MODEL_REGISTRY[model].ROI_KIND != roi:
                raise ValueError(f"{key}: roi {roi!r} does not match {model}.ROI_KIND "
                                 f"{MODEL_REGISTRY[model].ROI_KIND!r}")
            seen.add(key)
            cfg.specs.append(PatternSpec(key=key, skip=skip, model=model,
                                         caption=str(body.get("caption", key)), icon=str(body.get("icon", "")),
                                         roi=roi, parameters=[] if skip else _parameters(key, body.get("parameters"))))
        except ValueError as e:
            log.warning("processing patterns: %s", e)
            cfg.errors.append(str(e))
    return cfg


def load_config(path) -> ProcessingConfig:
    path = Path(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as e:
        raise PatternConfigError(f"cannot read {path}: {e}") from e
    except json.JSONDecodeError as e:
        raise PatternConfigError(f"{path} is not valid JSON: {e}") from e
    cfg = parse_config(data)
    cfg.path = path
    return cfg


def build_models(cfg: ProcessingConfig) -> dict:
    """One model instance per non-skipped spec, in file order (dicts keep it)."""
    return {s.key: MODEL_REGISTRY[s.model](s.key, s.parameters, caption=s.caption, icon=s.icon)
            for s in cfg.active_specs}


def load_models(path) -> tuple:
    cfg = load_config(path)
    return cfg, build_models(cfg)
