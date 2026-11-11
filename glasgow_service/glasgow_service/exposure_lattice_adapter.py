"""Bridge between the API models (models.py) and the dependency-free lattice generator."""
from __future__ import annotations

from .exposure_lattice import Ellipse, Polygon, Rect, build_lattice


def shape_from_request(shape):
    kind = shape.kind
    if kind == "rect":
        x0, x1 = sorted((shape.x0, shape.x1))
        y0, y1 = sorted((shape.y0, shape.y1))
        return Rect(x0, x1, y0, y1)
    if kind == "ellipse":
        if (shape.inner_rx > 0) != (shape.inner_ry > 0):
            raise ValueError("ring needs both inner_rx and inner_ry")
        if shape.inner_rx >= shape.rx or shape.inner_ry >= shape.ry:
            raise ValueError("ring inner radii must be smaller than the outer radii")
        return Ellipse(shape.cx, shape.cy, shape.rx, shape.ry, shape.inner_rx, shape.inner_ry)
    return Polygon(tuple((float(x), float(y)) for x, y in shape.points))


def lattice_stream(req):
    """(points_factory, pass_pixels) for a pattern=lattice request. The factory returns a fresh lazy iterator."""
    from .exposure_lattice import lattice_points, total_points
    spec = req.lattice
    shape = shape_from_request(spec.shape)
    lattice = build_lattice(shape, spec.pitch_x, spec.pitch_y, spec.axis)
    end = spec.cell_end if spec.cell_end is not None else lattice.nx * lattice.ny
    count = (end - spec.cell_start) * spec.passes if spec.cell_start or spec.cell_end is not None else total_points(shape, lattice, spec.passes)
    return (lambda: lattice_points(shape, lattice, spec.dwell, spec.passes, spec.cell_start, spec.cell_end),
            max(1, count))
