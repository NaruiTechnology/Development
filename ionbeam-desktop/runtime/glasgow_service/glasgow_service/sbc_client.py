"""Executor-side REST client for the fenced SBC vacuum service."""
from __future__ import annotations

from typing import Any

from .coordination import Clock, SystemMonotonicClock
from .execution_authority import AuthorityDenied
from .failover_executor import FailoverExecutor


class SbcClientError(RuntimeError):
    pass


class SbcAuthorityRejected(AuthorityDenied, SbcClientError):
    pass


class SbcVacuumClient:
    def __init__(self, base_url: str, executor: FailoverExecutor, *,
                 bearer_token: str | None = None, http_client: Any | None = None,
                 clock: Clock | None = None, timeout: float = 3.0) -> None:
        if not base_url:
            raise ValueError("SBC base URL must not be empty")
        self.base_url = base_url.rstrip("/")
        self.executor = executor
        self.bearer_token = bearer_token
        self.clock = clock or SystemMonotonicClock()
        self.timeout = timeout
        self._owns_client = http_client is None
        if http_client is None:
            try:
                import httpx
            except ImportError as exc:
                raise RuntimeError("SBC client requires the 'httpx' package") from exc
            http_client = httpx.AsyncClient()
        self.http = http_client

    async def status(self) -> dict[str, Any]:
        return await self._request("GET", "/vacuum", require_authority=False)

    async def acquire(self, expected_channels: dict[str, float] | None = None) -> dict[str, Any]:
        return await self._request("POST", "/vacuum/acquire",
                                   json={"expected_channels": expected_channels or {}})

    async def renew_leadership(self) -> dict[str, Any]:
        return await self._request("POST", "/vacuum/leadership/renew")

    async def release(self) -> dict[str, Any]:
        return await self._request("POST", "/vacuum/release")

    async def set_power(self, equipment_name: str, power: bool) -> dict[str, Any]:
        return await self._request("POST", f"/vacuum/pumps/{equipment_name}/power",
                                   json={"power": power})

    async def set_high_voltage_power(self, power: bool) -> dict[str, Any]:
        return await self._request(
            "POST", "/vacuum/high-voltage/power", json={"power": power}
        )

    async def stop(self) -> dict[str, Any]:
        return await self._request("POST", "/vacuum/stop")

    async def resume(self) -> dict[str, Any]:
        return await self._request("POST", "/vacuum/resume")

    async def close(self) -> None:
        if self._owns_client:
            await self.http.aclose()

    def fencing_headers(self) -> dict[str, str]:
        lease = self.executor.lease
        if not self.executor.may_execute or lease is None:
            raise SbcAuthorityRejected(
                f"executor {self.executor.instance_id} has no live lease")
        remaining_ms = int((lease.valid_until - self.clock.now()) * 1000.0)
        if remaining_ms <= 0:
            raise SbcAuthorityRejected("executor lease has expired")
        headers = {
            "X-Executor-ID": self.executor.instance_id,
            "X-Fencing-Token": str(lease.fencing_token),
            "X-Lease-Valid-For-Ms": str(remaining_ms),
        }
        if self.bearer_token:
            headers["Authorization"] = f"Bearer {self.bearer_token}"
        return headers

    async def _request(self, method: str, path: str, *,
                       json: dict[str, Any] | None = None,
                       require_authority: bool = True) -> dict[str, Any]:
        headers = self.fencing_headers() if require_authority else {}
        if self.bearer_token and "Authorization" not in headers:
            headers["Authorization"] = f"Bearer {self.bearer_token}"
        try:
            response = await self.http.request(
                method, f"{self.base_url}{path}", headers=headers,
                json=json, timeout=self.timeout)
        except Exception as exc:
            raise SbcClientError(f"SBC request failed: {exc}") from exc
        if response.status_code in {409, 428}:
            raise SbcAuthorityRejected(self._response_detail(response))
        if response.status_code >= 400:
            raise SbcClientError(
                f"SBC returned HTTP {response.status_code}: {self._response_detail(response)}")
        payload = response.json()
        if not isinstance(payload, dict):
            raise SbcClientError("SBC returned a non-object response")
        return payload

    @staticmethod
    def _response_detail(response: Any) -> str:
        try:
            payload = response.json()
            if isinstance(payload, dict) and "detail" in payload:
                return str(payload["detail"])
        except Exception:
            pass
        return str(getattr(response, "text", "request rejected"))
