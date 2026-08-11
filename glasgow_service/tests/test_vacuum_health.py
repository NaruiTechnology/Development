import pytest

from glasgow_service.vacuum_health import executor_state_is_ready, sbc_controller_is_ready


@pytest.mark.parametrize("state", ["fenced", "faulted", "stopped"])
def test_executor_terminal_or_unsafe_states_are_unready(state):
    assert executor_state_is_ready(state) is False


@pytest.mark.parametrize("state", ["starting", "standby", "active", "draining"])
def test_executor_participating_states_are_ready(state):
    assert executor_state_is_ready(state) is True


def test_sbc_requires_connection_and_running_controller():
    assert sbc_controller_is_ready(connected=True, running=True) is True
    assert sbc_controller_is_ready(connected=False, running=True) is False
    assert sbc_controller_is_ready(connected=True, running=False) is False
