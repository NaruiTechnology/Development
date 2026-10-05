#!/usr/bin/env bash
set -Eeuo pipefail

# Glasgow and the vacuum executor are system services; the SBC controller is
# a user service. Restart all three for a Configuration server reset.
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
  if [[ "${service}" == "sbc-vacuum.service" ]]; then
    echo "Active vacuum control uses the emulator when IsProduction=false and requires SBC hardware when IsProduction=true. Check logs/sbc-vacuum.log; on a machine without SBC hardware, turn off Configuration > General > Active vacuum control and click Update." >&2
  fi
  return 1
}

# A controller startup failure must not prevent the remaining resets.
restart_failed=0
restart_and_wait glasgow-svc.service || restart_failed=1
restart_and_wait sbc-vacuum.service --user || restart_failed=1
restart_and_wait vacuum-executor.service || restart_failed=1
exit "${restart_failed}"
