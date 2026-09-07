import unittest
from types import SimpleNamespace

from amaranth import Module, Signal
from amaranth.sim import Simulator

from GlasgowDataIO.IobeamControl.applet.AdcDataStreamApplet import (
    AdcDataSubtarget,
    build_adc_resources,
)


class AdcDataStreamAppletTest(unittest.TestCase):
    def test_resources_exclude_every_dac_signal_and_force_input_data(self):
        resources = build_adc_resources({
            "control": {
                "subsignals": [
                    {"name": "adc_clk", "pin": "A1"},
                    {"name": "adc_le_clk", "pin": "A2"},
                    {"name": "adc_oe", "pin": "A3", "invert": True},
                    {"name": "dac_clk", "pin": "A4"},
                    {"name": "dac_x_le_clk", "pin": "A5"},
                    {"name": "dac_y_le_clk", "pin": "A6"},
                ],
            },
            "data": {"pins": "B1 B2", "direction": "io"},
        })
        adc_control = next(resource for resource in resources if resource.name == "adc_control")
        names = {io.name for io in adc_control.ios}
        self.assertEqual(names, {"adc_clk", "adc_le_clk", "adc_oe"})
        self.assertFalse(any(name.startswith("dac") for name in names))
        adc_data = next(resource for resource in resources if resource.name == "adc_data")
        self.assertEqual(adc_data.ios[0].dir, "i")

    def test_oe_is_continuous_until_hardware_timeout_then_released(self):
        fifo = SimpleNamespace(
            w_en=Signal(), w_data=Signal(8), w_rdy=Signal(reset=1),
        )
        enable = Signal()
        status = Signal(8)
        dut = AdcDataSubtarget(
            in_fifo=fifo,
            capture_enable=enable,
            capture_status=status,
            simulation=True,
            seed=42,
            adc_half_period=3,
            adc_settle_cycles=1,
            duration_cycles=18,
        )
        m = Module()
        m.submodules.dut = dut
        sim = Simulator(m)
        sim.add_clock(1e-6)

        async def bench(ctx):
            ctx.set(enable, 0)
            await ctx.tick()
            self.assertEqual(ctx.get(dut.adc_oe), 0)
            ctx.set(enable, 1)
            await ctx.tick()
            observed = []
            for _ in range(18):
                observed.append(ctx.get(dut.adc_oe))
                await ctx.tick()
            self.assertTrue(all(observed), observed)
            await ctx.tick()
            self.assertEqual(ctx.get(dut.adc_oe), 0)
            self.assertEqual(ctx.get(dut.complete), 1)

        sim.add_testbench(bench)
        sim.run()


if __name__ == "__main__":
    unittest.main()

