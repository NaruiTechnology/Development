"""Document the service boundary for dwell.

The UI dwell is passed to the gateware unchanged: ``dwell_time = dwell``. The
gateware emits dwell_time + 1 conversions (see
GlasgowDataIO/IobeamControl/unittest/applet/test_dwellSemantics.py), so a UI
dwell of N takes N + 1 conversions. Upstream OBI's GUI sends ``dwell - 1``
instead. If the service is changed to adopt that convention, update this test
deliberately together with the frontend timing model and help text.
"""
from pathlib import Path

from glasgow_service.models import RasterRequest
from glasgow_service.service import DeviceService

CONFIG_PATH = Path(__file__).parents[2] / "GlasgowDataIO" / "Json" / "streamData.json"


def test_ui_dwell_is_sent_to_the_gateware_unchanged():
    service = DeviceService(str(CONFIG_PATH))
    for dwell in (1, 2, 8, 16):
        command = service._build_raster_cmd(RasterRequest(resolution=256, dwell=dwell))
        assert command._dwell == dwell
