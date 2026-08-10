"""Execution-authority boundary between failover and vacuum control."""
from __future__ import annotations

import json
import os
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .coordination import Clock, SystemMonotonicClock
from .failover_executor import FailoverExecutor


REQUIRE_FENCING_ENV = "SBC_REQUIRE_FENCING"
FENCING_STATE_ENV = "SBC_FENCING_STATE"
DEFAULT_FENCING_STATE = Path("/var/lib/sbc-vacuum/fencing-token.json")


@dataclass(frozen=True, slots=True)
class ExecutionPermit:
    """Identity attached to an executor's current leadership term."""

    holder_id: str
    fencing_token: int


class AuthorityDenied(RuntimeError):
    """Raised before a hardware mutation when leadership is not valid."""


class StaleFencingToken(AuthorityDenied):
    """Raised when an obsolete leadership term reaches the hardware owner."""


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


class PersistentFencingTokenStore:
    """Persist the highest term accepted by the single hardware owner."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._permit = self._load()

    @property
    def highest_permit(self) -> ExecutionPermit | None:
        return self._permit

    def accept(self, permit: ExecutionPermit) -> None:
        if not permit.holder_id:
            raise ValueError("execution permit holder_id must not be empty")
        if permit.fencing_token <= 0:
            raise ValueError("execution permit fencing_token must be positive")
        with self._lock:
            current = self._permit
            if current is not None:
                if permit.fencing_token < current.fencing_token:
                    raise StaleFencingToken(
                        f"fencing token {permit.fencing_token} is older than "
                        f"accepted token {current.fencing_token}"
                    )
                if (
                    permit.fencing_token == current.fencing_token
                    and permit.holder_id != current.holder_id
                ):
                    raise StaleFencingToken(
                        f"fencing token {permit.fencing_token} belongs to "
                        f"executor {current.holder_id}"
                    )
                if permit == current:
                    return
            self._persist(permit)
            self._permit = permit

    def _load(self) -> ExecutionPermit | None:
        if not self.path.exists():
            return None
        payload = json.loads(self.path.read_text())
        return ExecutionPermit(
            holder_id=str(payload["holder_id"]),
            fencing_token=int(payload["fencing_token"]),
        )

    def _persist(self, permit: ExecutionPermit) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "holder_id": permit.holder_id,
            "fencing_token": permit.fencing_token,
        }
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.", dir=self.path.parent
        )
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w") as stream:
                json.dump(payload, stream, sort_keys=True)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_path, self.path)
        finally:
            if temporary_path.exists():
                temporary_path.unlink()


class RemoteExecutionAuthority:
    """Expiring authority renewed by a remote elected executor."""

    def __init__(
        self,
        store: PersistentFencingTokenStore,
        *,
        clock: Clock | None = None,
        maximum_validity: float = 30.0,
    ) -> None:
        if maximum_validity <= 0:
            raise ValueError("maximum_validity must be positive")
        self.store = store
        self.clock = clock or SystemMonotonicClock()
        self.maximum_validity = maximum_validity
        self._permit: ExecutionPermit | None = None
        self._valid_until: float | None = None

    def accept(
        self, holder_id: str, fencing_token: int, valid_for: float
    ) -> ExecutionPermit:
        if valid_for <= 0 or valid_for > self.maximum_validity:
            raise AuthorityDenied(
                f"lease validity must be greater than zero and at most "
                f"{self.maximum_validity:g} seconds"
            )
        permit = ExecutionPermit(holder_id, fencing_token)
        self.store.accept(permit)
        self._permit = permit
        self._valid_until = self.clock.now() + valid_for
        return permit

    def require(self) -> ExecutionPermit:
        if (
            self._permit is None
            or self._valid_until is None
            or self.clock.now() >= self._valid_until
        ):
            raise AuthorityDenied("remote execution authority is missing or expired")
        return self._permit


def remote_authority_from_environment() -> RemoteExecutionAuthority | None:
    enabled = os.environ.get(REQUIRE_FENCING_ENV, "").strip().lower()
    if enabled not in {"", "0", "1", "false", "true", "no", "yes", "off", "on"}:
        raise ValueError(f"{REQUIRE_FENCING_ENV} must be a boolean value")
    if enabled not in {"1", "true", "yes", "on"}:
        return None
    path = Path(os.environ.get(FENCING_STATE_ENV, DEFAULT_FENCING_STATE))
    return RemoteExecutionAuthority(PersistentFencingTokenStore(path))
