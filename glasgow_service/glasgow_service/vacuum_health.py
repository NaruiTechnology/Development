"""Pure readiness rules shared by services and regression tests."""


def executor_state_is_ready(state: str) -> bool:
    return state not in {"faulted", "stopped", "fenced"}


def sbc_controller_is_ready(*, connected: bool, running: bool) -> bool:
    return connected and running


def vacuum_service_problems(
    *,
    connected: bool,
    running: bool,
    cascade_latch: str | None,
    restarting: bool = False,
    alarms: list[str] | tuple[str, ...] = (),
) -> list[str]:
    """Reasons the vacuum service is not delivering continuous service.

    Empty when the controller runs, reads its device and the cascade is free
    to advance (it may still be pumping down).  Used by ``/health/vacuum`` so
    external monitoring sees a latched or alarmed cascade, which
    ``/health/ready`` (process readiness, used by deploy checks) does not.
    """
    problems: list[str] = []
    if not running:
        problems.append("controller is not running")
    elif not connected:
        problems.append("device readings are stale or the device is disconnected")
    if cascade_latch is not None:
        problems.append(f"cascade stopped ({cascade_latch})")
    if restarting:
        problems.append("backing-pump restart in progress")
    problems.extend(f"alarm: {alarm}" for alarm in alarms)
    return problems
