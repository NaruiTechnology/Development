from typing import List, Tuple
from beam_scan_controller import ScanPoint

def generate_raster_pattern(
    x_range: Tuple[float, float],
    y_range: Tuple[float, float],
    step: float,
    eV: float,
    z_value: float
) -> List[ScanPoint]:
    pattern = []
    x_min, x_max = x_range
    y_min, y_max = y_range

    y = y_min
    while y <= y_max:
        row = []
        x = x_min
        while x <= x_max:
            row.append(ScanPoint(electron_volts=eV, z_value=z_value, xy_position=(x, y)))
            x += step
        if int((y - y_min) / step) % 2 == 1:
            row.reverse()  # serpentine scan
        pattern.extend(row)
        y += step

    return pattern
