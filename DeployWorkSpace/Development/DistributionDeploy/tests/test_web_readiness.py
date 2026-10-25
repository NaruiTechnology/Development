import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from workstates.verifyIonbeamWeb_state import verifyIonbeamWeb_state


def test_readiness_includes_api_error():
    state = verifyIonbeamWeb_state.__new__(verifyIonbeamWeb_state)
    check = state._normalizeCheck('http://127.0.0.1:4000/api/admin/iobeam/equipment')
    assert state._checkResponse(check, 500, '{"ok":false,"error":"spawn psql ENOENT"}') == (
        False, 'HTTP 500 - spawn psql ENOENT')
    assert state._checkResponse(check, 500, '<html>failure</html>') == (False, 'HTTP 500')
    assert state._checkResponse(check, 200, '{"ok":true}') == (True, 'HTTP 200')
