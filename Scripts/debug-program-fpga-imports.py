#!/usr/bin/env python3
"""Diagnostic launcher: verifies imports used by program-fpga-ram.py.

Run from the repo root; it adds `Development` to PYTHONPATH and reports
which import (if any) fails with a full traceback.
"""
import sys
from pathlib import Path
import importlib
import traceback

repo_root = Path(__file__).resolve().parents[2]
dev_path = repo_root / 'Development'
sys.path.insert(0, str(dev_path))
print('Added to sys.path:', dev_path)

imports = [
    'AutomationPy.buildingblocks.automation_config',
    'AutomationPy.buildingblocks.definitions',
    'AutomationPy.buildingblocks.utils',
    'GlasgowDataIO.IobeamControl.applet.DataStreamApplet',
    'GlasgowDataIO.IobeamControl.glasgowLib.glasgow.abstract',
    'GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.device',
    'GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.target',
    'GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.multiplexer',
]

ok = True
for name in imports:
    try:
        print('\nImporting', name)
        module = importlib.import_module(name)
        print(' -> OK (', getattr(module, '__name__', name), ')')
    except Exception:
        ok = False
        print(' -> FAILED:')
        traceback.print_exc()

if ok:
    print('\nAll imports succeeded')
else:
    print('\nOne or more imports failed; see tracebacks above')
