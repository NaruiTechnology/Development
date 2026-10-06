"""Keep every deploy test away from the real ~/.config/iobeam/secrets.env."""
import os
import tempfile

import pytest


@pytest.fixture(autouse=True)
def isolated_secrets_file(monkeypatch):
    with tempfile.TemporaryDirectory() as directory:
        monkeypatch.setenv("IOBEAM_SECRETS_FILE", os.path.join(directory, "secrets.env"))
        yield
