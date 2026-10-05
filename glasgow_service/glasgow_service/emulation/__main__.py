"""Command-line front end for the vacuum-controller emulator.

Examples::

    python -m glasgow_service.emulation boot                # boot log + pinout
    python -m glasgow_service.emulation i2cdetect           # what `i2cdetect -y 1` shows
    python -m glasgow_service.emulation commission          # WIRING.md step 12 replay
    python -m glasgow_service.emulation pumpdown --minutes 10
    python -m glasgow_service.emulation --model 5 commission
"""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from .raspberry_pi import PiSpec
from .rig import VacuumRig

EXAMPLE_CONFIG = (Path(__file__).resolve().parents[3] / "GlasgowDataIO" / "Json" /
                  "vacuumSystem.rpi5-io.example.json")


def make_spec(model: str) -> PiSpec:
    if model == "5":
        return PiSpec(model="5", ram_gb=4, psu_amps=5.0, m2_hat=True, nvme=True,
                      usb_ssd=False, boot_order=0xF416)
    return PiSpec(model="4B", boot_order=0xF14)


def load_config(path: Path | None, model: str):
    from ..vacuum import VacuumConfig

    payload = json.loads((path or EXAMPLE_CONFIG).read_text())
    payload["Simulate"] = False
    payload.setdefault("SBC", {})["PiModel"] = model
    return VacuumConfig.model_validate(payload)


def cmd_boot(args) -> None:
    rig = VacuumRig(spec=make_spec(args.model), boot=False)
    rig.pi.power_on()
    rig.advance(rig.pi.spec.bootloader_seconds + rig.pi.spec.kernel_seconds + 0.5)
    print("\n".join(rig.pi.boot_log))
    print()
    print(rig.pi.pinout())


def cmd_i2cdetect(args) -> None:
    rig = VacuumRig(spec=make_spec(args.model))
    print("Service not running (IO_RESET_N low, expanders held in reset):")
    print(rig.pi.i2cdetect())
    rig.gpio_hal().setup_output(22, True)
    print("\nService running (GPIO22 high):")
    print(rig.pi.i2cdetect())


async def _commission(args) -> None:
    from ..vacuum import VacuumController

    rig = VacuumRig(spec=make_spec(args.model), tool_connected=False)
    controller = VacuumController(load_config(args.config, args.model), emulator=rig)

    async def settle(n=3):
        for _ in range(n):
            await controller.poll_once()
            rig.advance(0.2)

    def row(step: str) -> None:
        status = controller.status()
        alarm = f"  alarms={status.alarms}" if status.alarms else ""
        print(f"{step:<38} {rig.board.led_panel()}{alarm}")

    print(f"Commissioning replay on {rig.pi.profile.name} (WIRING.md step 12), tool unplugged\n")
    row("1-2 24 V + E-stop, service stopped")
    for di in (5, 6, 7, 8):
        rig.jumper(di)
    await controller.start()
    await settle()
    row("3 service started (+ J32 fault jumpers)")
    rig.jumper(1)
    await settle()
    row("4 jumper DI1")
    rig.jumper(2)
    await settle()
    row("5 jumper DI2")
    rig.jumper(3)
    rig.jumper(4)
    await settle()
    await controller.set_high_voltage_power(True)
    await settle(1)
    row("6 jumper DI3+DI4, HV permissive on")
    rig.jumper(2, False)
    await settle()
    row("7 remove DI2")
    rig.set_estop(True)
    rig.advance(0.05)
    await settle()
    row("8 open E-stop")
    rig.set_estop(False)
    rig.advance(0.05)
    await settle()
    row("8b close E-stop (nothing restarts)")
    await controller.resume_cascade()
    await settle()
    row("8c operator resume")
    await controller.close()
    rig.advance(0.15)
    row("9 service stopped")


async def _pumpdown(args) -> None:
    from ..vacuum import VacuumController

    rig = VacuumRig(spec=make_spec(args.model))
    config = load_config(args.config, args.model)
    if args.gauge_interlock:
        for gauge in config.sbc.gauges.values():
            gauge.interlock = True
    controller = VacuumController(config, emulator=rig)
    await controller.start()
    total = int(args.minutes * 60)
    for second in range(total + 1):
        await controller.poll_once()
        if second % args.every == 0:
            status = controller.status()
            cells = []
            for pump in status.pumps:
                value = "   n/a  " if pump.value is None else f"{pump.value:8.1e}"
                flag = "R" if pump.ready else ("+" if pump.power else "-")
                cells.append(f"{pump.name[:14]:>14}{flag} {value}")
            ready = " READY" if controller.isVacuumSystemReady else ""
            print(f"t={second:5d}s " + " | ".join(cells) + ready)
        rig.advance(1.0)
    await controller.close()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m glasgow_service.emulation",
                                     description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", choices=["4B", "5"], default="4B",
                        help="Raspberry Pi model to emulate (default: 4B)")
    parser.add_argument("--config", type=Path, default=None,
                        help="vacuumSystem.json with an SBC.Board section")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("boot", help="power on and print the boot log and header pinout")
    sub.add_parser("i2cdetect", help="show the board's I2C devices")
    sub.add_parser("commission", help="replay the WIRING.md commissioning table")
    pd = sub.add_parser("pumpdown", help="run the controller against the DB235 plant")
    pd.add_argument("--minutes", type=float, default=10.0)
    pd.add_argument("--every", type=int, default=30, help="print interval, seconds")
    pd.add_argument("--gauge-interlock", action="store_true",
                    help="also require each gauge below its threshold")
    args = parser.parse_args(argv)
    if args.command == "boot":
        cmd_boot(args)
    elif args.command == "i2cdetect":
        cmd_i2cdetect(args)
    elif args.command == "commission":
        asyncio.run(_commission(args))
    else:
        asyncio.run(_pumpdown(args))


if __name__ == "__main__":
    main()
