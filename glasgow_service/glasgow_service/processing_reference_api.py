"""Reference-only Processing API, independently testable without a device service."""
import asyncio
from fastapi import APIRouter, Depends, HTTPException, Query
from . import lens_lookup
from .auth import require_token

router = APIRouter(prefix="/processing", tags=["processing"], dependencies=[Depends(require_token)])

# Reference-only calculations: these endpoints never acquire or expose a beam.
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


