"""Host-side TMC5160 SPI register and motion interface."""
import logging


class TMC5160Register:
    GCONF = 0x00
    GSTAT = 0x01
    IHOLD_IRUN = 0x10
    RAMPMODE = 0x20
    XACTUAL = 0x21
    VSTART = 0x23
    A1 = 0x24
    V1 = 0x25
    AMAX = 0x26
    VMAX = 0x27
    DMAX = 0x28
    D1 = 0x2A
    VSTOP = 0x2B
    TZEROWAIT = 0x2C
    XTARGET = 0x2D
    SW_MODE = 0x34
    RAMP_STAT = 0x35
    ENCMODE = 0x38
    X_ENC = 0x39
    ENC_CONST = 0x3A
    CHOPCONF = 0x6C
    COOLCONF = 0x6D
    DRV_STATUS = 0x6F
    PWMCONF = 0x70


REGISTER_NAMES = {
    name: value for name, value in vars(TMC5160Register).items()
    if name.isupper() and isinstance(value, int)
}


class TMC5160Interface:
    def __init__(self, spi, logger=None):
        self.spi = spi
        self._logger = logger or logging.getLogger(__name__)
        self.last_spi_status = 0

    async def _exchange(self, address, value=0, *, write=False):
        address = int(address) & 0x7f
        if write:
            address |= 0x80
        frame = bytes([address]) + (int(value) & 0xffffffff).to_bytes(4, "big")
        async with self.spi.select():
            reply = bytes(await self.spi.exchange(frame))
        if len(reply) != 5:
            raise RuntimeError(f"TMC5160 returned {len(reply)} bytes; expected 5")
        self.last_spi_status = reply[0]
        return int.from_bytes(reply[1:], "big")

    async def write_register(self, address, value):
        await self._exchange(address, value, write=True)

    async def read_register(self, address, *, signed=False):
        # TMC5160 read data is returned by the following 40-bit transaction.
        await self._exchange(address)
        value = await self._exchange(address)
        if signed and value & 0x80000000:
            value -= 1 << 32
        return value

    async def initialize(self, register_writes):
        for address, value in register_writes:
            await self.write_register(address, value)

    async def move_to(self, microsteps):
        await self.write_register(TMC5160Register.RAMPMODE, 0)
        await self.write_register(TMC5160Register.XTARGET, microsteps)

    async def read_position(self):
        return await self.read_register(TMC5160Register.XACTUAL, signed=True)

    async def read_motion_status(self):
        ramp = await self.read_register(TMC5160Register.RAMP_STAT)
        driver = await self.read_register(TMC5160Register.DRV_STATUS)
        return {
            "spi_status": self.last_spi_status,
            "ramp_stat": ramp,
            "driver_status": driver,
            "position_reached": bool(ramp & (1 << 9)),
            "standstill": bool(driver & (1 << 31)),
            "driver_error": bool(self.last_spi_status & (1 << 1)),
        }
