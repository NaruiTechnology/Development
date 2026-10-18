#!/usr/bin/env bash
set -Eeuo pipefail

# Glasgow and the vacuum executor are system services; the SBC controller is
# a user service. A Configuration server reset restarts the scan service,
# the only service that reads the scan configuration.
#
# The optional vacuum failover executor is not restarted either: nothing in
# the scan configuration affects it, the UI reads vacuum data straight from
# the SBC, and its orderly stop can take most of the backend's 30 s budget
# for this script. It is only started when it is not running, and a problem
# with it is reported as a warning, never as a failed reset.
#
# The SBC vacuum controller is NOT restarted here.  Once running it owns the
# vacuum system; restarting it powers every pump down (the backing pump
# included) and pumps the system down from scratch.  This script only starts
# it when it is not running.  To restart it on purpose, use
# Development/Scripts/manage-local-system.sh restart-vacuum.
# Do not route this through the full-stack
# manager: that requires interactive sudo and can restart this backend itself.
SYSTEMCTL="${SYSTEMCTL_BIN:-/usr/bin/systemctl}"
ACCOUNT="$(id -un)"

# The signed-in account must be an administrator. This is only an eligibility
# check; --no-ask-password below is what guarantees this backend command can
# never display or wait for an authentication dialog.
if ! id -nG "${ACCOUNT}" | tr ' ' '\n' | grep -Eq '^(sudo|admin|wheel)$'; then
  echo "account ${ACCOUNT} is not a sudoer; refusing to reset controller services" >&2
  exit 1
fi

# Do not test the rule file directly.  polkit rule directories may be hidden
# from this unprivileged user even when the rule is installed and active.
# systemd/polkit is the authority: --no-ask-password makes a missing or
# rejected authorization fail immediately without opening an auth dialog.
restart_and_wait() {
  local service="$1"
  shift
  local stable_checks=0
  "${SYSTEMCTL}" "$@" --no-ask-password restart "${service}" || return 1
  # Report startup crashes, including production mode without SBC hardware.
  for _ in {1..20}; do
    if "${SYSTEMCTL}" "$@" --no-ask-password is-active --quiet "${service}"; then
      ((stable_checks += 1))
      if ((stable_checks >= 6)); then
        echo "restarted ${service}; service is active"
        return 0
      fi
    else
      stable_checks=0
    fi
    sleep 0.5
  done
  echo "restarted ${service}, but it did not remain active" >&2
  return 1
}

# Start the SBC controller when it is not running; never restart a running
# one (see the header).
ensure_running() {
  local service="$1"
  shift
  if "${SYSTEMCTL}" "$@" --no-ask-password is-active --quiet "${service}"; then
    echo "${service} is running; left untouched (it owns the vacuum system)"
    return 0
  fi
  local stable_checks=0
  "${SYSTEMCTL}" "$@" --no-ask-password start "${service}" || return 1
  for _ in {1..20}; do
    if "${SYSTEMCTL}" "$@" --no-ask-password is-active --quiet "${service}"; then
      ((stable_checks += 1))
      if ((stable_checks >= 6)); then
        echo "started ${service}; service is active"
        return 0
      fi
    else
      stable_checks=0
    fi
    sleep 0.5
  done
  echo "started ${service}, but it did not remain active" >&2
  echo "Active vacuum control uses the emulator when IsProduction=false and requires SBC hardware when IsProduction=true. Check logs/sbc-vacuum.log; on a machine without SBC hardware, set Enable to false in the SBC's vacuum profile." >&2
  return 1
}

# Optional executor: start it only when it is installed and not running.
# The polkit rule grants the "restart" verb, which also starts a stopped unit.
ensure_executor_running() {
  local service="vacuum-executor.service"
  if "${SYSTEMCTL}" --no-ask-password is-active --quiet "${service}"; then
    echo "${service} is running; left untouched"
    return 0
  fi
  local load_state
  load_state="$("${SYSTEMCTL}" --no-ask-password show "${service}" --property=LoadState --value 2>/dev/null || true)"
  if [[ "${load_state}" == "not-found" ]]; then
    echo "${service} is not installed; skipped"
    return 0
  fi
  if ! restart_and_wait "${service}"; then
    echo "WARNING: ${service} could not be started; the vacuum UI does not depend on it" >&2
  fi
  return 0
}

# A controller startup failure must not prevent the remaining steps.
restart_failed=0
restart_and_wait glasgow-svc.service || restart_failed=1
ensure_running sbc-vacuum.service --user || restart_failed=1
ensure_executor_running
exit "${restart_failed}"
