"""HTTP client for the Node backend (control plane only).

The desktop app keeps the backend for everything that is *not* the scan data
path: accounts/sessions, equipment, activity + operation records, reports,
vacuum, sample stage, calibration persistence and FTP. Requests are small,
infrequent JSON calls; scan samples never go through here.

Semantics mirror the browser code: the session token from the signed-in user
is sent as ``X-Iobeam-Auth``; ``read_json`` reproduces ``readJsonResponse``
error texts.
"""
from __future__ import annotations

import json
import os
import threading
from typing import Any, Callable, Optional

import httpx

DEFAULT_API = "http://127.0.0.1:4000"


class ApiError(Exception):
    def __init__(self, message: str, status: int = 0, payload: Any = None):
        super().__init__(message)
        self.status = status
        self.payload = payload


def api_base_url() -> str:
    return (os.environ.get("IONBEAM_API_URL") or DEFAULT_API).strip().rstrip("/")


class Backend:
    def __init__(self, base_url: Optional[str] = None, token: Callable[[], str] = lambda: ""):
        self.base_url = (base_url or api_base_url()).rstrip("/")
        self._token = token
        self._local = threading.local()

    # one httpx.Client per worker thread (connection reuse, thread safety)
    def _client(self) -> httpx.Client:
        client = getattr(self._local, "client", None)
        if client is None:
            client = httpx.Client(base_url=self.base_url, timeout=httpx.Timeout(15.0, connect=3.0))
            self._local.client = client
        return client

    def headers(self, extra: Optional[dict] = None) -> dict:
        out = {}
        token = self._token() or ""
        if token:
            out["X-Iobeam-Auth"] = token
        if extra:
            out.update(extra)
        return out

    def request(self, method: str, path: str, *, json_body: Any = None, params: Optional[dict] = None,
                headers: Optional[dict] = None, timeout: Optional[float] = None,
                content: Optional[bytes] = None) -> httpx.Response:
        kwargs: dict = {"headers": self.headers(headers), "params": params}
        if json_body is not None:
            kwargs["json"] = json_body
        if content is not None:
            kwargs["content"] = content
        if timeout is not None:
            kwargs["timeout"] = timeout
        return self._client().request(method, path, **kwargs)

    # ---- JSON helpers --------------------------------------------------------

    @staticmethod
    def read_json(response: httpx.Response, label: str) -> Any:
        content_type = (response.headers.get("content-type") or "").lower()
        text = response.text
        url = str(response.request.url) if response.request else "(unknown url)"
        preview = " ".join(text.strip()[:120].split())
        if "application/json" not in content_type:
            raise ApiError(f"{label}: expected JSON from {url} but got {content_type or 'unknown content type'}"
                           + (f" ({preview})" if preview else ""), response.status_code)
        try:
            return json.loads(text)
        except ValueError:
            raise ApiError(f"{label}: invalid JSON from {url}" + (f" ({preview})" if preview else ""),
                           response.status_code) from None

    @staticmethod
    def error_detail(response: httpx.Response) -> str:
        try:
            payload = response.json()
        except ValueError:
            payload = None
        if isinstance(payload, dict):
            for key in ("error", "detail", "message"):
                value = payload.get(key)
                if value:
                    return str(value).strip()
        text = response.text.strip()
        return text or f"{response.status_code} {response.reason_phrase}"

    def get_json(self, path: str, label: str, **kwargs) -> Any:
        r = self.request("GET", path, **kwargs)
        if r.status_code >= 400:
            raise ApiError(f"{label}: HTTP {r.status_code} {self.error_detail(r)}".strip(), r.status_code)
        return self.read_json(r, label)

    def post_json(self, path: str, body: Any, label: str, method: str = "POST", **kwargs) -> Any:
        r = self.request(method, path, json_body=body, **kwargs)
        if r.status_code >= 400:
            raise ApiError(self.error_detail(r), r.status_code)
        return self.read_json(r, label)

    def close(self) -> None:
        client = getattr(self._local, "client", None)
        if client is not None:
            client.close()
            self._local.client = None
