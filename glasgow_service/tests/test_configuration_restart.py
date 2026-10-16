"""Configuration reset restarts the scan service only.

The SBC vacuum controller owns the vacuum system once it runs; restarting it
powers every pump down.  The optional failover executor does not read the
scan configuration and can take most of the backend's 30 s budget to stop.
Both are only started when they are not running; an executor problem is a
warning, never a failed reset.
"""
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
    # INACTIVE_UNIT never becomes active; STOPPED_UNIT is inactive until it is
    # started; FAIL_UNIT fails its restart/start.
    systemctl = executable("systemctl", '''
echo "$*" >> "$RESET_LOG"
unit="${@: -1}"
if [[ ( "$*" == *" restart "* || "$*" == *" start "* ) && "$unit" == "$FAIL_UNIT" ]]; then exit 1; fi
if [[ "$*" == *" is-active "* && "$unit" == "$INACTIVE_UNIT" ]]; then exit 3; fi
if [[ "$*" == *" is-active "* && "$unit" == "$STOPPED_UNIT" ]] &&
   ! grep -qE " (start|restart) $unit" "$RESET_LOG"; then exit 3; fi
if [[ "$*" == *"--property=LoadState"* ]]; then
  if [[ "$*" == *"$MISSING_UNIT"* && -n "$MISSING_UNIT" ]]; then echo not-found; else echo loaded; fi
fi
''')
    log = tmp_path / "calls.log"
    result = subprocess.run(
        ["/bin/bash", str(SCRIPT)], capture_output=True, text=True,
        env={**os.environ, "PATH": f"{tmp_path}:/usr/bin:/bin",
             "SYSTEMCTL_BIN": str(systemctl), "RESET_LOG": str(log),
             "FAIL_UNIT": "", "INACTIVE_UNIT": "", "STOPPED_UNIT": "", "MISSING_UNIT": "",
             **overrides},
        timeout=5,
    )
    return result, log.read_text().splitlines()


def test_configuration_reset_restarts_only_the_scan_service(tmp_path):
    result, calls = reset_services(tmp_path)
    assert result.returncode == 0, result.stderr
    assert [call for call in calls if " restart " in call or " start " in call] == [
        "--no-ask-password restart glasgow-svc.service",
    ]
    assert not any("stop" in call for call in calls)
    assert "sbc-vacuum.service is running; left untouched" in result.stdout
    assert "vacuum-executor.service is running; left untouched" in result.stdout
    assert "restarted glasgow-svc.service; service is active" in result.stdout


def test_configuration_reset_starts_a_stopped_sbc_without_restarting_it(tmp_path):
    result, calls = reset_services(tmp_path, STOPPED_UNIT="sbc-vacuum.service")
    assert result.returncode == 0, result.stderr
    assert "--user --no-ask-password start sbc-vacuum.service" in calls
    assert not any("restart sbc-vacuum" in call for call in calls)
    assert "started sbc-vacuum.service; service is active" in result.stdout


def test_configuration_reset_starts_a_stopped_executor(tmp_path):
    result, calls = reset_services(tmp_path, STOPPED_UNIT="vacuum-executor.service")
    assert result.returncode == 0, result.stderr
    assert "--no-ask-password restart vacuum-executor.service" in calls
    assert "restarted vacuum-executor.service; service is active" in result.stdout


def test_executor_problems_never_fail_the_reset(tmp_path):
    result, _ = reset_services(tmp_path, STOPPED_UNIT="vacuum-executor.service",
                               FAIL_UNIT="vacuum-executor.service")
    assert result.returncode == 0, result.stderr
    assert "WARNING: vacuum-executor.service could not be started" in result.stderr
    missing = tmp_path / "missing"
    missing.mkdir()
    result, calls = reset_services(missing, STOPPED_UNIT="vacuum-executor.service",
                                   MISSING_UNIT="vacuum-executor.service")
    assert result.returncode == 0, result.stderr
    assert "vacuum-executor.service is not installed; skipped" in result.stdout
    assert not any("restart vacuum-executor" in call for call in calls)


def test_configuration_reset_reports_scan_service_restart_failure(tmp_path):
    result, _ = reset_services(tmp_path, FAIL_UNIT="glasgow-svc.service")
    assert result.returncode != 0
    assert "restarted glasgow-svc.service; service is active" not in result.stdout


def test_configuration_reset_reports_sbc_startup_crash(tmp_path):
    result, _ = reset_services(tmp_path, INACTIVE_UNIT="sbc-vacuum.service")
    assert result.returncode != 0
    assert "sbc-vacuum.service, but it did not remain active" in result.stderr
