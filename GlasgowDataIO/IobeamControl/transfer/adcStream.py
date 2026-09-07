"""Host connection for the isolated ADC data stream."""

import gc

from ..AdcLauncher import AdcLauncher


class AdcConnection:
    def __init__(self, config, *, duration_minutes=5, simulation=False, seed=1,
                 chunk_bytes=65536, duration_cycles=None):
        self._config = config
        self.duration_minutes = int(duration_minutes)
        self.simulation = bool(simulation)
        self.seed = int(seed)
        self.chunk_bytes = max(2, int(chunk_bytes)) & ~1
        self.duration_cycles = duration_cycles
        self.iface = None

    @property
    def connected(self):
        return self.iface is not None

    async def connect(self):
        launcher = AdcLauncher(
            self._config,
            duration_minutes=self.duration_minutes,
            simulation=self.simulation,
            seed=self.seed,
            duration_cycles=self.duration_cycles,
        )
        self.iface = await launcher.start()

    async def chunks(self):
        if self.iface is None:
            await self.connect()
        while True:
            data = bytes(await self.iface.read(self.chunk_bytes))
            marker = _aligned_sentinel(data)
            if marker is not None:
                if marker:
                    yield data[:marker]
                return
            yield data

    async def close(self):
        iface, self.iface = self.iface, None
        if iface is None:
            return
        try:
            await iface.device.write_register(iface.adc_capture_enable_addr, 0)
        finally:
            try:
                await iface.cancel()
            finally:
                iface.device.close()
                gc.collect()


def _aligned_sentinel(data):
    for index in range(0, len(data) - 1, 2):
        if data[index:index + 2] == b"\xff\xff":
            return index
    return None

