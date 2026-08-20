#!/usr/bin/env bash
set -Eeuo pipefail

# Glasgow is a system service, but the active local service account is allowed
# to restart it through systemd/polkit. Do not route this through the full-stack
# manager: that requires interactive sudo and can restart this backend itself.
SYSTEMCTL=/usr/bin/systemctl
SERVICE=glasgow-svc.service
ACCOUNT="$(id -un)"
POLKIT_RULE=/etc/polkit-1/rules.d/60-ionbeam-glasgow-restart.rules

# The signed-in account must be an administrator. This is only an eligibility
# check; --no-ask-password below is what guarantees this backend command can
# never display or wait for an authentication dialog.
if ! id -nG "${ACCOUNT}" | tr ' ' '\n' | grep -Eq '^(sudo|admin|wheel)$'; then
  echo "account ${ACCOUNT} is not a sudoer; refusing to restart ${SERVICE}" >&2
  exit 1
fi

if [[ ! -r "${POLKIT_RULE}" ]]; then
  echo "restart authorization is not installed; rerun the distribution installer" >&2
  exit 1
fi

"${SYSTEMCTL}" --no-ask-password restart "${SERVICE}"

# Require the unit to remain active for several consecutive checks so an
# immediate startup crash is reported without depending on a fixed API URL.
stable_checks=0
for _ in {1..20}; do
  if "${SYSTEMCTL}" --no-ask-password is-active --quiet "${SERVICE}"; then
    ((stable_checks += 1))
    if ((stable_checks >= 6)); then
      echo "restarted ${SERVICE}; service is active"
      exit 0
    fi
  else
    stable_checks=0
  fi
  sleep 0.5
done

echo "restarted ${SERVICE}, but it did not remain active" >&2
exit 1
