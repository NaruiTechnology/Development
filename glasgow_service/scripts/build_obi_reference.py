"""Build and fingerprint a production scan image offline, without opening USB.

Run with the same Python interpreter as the service. --source-root can point
at an installed bytecode distribution, allowing its netlist to be compared
with this checkout. No configuration files or installed modules are changed.
"""
import argparse
import hashlib
import inspect
import json
import marshal
import math
from pathlib import Path
import sys
from types import SimpleNamespace


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--config", type=Path)
    parser.add_argument("--build-dir", type=Path, required=True)
    args = parser.parse_args()
    root = args.source_root.resolve()
    sys.path.insert(0, str(root))
    from AutomationPy.buildingblocks.automation_config import AutomationConfig
    from AutomationPy.buildingblocks.utils import GetStateConfigByName
    from GlasgowDataIO.IobeamControl.applet.DataStreamApplet import DataStreamApplet
    from GlasgowDataIO.IobeamControl.applet.adcTiming import AdcTiming
    from GlasgowDataIO.IobeamControl.applet.busController import BusController
    from GlasgowDataIO.IobeamControl.applet.commandExecutor import CommandExecutor
    from GlasgowDataIO.IobeamControl.applet.upstreamBusController import UpstreamBusController
    from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.target import GlasgowHardwareTarget
    from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.multiplexer import DirectMultiplexer

    config_path = (args.config or root / "GlasgowDataIO/Json/streamData.json").resolve()
    config = AutomationConfig(str(config_path))
    config.IsProduction = True
    args.build_dir.mkdir(parents=True, exist_ok=True)
    config.LogName = str(args.build_dir.resolve() / "build")
    action = GetStateConfigByName(config, "streamData")["actionData"]
    timing = AdcTiming.from_action(action)
    timing.validate_scan()
    target = GlasgowHardwareTarget("C3", multiplexer_cls=DirectMultiplexer)
    applet = DataStreamApplet(config)
    buffer_size = math.prod(int(part) for part in str(action.get("bufferSize", "1024*1024")).split("*"))
    subtarget = applet.build(target, SimpleNamespace(buffer_size=buffer_size))
    assert not subtarget.loopback and not subtarget.out_only
    plan = target.build_plan()
    bitstream, build_log = plan.execute(build_dir=args.build_dir, debug=True)
    modules = {}
    for cls in (BusController, UpstreamBusController, CommandExecutor):
        modules[cls.__name__] = {
            "loaded_from": inspect.getfile(cls),
            "elaborate_sha256": hashlib.sha256(marshal.dumps(cls.elaborate.__code__)).hexdigest(),
        }
    manifest = {
        "reference_commit": "0f6e62c829dadbde17a8f9b8d27e1ab839c5ba2f",
        "python": sys.executable, "source_root": str(root), "config": str(config_path),
        "production": True, "loopback": False, "out_only": False, "buffer_size": buffer_size,
        "timing": vars(timing), "upstream_sequence": timing.uses_upstream_sequence,
        "pins": action["pins"], "modules": modules,
        "bitstream_id": plan.bitstream_id.hex(),
        "bitstream_sha256": hashlib.sha256(bitstream).hexdigest(),
        "timing_reports": [line for line in build_log.splitlines() if "Max frequency" in line],
    }
    (args.build_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({key: value for key, value in manifest.items() if key not in ("pins", "modules")}, indent=2))


if __name__ == "__main__":
    main()
