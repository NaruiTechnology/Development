import asyncio
import GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.demultiplexer as glasgow_access
glasgow_access._xfers_per_queue = 16
glasgow_access._packets_per_xfer = 128

class IobeamDemux(glasgow_access.DirectDemultiplexer):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
    async def claim_interface(self, applet, mux_interface, *args, **kwargs):
        iface = await super().claim_interface(applet, mux_interface, *args, **kwargs)
        
class IobeamDemuxInterface(glasgow_access.DirectDemultiplexerInterface):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
    async def _in_task(self):
        if self._read_buffer_size is not None:
            await asyncio.sleep(0)
        await super()._in_task()
    async def reset(self):
        await super().reset()        