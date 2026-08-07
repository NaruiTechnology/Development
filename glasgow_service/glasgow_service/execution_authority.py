"""Execution-authority boundary between failover and vacuum control."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from .failover_executor import FailoverExecutor


@dataclass(frozen=True, slots=True)
class ExecutionPermit:
    """Identity attached to an executor's current leadership term."""

    holder_id: str
    fencing_token: int


class AuthorityDenied(RuntimeError):
    """Raised before a hardware mutation when leadership is not valid."""


class ExecutionAuthority(Protocol):
    def require(self) -> ExecutionPermit: ...


class FailoverExecutionAuthority:
    """Expose a ``FailoverExecutor`` lease as a synchronous safety guard."""

    def __init__(self, executor: FailoverExecutor) -> None:
        self.executor = executor

    def require(self) -> ExecutionPermit:
        lease = self.executor.lease
        if not self.executor.may_execute or lease is None:
            raise AuthorityDenied(
                f"executor {self.executor.instance_id} does not hold active leadership"
            )
        return ExecutionPermit(
            holder_id=self.executor.instance_id,
            fencing_token=lease.fencing_token,
        )

