"""Beam-spot lattice generation for pattern exposure, in DAC-code space.

Mirrors ionbeam-web/frontend/src/lib/exposurePlan.ts (latticeSpec / latticeCells /
countSpots). The client chooses the physical pitch (spot size, overlap, field width);
this module turns shape + pitch into a lazy, serpentine stream of (x, y, dwell, blank,
pass) points. Nothing here materialises the full point list, so patterns of millions of
spots cost O(1) memory. No pydantic or hardware imports: pure Python.
"""
from __future__ import annotations

import math
from functools import lru_cache
from dataclasses import dataclass
from typing import Iterator, Optional, Sequence, Tuple

DAC_MAX = 16383
#: Sanity bound on total streamed points (count * passes); rejects pitch typos, not a hardware limit.
MAX_LATTICE_POINTS = 200_000_000
#: Lattice cells walked for an exact count before falling back to area / pitch^2.
MAX_COUNT_CELLS = 4_000_000


def _round_half_up(value: float) -> int:
    """JavaScript Math.round semantics, so client and service agree on the cell count."""
    return math.floor(value + 0.5)


@dataclass(frozen=True)
class Rect:
    x0: float
    x1: float
    y0: float
    y1: float

    def bounds(self) -> Tuple[float, float, float, float]:
        return (self.x0, self.x1, self.y0, self.y1)

    def contains(self, x: float, y: float) -> bool:
        return self.x0 <= x <= self.x1 and self.y0 <= y <= self.y1

    def area(self) -> float:
        return (self.x1 - self.x0) * (self.y1 - self.y0)


@dataclass(frozen=True)
class Ellipse:
    """Solid ellipse, or an elliptical ring when inner radii are given."""
    cx: float
    cy: float
    rx: float
    ry: float
    inner_rx: float = 0.0
    inner_ry: float = 0.0

    def bounds(self) -> Tuple[float, float, float, float]:
        return (self.cx - self.rx, self.cx + self.rx, self.cy - self.ry, self.cy + self.ry)

    def contains(self, x: float, y: float) -> bool:
        outer = ((x - self.cx) / self.rx) ** 2 + ((y - self.cy) / self.ry) ** 2
        if outer > 1.0:
            return False
        if self.inner_rx <= 0 or self.inner_ry <= 0:
            return True
        return ((x - self.cx) / self.inner_rx) ** 2 + ((y - self.cy) / self.inner_ry) ** 2 >= 1.0

    def area(self) -> float:
        return math.pi * (self.rx * self.ry - self.inner_rx * self.inner_ry)


@dataclass(frozen=True)
class Polygon:
    points: Tuple[Tuple[float, float], ...]

    def bounds(self) -> Tuple[float, float, float, float]:
        xs = [p[0] for p in self.points]
        ys = [p[1] for p in self.points]
        return (min(xs), max(xs), min(ys), max(ys))

    def contains(self, x: float, y: float) -> bool:
        inside = False
        pts = self.points
        j = len(pts) - 1
        for i in range(len(pts)):
            xi, yi = pts[i]
            xj, yj = pts[j]
            dx, dy = xj - xi, yj - yi
            if (abs(dx * (y - yi) - dy * (x - xi)) <= 1e-10 * max(1.0, math.hypot(dx, dy))
                    and min(xi, xj) <= x <= max(xi, xj) and min(yi, yj) <= y <= max(yi, yj)):
                return True  # on an edge counts as inside
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
        return inside

    def area(self) -> float:
        s = 0.0
        for i, (x0, y0) in enumerate(self.points):
            x1, y1 = self.points[(i + 1) % len(self.points)]
            s += x0 * y1 - x1 * y0
        return abs(s) / 2


@dataclass(frozen=True)
class Frame:
    outer: Polygon
    inner: Polygon

    def bounds(self) -> Tuple[float, float, float, float]:
        return self.outer.bounds()

    def contains(self, x: float, y: float) -> bool:
        return self.outer.contains(x, y) and not self.inner.contains(x, y)

    def area(self) -> float:
        return max(0.0, self.outer.area() - self.inner.area())


@dataclass(frozen=True)
class Lattice:
    nx: int
    ny: int
    pitch_x: float
    pitch_y: float
    x0: float
    y0: float
    axis: str  # "x" or "y": the fast (inner) axis

    def centre(self, i: int, j: int) -> Tuple[float, float]:
        return (self.x0 + (i + 0.5) * self.pitch_x, self.y0 + (j + 0.5) * self.pitch_y)

    def cells(self, start: int = 0, end: Optional[int] = None) -> Iterator[Tuple[int, int]]:
        """Serpentine order from the high-Y edge, with the fast axis reversing per row."""
        fast, slow = (self.nx, self.ny) if self.axis == "x" else (self.ny, self.nx)
        end = fast * slow if end is None else min(end, fast * slow)
        for s in range(start // fast, (end + fast - 1) // fast):
            for f in range(max(0, start - s * fast), min(fast, end - s * fast)):
                k = fast - 1 - f if s % 2 else f
                yield (k, self.ny - 1 - s) if self.axis == "x" else (s, self.ny - 1 - k)


def build_lattice(shape, pitch_x: float, pitch_y: Optional[float] = None, axis: str = "long") -> Lattice:
    """Whole number of spots per axis; the pitch is nudged so the bounds are covered evenly.

    Separate X/Y pitches let the client compensate for unequal DAC-code-per-um scales.
    """
    pitch_y = pitch_x if pitch_y is None else pitch_y
    if not (pitch_x > 0 and pitch_y > 0 and math.isfinite(pitch_x) and math.isfinite(pitch_y)):
        raise ValueError("lattice pitch must be positive and finite")
    if axis not in ("long", "x", "y"):
        raise ValueError(f"unknown scan axis {axis!r}")
    x0, x1, y0, y1 = shape.bounds()
    w, h = x1 - x0, y1 - y0
    if not (w > 0 and h > 0):
        raise ValueError("pattern has no area")
    nx = max(1, _round_half_up(w / pitch_x))
    ny = max(1, _round_half_up(h / pitch_y))
    fast = ("x" if w >= h else "y") if axis == "long" else axis
    return Lattice(nx, ny, w / nx, h / ny, x0, y0, fast)


@lru_cache(maxsize=64)
def count_spots(shape, lattice: Lattice) -> Tuple[int, bool]:
    """(spots inside the shape, exact). Large lattices fall back to area / cell area."""
    if lattice.nx * lattice.ny > MAX_COUNT_CELLS:
        return max(1, _round_half_up(shape.area() / (lattice.pitch_x * lattice.pitch_y))), False
    if isinstance(shape, Rect):
        return lattice.nx * lattice.ny, True
    n = 0
    for j in range(lattice.ny):
        for i in range(lattice.nx):
            if shape.contains(*lattice.centre(i, j)):
                n += 1
    return n, True


def spot_centres(shape, lattice: Lattice, start: int = 0, end: Optional[int] = None) -> Iterator[Tuple[float, float]]:
    """Float spot centres inside the shape, in serpentine scan order."""
    rectangular = isinstance(shape, Rect)
    for i, j in lattice.cells(start, end):
        c = lattice.centre(i, j)
        if rectangular or shape.contains(*c):
            yield c


def lattice_points(shape, lattice: Lattice, dwell_ticks: int, passes: int = 1,
                   cell_start: int = 0, cell_end: Optional[int] = None
                   ) -> Iterator[Tuple[int, int, int, bool, int]]:
    """Lazy (x, y, dwell, blank, pass_index) stream, repeated `passes` times.

    Spots landing on the same DAC code are merged within a pass and their dwell summed
    (ticks = conversions - 1, so merged = a + b + 1), preserving delivered charge when the
    pitch is finer than one DAC step. The pass marker is always 1 (the vector protocol only
    accepts 1 or 2; 2 means "skipped" in the gray workflows).
    """
    if not 0 <= dwell_ticks <= 65535:
        raise ValueError("dwell ticks must be 0..65535")
    if passes < 1:
        raise ValueError("passes must be >= 1")
    for _ in range(passes):
        pending: Optional[list] = None
        for cx, cy in spot_centres(shape, lattice, cell_start, cell_end):
            x = min(DAC_MAX, max(0, _round_half_up(cx)))
            y = min(DAC_MAX, max(0, _round_half_up(cy)))
            if (pending is not None and pending[0] == x and pending[1] == y
                    and pending[2] + dwell_ticks + 1 <= 65535):
                pending[2] += dwell_ticks + 1
                continue
            if pending is not None:
                yield (pending[0], pending[1], pending[2], False, 1)
            pending = [x, y, dwell_ticks]
        if pending is not None:
            yield (pending[0], pending[1], pending[2], False, 1)


def total_points(shape, lattice: Lattice, passes: int = 1) -> int:
    """Upper bound of streamed points (merging can only reduce it)."""
    return count_spots(shape, lattice)[0] * passes


def make_shape(kind: str, **kw):
    if kind == "rect":
        return Rect(kw["x0"], kw["x1"], kw["y0"], kw["y1"])
    if kind == "ellipse":
        return Ellipse(kw["cx"], kw["cy"], kw["rx"], kw["ry"], kw.get("inner_rx", 0.0), kw.get("inner_ry", 0.0))
    if kind == "polygon":
        pts: Sequence[Sequence[float]] = kw["points"]
        return Polygon(tuple((float(x), float(y)) for x, y in pts))
    raise ValueError(f"unknown lattice shape {kind!r}")
