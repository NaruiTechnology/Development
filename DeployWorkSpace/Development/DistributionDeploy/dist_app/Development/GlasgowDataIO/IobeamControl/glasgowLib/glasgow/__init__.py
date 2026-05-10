"""Compatibility package for the cloned Glasgow source tree.

The Iobeam code imports Glasgow through
``GlasgowDataIO.IobeamControl.glasgowLib.glasgow``. The deploy workflow clones
Glasgow beside ``Development`` instead of vendoring it here, so expose that
package path under the legacy import name.
"""
from pathlib import Path
import sys

_deploy_root = Path(__file__).resolve().parents[5]
_glasgow_software = _deploy_root / "glasgow" / "software"
_glasgow_pkg = _glasgow_software / "glasgow"
_pipx_site = (Path.home() / ".local" / "share" / "pipx" / "venvs" /
              "glasgow" / "lib" / "python3.13" / "site-packages")

_local_pkg = Path(__file__).resolve().parent
__path__ = [str(_local_pkg)]
if _glasgow_pkg.is_dir():
    __path__.append(str(_glasgow_pkg))
if _pipx_site.is_dir() and str(_pipx_site) not in sys.path:
    sys.path.insert(0, str(_pipx_site))
if _glasgow_pkg.is_dir() and str(_glasgow_software) not in sys.path:
    sys.path.insert(0, str(_glasgow_software))

