"""Pure lifecycle model for an infinitely running active/standby executor."""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class ExecutorState(str, Enum):
    STARTING = "starting"
    STANDBY = "standby"
    ACTIVE = "active"
    DRAINING = "draining"
    FENCED = "fenced"
    FAULTED = "faulted"
    STOPPED = "stopped"


class InvalidExecutorTransition(RuntimeError):
    pass


_ALLOWED_TRANSITIONS: dict[ExecutorState, frozenset[ExecutorState]] = {
    ExecutorState.STARTING: frozenset({ExecutorState.STANDBY, ExecutorState.FAULTED, ExecutorState.STOPPED}),
    ExecutorState.STANDBY: frozenset({ExecutorState.ACTIVE, ExecutorState.FENCED, ExecutorState.FAULTED, ExecutorState.STOPPED}),
    ExecutorState.ACTIVE: frozenset({ExecutorState.DRAINING, ExecutorState.FENCED, ExecutorState.FAULTED}),
    ExecutorState.DRAINING: frozenset({ExecutorState.STANDBY, ExecutorState.FENCED, ExecutorState.FAULTED, ExecutorState.STOPPED}),
    ExecutorState.FENCED: frozenset({ExecutorState.STANDBY, ExecutorState.FAULTED, ExecutorState.STOPPED}),
    ExecutorState.FAULTED: frozenset({ExecutorState.STANDBY, ExecutorState.FENCED, ExecutorState.STOPPED}),
    ExecutorState.STOPPED: frozenset(),
}


@dataclass(slots=True)
class ExecutorLifecycle:
    """Validated lifecycle state; coordination transport is added later."""

    state: ExecutorState = ExecutorState.STARTING
    fencing_token: int | None = None

    @property
    def may_execute(self) -> bool:
        return (
            self.state is ExecutorState.ACTIVE
            and self.fencing_token is not None
            and self.fencing_token > 0
        )

    def transition(
        self,
        target: ExecutorState,
        *,
        fencing_token: int | None = None,
    ) -> None:
        if target is self.state:
            return
        if target not in _ALLOWED_TRANSITIONS[self.state]:
            raise InvalidExecutorTransition(
                f"executor cannot transition from {self.state.value} to {target.value}"
            )
        if target is ExecutorState.ACTIVE:
            if fencing_token is None or fencing_token <= 0:
                raise InvalidExecutorTransition(
                    "entering active state requires a positive fencing token"
                )
            if self.fencing_token is not None and fencing_token <= self.fencing_token:
                raise InvalidExecutorTransition(
                    "a new leadership term requires a newer fencing token"
                )
            self.fencing_token = fencing_token
        else:
            if fencing_token is not None:
                raise InvalidExecutorTransition(
                    "fencing tokens may only be supplied when entering active state"
                )
        self.state = target

