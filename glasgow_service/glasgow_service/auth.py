"""Optional bearer-token auth. Enabled when GLASGOW_TOKEN env var is set."""
import os
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

_bearer = HTTPBearer(auto_error=False)


def require_token(cred: HTTPAuthorizationCredentials = Depends(_bearer)):
    expected = os.environ.get("GLASGOW_TOKEN")
    if not expected:
        # Token disabled = open localhost dev mode.
        return
    if cred is None or cred.credentials != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
