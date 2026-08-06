"""Gateware for atomic vacuum output control and comparator readback."""

from amaranth import Cat, Elaboratable, Module, Signal
from amaranth.lib import cdc, enum, io


class VacuumControlSubtarget(Elaboratable):
    class Command(enum.Enum):
        SetOutputs = 0x01  # payload: one Port A channel mask
        ReadStatus = 0x02  # response: Status, Port A mask, Port B mask
        ConfigureTarget = 0x03  # payload: channel, target u32, tolerance u32

    STATUS_TAG = 0x80

    def __init__(self, ports, out_fifo, in_fifo, channel_count: int):
        if not 1 <= int(channel_count) <= 8:
            raise ValueError("vacuum channel_count must be in the range 1..8")
        self.ports = ports
        self.out_fifo = out_fifo
        self.in_fifo = in_fifo
        self.channel_count = int(channel_count)
        self.output_mask = Signal(self.channel_count, reset=0)
        self.input_mask = Signal(self.channel_count)
        self.target_codes = [Signal(32, name=f"target_{index}") for index in range(self.channel_count)]
        self.tolerance_codes = [
            Signal(32, name=f"tolerance_{index}") for index in range(self.channel_count)
        ]

    def elaborate(self, platform):
        m = Module()

        m.submodules.port_a = port_a = io.Buffer("o", self.ports.port_a)
        m.submodules.port_b = port_b = io.Buffer("i", self.ports.port_b)
        m.submodules.port_b_sync = cdc.FFSynchronizer(port_b.i, self.input_mask)
        m.d.comb += port_a.o.eq(self.output_mask)

        status_outputs = Signal(self.channel_count)
        status_inputs = Signal(self.channel_count)
        config_channel = Signal(range(self.channel_count))
        config_index = Signal(3)
        config_payload = Signal(64)

        m.d.comb += [
            self.out_fifo.r_en.eq(0),
            self.in_fifo.w_en.eq(0),
            self.in_fifo.w_data.eq(0),
        ]

        with m.FSM(name="vacuum_control"):
            with m.State("ReadCommand"):
                m.d.comb += self.out_fifo.r_en.eq(1)
                with m.If(self.out_fifo.r_rdy):
                    with m.Switch(self.out_fifo.r_data):
                        with m.Case(self.Command.SetOutputs):
                            m.next = "ReadOutputMask"
                        with m.Case(self.Command.ReadStatus):
                            m.d.sync += [
                                status_outputs.eq(self.output_mask),
                                status_inputs.eq(self.input_mask),
                            ]
                            m.next = "SendStatusTag"
                        with m.Case(self.Command.ConfigureTarget):
                            m.next = "ReadConfigChannel"

            with m.State("ReadOutputMask"):
                m.d.comb += self.out_fifo.r_en.eq(1)
                with m.If(self.out_fifo.r_rdy):
                    m.d.sync += self.output_mask.eq(self.out_fifo.r_data)
                    m.next = "ReadCommand"

            with m.State("ReadConfigChannel"):
                m.d.comb += self.out_fifo.r_en.eq(1)
                with m.If(self.out_fifo.r_rdy):
                    with m.If(self.out_fifo.r_data < self.channel_count):
                        m.d.sync += [
                            config_channel.eq(self.out_fifo.r_data),
                            config_index.eq(0),
                            config_payload.eq(0),
                        ]
                        m.next = "ReadConfigPayload"
                    with m.Else():
                        m.next = "ReadCommand"

            with m.State("ReadConfigPayload"):
                m.d.comb += self.out_fifo.r_en.eq(1)
                with m.If(self.out_fifo.r_rdy):
                    m.d.sync += config_payload.word_select(config_index, 8).eq(
                        self.out_fifo.r_data
                    )
                    with m.If(config_index == 7):
                        with m.Switch(config_channel):
                            for channel in range(self.channel_count):
                                with m.Case(channel):
                                    m.d.sync += [
                                        self.target_codes[channel].eq(config_payload[:32]),
                                        self.tolerance_codes[channel].eq(
                                            Cat(config_payload[32:56], self.out_fifo.r_data)
                                        ),
                                    ]
                        m.next = "ReadCommand"
                    with m.Else():
                        m.d.sync += config_index.eq(config_index + 1)

            with m.State("SendStatusTag"):
                m.d.comb += [
                    self.in_fifo.w_en.eq(1),
                    self.in_fifo.w_data.eq(self.STATUS_TAG),
                ]
                with m.If(self.in_fifo.w_rdy):
                    m.next = "SendOutputMask"

            with m.State("SendOutputMask"):
                m.d.comb += [
                    self.in_fifo.w_en.eq(1),
                    self.in_fifo.w_data.eq(status_outputs),
                ]
                with m.If(self.in_fifo.w_rdy):
                    m.next = "SendInputMask"

            with m.State("SendInputMask"):
                m.d.comb += [
                    self.in_fifo.w_en.eq(1),
                    self.in_fifo.w_data.eq(status_inputs),
                ]
                with m.If(self.in_fifo.w_rdy):
                    m.next = "ReadCommand"

        return m
