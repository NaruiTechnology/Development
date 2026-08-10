"""REST interface for the dedicated second-Glasgow sample stage."""
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .sample_stage import SampleStageController, load_stage_config


class MoveRequest(BaseModel):
    x: float
    y: float


holder = {}


@asynccontextmanager
async def lifespan(_app):
    config = load_stage_config()
    if not config.enabled:
        raise RuntimeError("sample-stage controller is disabled")
    controller = SampleStageController(config)
    await controller.start()
    holder["controller"] = controller
    try:
        yield
    finally:
        await controller.close()
        holder.clear()


app = FastAPI(title="Second Glasgow Sample Stage Controller", lifespan=lifespan)


def controller():
    target = holder.get("controller")
    if target is None:
        raise HTTPException(503, "sample-stage controller is starting")
    return target


@app.get("/status")
async def status():
    return controller().status()


@app.get("/stage")
async def stage_status():
    return controller().status()


@app.post("/stage/move")
async def move(req: MoveRequest):
    try:
        return await controller().move_absolute(req.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
