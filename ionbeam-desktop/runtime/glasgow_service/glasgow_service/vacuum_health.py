"""Pure readiness rules shared by services and regression tests."""


def executor_state_is_ready(state: str) -> bool:
    return state not in {"faulted", "stopped", "fenced"}


def sbc_controller_is_ready(*, connected: bool, running: bool) -> bool:
    return connected and running
