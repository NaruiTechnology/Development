"""Hardware emulation for the Raspberry Pi vacuum controller.

Layers (each usable on its own):

* :mod:`.clock`          - deterministic virtual time, optional real-time runner
* :mod:`.raspberry_pi`   - Raspberry Pi 4 Model B / Pi 5 peripheral surface
                           (GPIO, I2C, UARTs, config.txt, boot rules)
* :mod:`.chips`          - register-level MCP23017 and ADS1115
* :mod:`.board`          - RPi5VacuumIO rev A.1 electrical model
* :mod:`.db235`          - FEI DB235 vacuum plant (pumps, gauges, valves)
* :mod:`.rig`            - everything wired together as in WIRING.md

Run ``python -m glasgow_service.emulation --help`` for the CLI.
"""
from .clock import RealtimeRunner, VirtualClock
from .raspberry_pi import MODELS, PiSpec, RaspberryPi
from .rig import VacuumRig

__all__ = ["MODELS", "PiSpec", "RaspberryPi", "RealtimeRunner", "VacuumRig", "VirtualClock"]
