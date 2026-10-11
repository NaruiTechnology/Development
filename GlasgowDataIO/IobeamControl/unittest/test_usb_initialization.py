from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from GlasgowDataIO.IobeamControl import IobeamLauncher as launcher_module
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware import demultiplexer
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.device import ST_FPGA_RDY


def test_windows_reuses_active_configuration_for_one_pipe():
    configs = [SimpleNamespace(getConfigurationValue=lambda: 1, getNumInterfaces=lambda: 4),
               SimpleNamespace(getConfigurationValue=lambda: 2, getNumInterfaces=lambda: 2)]
    handle = Mock()
    handle.getConfiguration.return_value = 1
    handle.getDevice.return_value.iterConfigurations.return_value = configs
    with patch.object(demultiplexer.sys, 'platform', 'win32'):
        demultiplexer.DirectDemultiplexer(SimpleNamespace(usb_handle=handle), 1)
    handle.setConfiguration.assert_not_called()
    handle.releaseInterface.assert_not_called()


def test_configuration_selected_before_fpga_programming():
    import asyncio
    events = []
    device = Mock(revision='C3')
    async def program(*args, **kwargs):
        events.append('program')
        return False
    device.download_target = AsyncMock(side_effect=program)
    device._status = AsyncMock(return_value=ST_FPGA_RDY)
    mux = Mock()
    iface = SimpleNamespace(_activate=AsyncMock())
    async def claim(*args, **kwargs):
        assert kwargs['activate'] is False
        events.append('io setup')
        return iface
    mux.claim_interface = AsyncMock(side_effect=claim)
    mux._check_fpga_ready = AsyncMock()
    def configure(*args):
        events.append('configure')
        return mux
    plan = SimpleNamespace(bitstream_id=b'x' * 16, buildDir=None)
    target = Mock()
    target.build_plan.return_value = plan
    target.multiplexer.pipe_count = 1
    launcher = object.__new__(launcher_module.IobeamLauncher)
    launcher._logger = Mock()
    args = SimpleNamespace(buffer_size=1024)
    with patch.object(launcher_module, 'GlasgowDevice', return_value=device), \
         patch.object(launcher_module, 'GlasgowHardwareTarget', return_value=target), \
         patch.object(launcher_module, 'DirectDemultiplexer', side_effect=configure):
        result = asyncio.run(launcher._launch_applet(Mock(), args))
    assert events == ['configure', 'io setup', 'program']
    assert result == (iface, False)
    iface._activate.assert_awaited_once()
