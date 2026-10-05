"""Configuration reset restarts both scan and vacuum services."""
import os
from pathlib import Path
import subprocess

import pytest


SCRIPT = Path(__file__).parents[2] / "ionbeam-web/backend/scripts/restart-glasgow-service.sh"


def reset_services(tmp_path, **overrides):
    def executable(name, source):
        target = tmp_path / name
        target.write_text("#!/bin/bash\n" + source)
        target.chmod(0o755)
        return target

    executable("id", 'if [[ "$1" == "-un" ]]; then echo operator; else echo sudo; fi\n')
    executable("sleep", "exit 0\n")
    systemctl = executable("systemctl", '''
echo "$*" >> "$RESET_LOG"
unit="${@: -1}"
if [[ "$*" == *" restart "* && "$unit" == "$FAIL_UNIT" ]]; then exit 1; fi
if [[ "$*" == *" is-active "* && "$unit" == "$INACTIVE_UNIT" ]]; then exit 3; fi
''')
    log = tmp_path / "calls.log"
    result = subprocess.run(
        ["/bin/bash", str(SCRIPT)], capture_output=True, text=True,
        env={**os.environ, "PATH": f"{tmp_path}:/usr/bin:/bin",
             "SYSTEMCTL_BIN": str(systemctl), "RESET_LOG": str(log),
             "FAIL_UNIT": "", "INACTIVE_UNIT": "", **overrides},
        timeout=5,
    )
    return result, log.read_text().splitlines()


def test_configuration_reset_restarts_scan_sbc_and_executor(tmp_path):
    result, calls = reset_services(tmp_path)
    assert result.returncode == 0, result.stderr
    assert [call for call in calls if " restart " in call] == [
        "--no-ask-password restart glasgow-svc.service",
        "--user --no-ask-password restart sbc-vacuum.service",
        "--no-ask-password restart vacuum-executor.service",
    ]
    for unit in ("glasgow-svc.service", "sbc-vacuum.service", "vacuum-executor.service"):
        assert f"restarted {unit}; service is active" in result.stdout


@pytest.mark.parametrize("unit", ["sbc-vacuum.service", "vacuum-executor.service"])
def test_configuration_reset_reports_vacuum_restart_failure(tmp_path, unit):
    result, _ = reset_services(tmp_path, FAIL_UNIT=unit)
    assert result.returncode != 0
    assert f"restarted {unit}; service is active" not in result.stdout


def test_configuration_reset_reports_sbc_startup_crash(tmp_path):
    result, calls = reset_services(tmp_path, INACTIVE_UNIT="sbc-vacuum.service")
    assert result.returncode != 0
    assert "sbc-vacuum.service, but it did not remain active" in result.stderr
    # Reset the remaining services even when the SBC crashes; the overall
    # operation still reports failure so the operator sees the fault.
    assert any("restart vacuum-executor.service" in call for call in calls)
