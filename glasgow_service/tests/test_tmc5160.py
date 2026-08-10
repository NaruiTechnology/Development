import asyncio
from contextlib import asynccontextmanager

from GlasgowDataIO.IobeamControl.sysControl.stepper.tmc5160Interface import (
    TMC5160Interface,
    TMC5160Register,
)


class FakeSPI:
    def __init__(self, replies):
        self.replies = list(replies)
        self.frames = []

    @asynccontextmanager
    async def select(self):
        yield

    async def exchange(self, frame):
        self.frames.append(bytes(frame))
        return self.replies.pop(0)


def test_tmc5160_write_is_one_40_bit_big_endian_datagram():
    async def scenario():
        spi = FakeSPI([bytes(5)])
        driver = TMC5160Interface(spi)
        await driver.write_register(TMC5160Register.VMAX, 0x00123456)
        assert spi.frames == [bytes.fromhex("a700123456")]

    asyncio.run(scenario())


def test_tmc5160_position_read_uses_pipelined_second_datagram_and_signed_value():
    async def scenario():
        spi = FakeSPI([
            bytes.fromhex("0100000000"),
            bytes.fromhex("20ffffff9c"),
        ])
        driver = TMC5160Interface(spi)
        assert await driver.read_position() == -100
        assert spi.frames == [bytes.fromhex("2100000000")] * 2
        assert driver.last_spi_status == 0x20

    asyncio.run(scenario())
