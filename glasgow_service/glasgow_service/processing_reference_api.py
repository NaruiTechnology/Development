"""Reference-only Processing API, independently testable without a device service."""
import asyncio
import logging
from dataclasses import asdict
from fastapi import APIRouter, Depends, HTTPException, Query, Path
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from . import lens_lookup, pattern_recipes
from .custom_pattern_match import CustomPatternMatchError, find_custom_pattern_matches
from .milling_registration import MillingRegistrationRequest, register_milling_frames
from .auth import require_token

router = APIRouter(prefix="/processing", tags=["processing"], dependencies=[Depends(require_token)])
logger = logging.getLogger("GlasgowService")
# Bound the memory used by concurrent full-field FFTs.
_milling_match_slot = asyncio.Semaphore(1)


class CustomPatternMatchRequest(BaseModel):
    image_data: str = Field(min_length=32, max_length=15_000_000)
    template_data: str = Field(min_length=32, max_length=15_000_000)
    threshold: float = Field(default=0.99, ge=0.1, le=1.0)


@router.post("/custom-pattern-match")
async def match_custom_pattern(body: CustomPatternMatchRequest):
    try:
        matches = await run_in_threadpool(
            find_custom_pattern_matches,
            body.image_data,
            body.template_data,
            body.threshold,
        )
        return {"ok": True, "matches": matches}
    except CustomPatternMatchError as exc:
        raise HTTPException(422, str(exc)) from exc

# Reference-only calculations: these endpoints never acquire or expose a beam.
@router.post("/milling-registration")
async def milling_registration(body: MillingRegistrationRequest):
    try:
        async with _milling_match_slot:
            match = await asyncio.to_thread(register_milling_frames, body)
    except ValueError as exc:
        logger.warning("[milling-registration] pass=%d status=invalid_request reason=%s", body.pass_index, exc)
        raise HTTPException(422, str(exc)) from exc
    logger.info("[milling-registration] pass=%d resolution=%d status=%s reason=%s offset=%s correlation=%s threshold_percent=%s retries=%d",
                body.pass_index, body.resolution, "success" if match.offset is not None else "failure", match.reason,
                match.offset, match.correlation, match.threshold_percent, match.retries)
    return asdict(match)


@router.get("/lens-lookup")
async def get_processing_lens_lookup():
    try:
        return {"ok": True, "lensLookup": await asyncio.to_thread(lens_lookup.load_lens_lookup)}
    except (OSError, ValueError) as exc:
        raise HTTPException(503, f"Lens reference unavailable: {exc}") from exc


@router.get("/spot-size")
async def get_processing_spot_size(beam_voltage_kv: float = Query(..., gt=0), beam_current_pa: float = Query(..., gt=0), interpolate: bool = False):
    try:
        table = await asyncio.to_thread(lens_lookup.load_lens_lookup)
    except (OSError, ValueError) as exc:
        raise HTTPException(503, f"Lens reference unavailable: {exc}") from exc
    try:
        return lens_lookup.lookup_spot_size(table, beam_voltage_kv, beam_current_pa, interpolate=interpolate)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/milling-depth")
async def get_processing_milling_depth(beam_current_pa: float = Query(..., ge=0), exposure_time_s: float = Query(..., ge=0),
                                      area_um2: float = Query(..., gt=0), removal_rate_um3_per_nc: float = Query(..., gt=0)):
    try:
        return lens_lookup.estimate_milling_depth(beam_current_pa, exposure_time_s, area_um2, removal_rate_um3_per_nc)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc




@router.get("/recipes/{equipment_id}/{pattern_key}")
async def get_processing_recipes(equipment_id: int = Path(..., gt=0), pattern_key: str = Path(..., pattern=r"^[A-Za-z][A-Za-z0-9_-]{0,99}$")):
    try:
        return await pattern_recipes.load_pattern_recipes(equipment_id, pattern_key)
    except pattern_recipes.RecipeUnavailable as exc:
        raise HTTPException(exc.status, str(exc)) from exc
