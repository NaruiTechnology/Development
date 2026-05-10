from pathlib import Path

_deploy_root = Path(__file__).resolve().parents[6]
_glasgow_hardware = _deploy_root / "glasgow" / "software" / "glasgow" / "hardware"

__path__ = [str(Path(__file__).resolve().parent)]
if _glasgow_hardware.is_dir():
    __path__.append(str(_glasgow_hardware))

