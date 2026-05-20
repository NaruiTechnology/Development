"""Glasgow Device Service -- long-lived HTTP/WebSocket interface to one Glasgow device."""
from __future__ import annotations

import sys
from pathlib import Path

# Allow `uvicorn glasgow_service.api:app` from the glasgow_service project
# directory while still resolving sibling repo packages such as GlasgowDataIO
# and AutomationPy.
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

__version__ = "0.1.0"
