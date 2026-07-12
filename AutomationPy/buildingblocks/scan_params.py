"""Single source of truth for scan parameters.

Before this module the same "what does dwell/latency/cookie default to?"
question was answered in four different places, each with a different
spelling:

  * macros/__init__.py and macros/raster.py: hardcoded constructor defaults
    (frame_blank=True, MAX_PIPELINE=32, padding dwell_time=2)
  * macros/vector.py: module-level constants
    (_FPGA_PIPELINE_DEPTH_PIXELS, _DRAIN_SAFETY_FACTOR, _SENDER_DRAIN_TIMEOUT_S)
  * streamData.json: camelCase config keys
    (rasterScan.frameBlank, vectorScan.latency, vectorScan.drainFloorPixels)
  * glasgow_service.models: snake_case Pydantic field defaults
    (frame_blank, latency_bytes)
  * Frontend store: another set of TypeScript defaults

When any of these drifted out of sync, the answer the device actually used
depended on which import path the caller happened to take. This module
collapses all of that into two frozen dataclasses with a single conversion
path:

    JSON config  --(from_json)-->  RasterParams / VectorParams
    API request  --(.override)-->  effective params, passed to the macros

Anything the macros need at runtime — including the magic tuning constants
that used to be hardcoded — is now a field on these dataclasses. Callers
that don't care about a tuning constant pass nothing and the macro keeps
its current behavior. Callers that do can override per-build from JSON or
per-request from the UI/REST without editing macro source.

JSON key compatibility: from_json() accepts both the existing camelCase
keys in streamData.json (`frameBlank`, `latency`, `drainFloorPixels`) and
the snake_case keys used everywhere else, so we don't need to migrate the
JSON file in lockstep with this refactor.
"""

from __future__ import annotations

from dataclasses import dataclass, replace, asdict, fields
from typing import Any, List, Optional, Tuple


# Defaults that match the previous hardcoded behavior in macros/__init__.py,
# macros/raster.py, and macros/vector.py. Exposed as module-level constants
# so other code (tests, the service's /defaults endpoint) can reference them
# without instantiating a dataclass first.

# Raster
DEFAULT_RASTER_RESOLUTION              = 512
DEFAULT_RASTER_DWELL                   = 2
DEFAULT_RASTER_LATENCY_BYTES           = 16384
DEFAULT_RASTER_FRAME_BLANK             = False
DEFAULT_RASTER_COOKIE                  = 123
DEFAULT_RASTER_OUTPUT_MODE             = "SixteenBit"
DEFAULT_RASTER_BEAM_TYPE               = "Ion"
DEFAULT_RASTER_EXTERNAL_CONTROL        = True
DEFAULT_RASTER_MAX_PIPELINE            = 32
DEFAULT_RASTER_PADDING_MIN_PIXELS      = 128
DEFAULT_RASTER_PADDING_RATIO_DENOM     = 200      # padding = total // 200 (0.5%)
DEFAULT_RASTER_PADDING_DWELL           = 2        # used to be literally =2 in the sender
DEFAULT_RASTER_SENDER_DRAIN_TIMEOUT_S  = 60.0

# Vector
DEFAULT_VECTOR_PATTERN                 = "default"
DEFAULT_VECTOR_RESOLUTION              = 2048
DEFAULT_VECTOR_DWELL                   = 1
DEFAULT_VECTOR_LATENCY_BYTES           = 8196
DEFAULT_VECTOR_OUTPUT_MODE             = "SixteenBit"
DEFAULT_VECTOR_BEAM_TYPE               = "Ion"
DEFAULT_VECTOR_EXTERNAL_CONTROL        = True
DEFAULT_VECTOR_COOKIE                  = 123
DEFAULT_VECTOR_PRE_PROCESS             = False
DEFAULT_VECTOR_DO_VALIDATE             = True
DEFAULT_VECTOR_MAX_PIPELINE            = 4
DEFAULT_VECTOR_FPGA_PIPELINE_DEPTH     = 14_000
DEFAULT_VECTOR_DRAIN_SAFETY_FACTOR     = 1.5
DEFAULT_VECTOR_SENDER_DRAIN_TIMEOUT_S  = 15.0


# --------------------------------------------------------------------------
# Internal helpers
# --------------------------------------------------------------------------

def _pick(cfg: dict, *keys, default=None):
    """Return cfg[k] for the first k in keys that's present. Lets from_json
    accept either the streamData.json camelCase spelling or the API
    snake_case spelling without having to migrate the JSON file."""
    if cfg is None:
        return default
    for k in keys:
        if k in cfg and cfg[k] is not None:
            return cfg[k]
    return default


def _coerce_int(v, default):
    if v is None:
        return default
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _coerce_bool(v, default):
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    if isinstance(v, str):
        return v.strip().lower() in ("true", "1", "yes", "on")
    return default


def _coerce_float(v, default):
    if v is None:
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _coerce_output_mode(v, default):
    """Normalize to the strings the OutputMode IntEnum is keyed by."""
    if v is None:
        return default
    s = str(v).strip()
    return s if s in ("SixteenBit", "EightBit", "NoOutput") else default


def _coerce_beam_type(v, default):
    if v is None:
        return default
    s = str(v).strip()
    return s if s in ("NoBeam", "Electron", "Ion") else default


# --------------------------------------------------------------------------
# RasterParams
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class RasterParams:
    """All inputs a raster scan needs, in one place.

    The first block is what the UI/REST exposes as user-tunable. The second
    block is the macro-internal tuning constants that used to be magic
    numbers in the macro source. Each has a hand-tuned default; callers
    should usually leave them alone, but they're parameters now so they
    *can* be overridden per-build from JSON or per-request from a debugging
    session without editing macro code.
    """
    # --- exposed to UI / REST ---------------------------------------------
    resolution:    int  = DEFAULT_RASTER_RESOLUTION
    dwell:         int  = DEFAULT_RASTER_DWELL
    latency_bytes: int  = DEFAULT_RASTER_LATENCY_BYTES
    frame_blank:   bool = DEFAULT_RASTER_FRAME_BLANK
    cookie:        int  = DEFAULT_RASTER_COOKIE
    output_mode:   str  = DEFAULT_RASTER_OUTPUT_MODE
    beam_type:     str  = DEFAULT_RASTER_BEAM_TYPE
    external_control: bool = DEFAULT_RASTER_EXTERNAL_CONTROL

    # --- macro tuning (rarely overridden) ---------------------------------
    max_pipeline:              int = DEFAULT_RASTER_MAX_PIPELINE
    padding_min_pixels:        int = DEFAULT_RASTER_PADDING_MIN_PIXELS
    padding_ratio_denominator: int = DEFAULT_RASTER_PADDING_RATIO_DENOM
    padding_dwell:             int = DEFAULT_RASTER_PADDING_DWELL
    sender_drain_timeout_s:     float = DEFAULT_RASTER_SENDER_DRAIN_TIMEOUT_S

    @classmethod
    def from_json(cls, cfg: Optional[dict]) -> "RasterParams":
        """Build defaults from a streamData.json rasterScan block.

        Accepts both camelCase keys (current JSON spelling) and snake_case
        (matches the API), so we can rename JSON keys later without a
        coordinated change here.

        The `pixels` key in the JSON has historically meant "samples per
        chunk"; the API exposes the same thing as `latency_bytes`, with
        `latency_bytes = pixels * 2` for the 16-bit output path. We honor
        an explicit `latency_bytes` if present, otherwise fall back to
        `pixels * 2`.
        """
        if cfg is None:
            return cls()
        latency = _pick(cfg, "latency_bytes")
        if latency is None:
            pixels = _pick(cfg, "pixels")
            if pixels is not None:
                latency = _coerce_int(pixels, 0) * 2
        return cls(
            resolution    = _coerce_int(_pick(cfg, "resolution"),                  DEFAULT_RASTER_RESOLUTION),
            dwell         = _coerce_int(_pick(cfg, "dwell"),                       DEFAULT_RASTER_DWELL),
            latency_bytes = _coerce_int(latency,                                   DEFAULT_RASTER_LATENCY_BYTES),
            frame_blank   = _coerce_bool(_pick(cfg, "frame_blank", "frameBlank"),  DEFAULT_RASTER_FRAME_BLANK),
            cookie        = _coerce_int(_pick(cfg, "cookie"),                      DEFAULT_RASTER_COOKIE),
            output_mode   = _coerce_output_mode(
                _pick(cfg, "output_mode", "outputMode"),                           DEFAULT_RASTER_OUTPUT_MODE),
            beam_type     = _coerce_beam_type(
                _pick(cfg, "beam_type", "beamType"),                                DEFAULT_RASTER_BEAM_TYPE),
            external_control = _coerce_bool(
                _pick(cfg, "external_control", "externalControl"),                  DEFAULT_RASTER_EXTERNAL_CONTROL),

            max_pipeline              = _coerce_int(
                _pick(cfg, "max_pipeline", "maxPipeline"),                         DEFAULT_RASTER_MAX_PIPELINE),
            padding_min_pixels        = _coerce_int(
                _pick(cfg, "padding_min_pixels", "paddingMinPixels"),              DEFAULT_RASTER_PADDING_MIN_PIXELS),
            padding_ratio_denominator = _coerce_int(
                _pick(cfg, "padding_ratio_denominator", "paddingRatioDenominator"),
                DEFAULT_RASTER_PADDING_RATIO_DENOM),
            padding_dwell             = _coerce_int(
                _pick(cfg, "padding_dwell", "paddingDwell"),                       DEFAULT_RASTER_PADDING_DWELL),
            sender_drain_timeout_s    = _coerce_float(
                _pick(cfg, "sender_drain_timeout_s", "senderDrainTimeoutS"),        DEFAULT_RASTER_SENDER_DRAIN_TIMEOUT_S),
        )

    def override(self, **kwargs: Any) -> "RasterParams":
        """Return a copy with any fields that appear in `kwargs` and have
        non-None values replaced. Silently ignores unknown keys so callers
        can pass `req.model_dump()` directly without filtering."""
        valid_names = {f.name for f in fields(self)}
        updates = {k: v for k, v in kwargs.items()
                   if k in valid_names and v is not None}
        return replace(self, **updates) if updates else self

    def to_public_dict(self) -> dict:
        """Snake_case dict for the /defaults REST endpoint. The frontend
        consumes this directly without needing a translation layer."""
        return asdict(self)


# --------------------------------------------------------------------------
# VectorParams
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class VectorParams:
    """All inputs a vector scan needs, in one place. Same shape as
    RasterParams: user-visible fields first, then macro-internal tuning
    constants with hand-tuned defaults.

    `points` is here so the macro builder in the service can stop
    inspecting the Pydantic request directly — everything it needs comes
    from one object.
    """
    # --- exposed to UI / REST ---------------------------------------------
    pattern:           str  = DEFAULT_VECTOR_PATTERN
    vector_resolution: int  = DEFAULT_VECTOR_RESOLUTION
    dwell:             int  = DEFAULT_VECTOR_DWELL
    latency_bytes:     int  = DEFAULT_VECTOR_LATENCY_BYTES
    output_mode:       str  = DEFAULT_VECTOR_OUTPUT_MODE
    beam_type:         str  = DEFAULT_VECTOR_BEAM_TYPE
    external_control:  bool = DEFAULT_VECTOR_EXTERNAL_CONTROL
    cookie:            int  = DEFAULT_VECTOR_COOKIE
    pre_process:       bool = DEFAULT_VECTOR_PRE_PROCESS
    do_validate:       bool = DEFAULT_VECTOR_DO_VALIDATE
    points:            Optional[List[Tuple[int, int, int]]] = None

    # --- macro tuning (rarely overridden) ---------------------------------
    max_pipeline:               int   = DEFAULT_VECTOR_MAX_PIPELINE
    fpga_pipeline_depth_pixels: int   = DEFAULT_VECTOR_FPGA_PIPELINE_DEPTH
    drain_safety_factor:        float = DEFAULT_VECTOR_DRAIN_SAFETY_FACTOR
    sender_drain_timeout_s:     float = DEFAULT_VECTOR_SENDER_DRAIN_TIMEOUT_S

    # Convenience: macro callers historically expected an explicit
    # `drain_floor_pixels` knob. Derive it from the depth × safety factor
    # if not set explicitly; allow direct override for backward compat
    # with the existing streamData.json `vectorScan.drainFloorPixels`.
    drain_floor_pixels:         Optional[int] = None

    @classmethod
    def from_json(cls, cfg: Optional[dict]) -> "VectorParams":
        if cfg is None:
            return cls()
        return cls(
            pattern           = str(_pick(cfg, "pattern",                     default=DEFAULT_VECTOR_PATTERN)),
            vector_resolution = _coerce_int(
                _pick(cfg, "vector_resolution", "vectorResolution"),          DEFAULT_VECTOR_RESOLUTION),
            dwell             = _coerce_int(
                _pick(cfg, "dwell"),                                          DEFAULT_VECTOR_DWELL),
            latency_bytes     = _coerce_int(
                _pick(cfg, "latency_bytes", "latency"),                       DEFAULT_VECTOR_LATENCY_BYTES),
            output_mode       = _coerce_output_mode(
                _pick(cfg, "output_mode", "outputMode"),                      DEFAULT_VECTOR_OUTPUT_MODE),
            beam_type         = _coerce_beam_type(
                _pick(cfg, "beam_type", "beamType"),                           DEFAULT_VECTOR_BEAM_TYPE),
            external_control  = _coerce_bool(
                _pick(cfg, "external_control", "externalControl"),             DEFAULT_VECTOR_EXTERNAL_CONTROL),
            cookie            = _coerce_int(_pick(cfg, "cookie"),             DEFAULT_VECTOR_COOKIE),
            pre_process       = _coerce_bool(
                _pick(cfg, "pre_process", "preProcess"),                      DEFAULT_VECTOR_PRE_PROCESS),
            do_validate       = _coerce_bool(
                _pick(cfg, "do_validate", "doValidate"),                      DEFAULT_VECTOR_DO_VALIDATE),

            max_pipeline               = _coerce_int(
                _pick(cfg, "max_pipeline", "maxPipeline"),                    DEFAULT_VECTOR_MAX_PIPELINE),
            fpga_pipeline_depth_pixels = _coerce_int(
                _pick(cfg, "fpga_pipeline_depth_pixels", "fpgaPipelineDepthPixels"),
                DEFAULT_VECTOR_FPGA_PIPELINE_DEPTH),
            drain_safety_factor        = _coerce_float(
                _pick(cfg, "drain_safety_factor", "drainSafetyFactor"),       DEFAULT_VECTOR_DRAIN_SAFETY_FACTOR),
            sender_drain_timeout_s     = _coerce_float(
                _pick(cfg, "sender_drain_timeout_s", "senderDrainTimeoutS"),  DEFAULT_VECTOR_SENDER_DRAIN_TIMEOUT_S),
            drain_floor_pixels         = (
                _coerce_int(_pick(cfg, "drain_floor_pixels", "drainFloorPixels"), 0)
                if _pick(cfg, "drain_floor_pixels", "drainFloorPixels") is not None
                else None
            ),
        )

    def override(self, **kwargs: Any) -> "VectorParams":
        valid_names = {f.name for f in fields(self)}
        updates = {k: v for k, v in kwargs.items()
                   if k in valid_names and v is not None}
        return replace(self, **updates) if updates else self

    def to_public_dict(self) -> dict:
        d = asdict(self)
        # `points` can be huge; omit from /defaults responses. The UI sets
        # points from its own editor, not from a server default.
        d.pop("points", None)
        return d

    @property
    def effective_drain_floor_pixels(self) -> int:
        """Resolve the drain floor: explicit override wins, otherwise
        derive from FPGA pipeline depth × safety factor. The macro reads
        this rather than the raw fields to keep its logic free of policy."""
        if self.drain_floor_pixels is not None:
            return int(self.drain_floor_pixels)
        return int(self.fpga_pipeline_depth_pixels * self.drain_safety_factor)
