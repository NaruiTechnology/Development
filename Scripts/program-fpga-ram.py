#!/usr/bin/env python3
"""Load the deployed scan design into Glasgow FPGA RAM without starting a scan."""
import argparse
import asyncio
import hashlib
import json
import logging
import sys
from pathlib import Path
from types import SimpleNamespace


async def download_and_verify(device, plan, reset_address, ready_mask):
    """Always replace RAM, including when the reported ID already matches."""
    if not await device.download_target(plan, reload=True):
        raise RuntimeError("FPGA RAM download did not program an image")
    running_id = await device.bitstream_id()
    if running_id != plan.bitstream_id:
        raise RuntimeError("FPGA image ID mismatch: expected {}, got {}".format(
            plan.bitstream_id.hex(), running_id.hex() if running_id else "none"))
    for _ in range(50):
        status = await device._status()
        if status & ready_mask:
            break
        await asyncio.sleep(0.1)
    else:
        raise RuntimeError("FPGA not ready after RAM download: status={:#04x}".format(status))
    # Leave the scan run gate closed. The runtime launcher opens it on demand.
    await device.write_register(reset_address, 0)
    if await device.read_register(reset_address) != 0:
        raise RuntimeError("FPGA scan run gate did not remain closed")
    return status


async def program(config_path):
    development = Path(__file__).resolve().parents[1]
    # The installer invokes Python with -I. Import only the newly extracted
    # application, never another editable checkout inherited through PYTHONPATH.
    sys.path.insert(0, str(development))
    from AutomationPy.buildingblocks.automation_config import AutomationConfig
    from AutomationPy.buildingblocks.definitions import Consts
    from AutomationPy.buildingblocks.utils import GetStateConfigByName
    from GlasgowDataIO.IobeamControl.applet.DataStreamApplet import DataStreamApplet
    from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.abstract import GlasgowPin
    from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.device import GlasgowDevice, ST_FPGA_RDY
    from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.target import GlasgowHardwareTarget
    from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.multiplexer import DirectMultiplexer

    config = AutomationConfig(str(config_path))
    action = GetStateConfigByName(config, Consts.STREAM_DATA)[Consts.ACTION_DATA]
    voltage = action.get("voltage", 2.5)
    pins = ["{}{}".format(p["port"], n) for p in action.get("ports", []) for n in p.get("pinList", [])]
    args = SimpleNamespace(voltage_map={"A": voltage, "B": voltage},
                           pins=GlasgowPin.parse(",".join(pins)) if pins else [],
                           buffer_size=1048576, sample_rate=1000000)
    device = GlasgowDevice(config.Glasgow.get("DeviceId"))
    try:
        applet = DataStreamApplet(config)
        target = GlasgowHardwareTarget(revision=device.revision, multiplexer_cls=DirectMultiplexer)
        applet.build(target, args)
        plan = target.build_plan()
        print("FPGA RAM download: source={} config={} expected_id={} production={}".format(
            development, config_path, plan.bitstream_id.hex(), config.IsProduction), flush=True)
        status = await download_and_verify(device, plan, applet.addr_reset, ST_FPGA_RDY)
        receipt = {"bitstream_id": plan.bitstream_id.hex(), "status": status,
                   "config": str(config_path), "source": str(development),
                   "config_sha256": hashlib.sha256(config_path.read_bytes()).hexdigest(),
                   "serial": device.serial, "scan_started": False}
        receipt_path = development.parent / "fpga-ram-verification.json"
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
        print("FPGA RAM VERIFIED: id={} status={:#04x} receipt={}".format(
            plan.bitstream_id.hex(), status, receipt_path), flush=True)
    finally:
        device.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    options = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    asyncio.run(program(options.config.resolve()))
