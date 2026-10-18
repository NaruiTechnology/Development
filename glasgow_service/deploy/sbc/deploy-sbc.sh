#!/usr/bin/env bash
# Ship the SBC vacuum controller to a Raspberry Pi over SSH and install it.
#
#   glasgow_service/deploy/sbc/deploy-sbc.sh pi@vacuum-pi                 # build + install
#   glasgow_service/deploy/sbc/deploy-sbc.sh -b dist/sbc-vacuum-X.tar.gz pi@vacuum-pi --dry-run
#   glasgow_service/deploy/sbc/deploy-sbc.sh pi@vacuum-pi --restart       # also restart a running controller
#
# Everything after the host is passed to install_sbc.py on the Pi. The user
# needs sudo on the Pi (you are prompted for the password if required).
set -euo pipefail

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE=""
SSH_OPTS=()
SCP_OPTS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -b|--bundle) BUNDLE="$2"; shift 2 ;;
    -i) SSH_OPTS+=(-i "$2"); SCP_OPTS+=(-i "$2"); shift 2 ;;
    -p) SSH_OPTS+=(-p "$2"); SCP_OPTS+=(-P "$2"); shift 2 ;;
    -h|--help) usage 0 ;;
    -*) echo "unknown option $1" >&2; usage 2 ;;
    *) break ;;
  esac
done
[[ $# -ge 1 ]] || usage 2
TARGET="$1"; shift

if [[ -z "$BUNDLE" ]]; then
  OUT="$(mktemp -d)"
  python3 "$HERE/build_sbc_bundle.py" --out "$OUT"
  BUNDLE="$(ls "$OUT"/sbc-vacuum-*.tar.gz)"
fi
[[ -f "$BUNDLE" ]] || { echo "bundle not found: $BUNDLE" >&2; exit 2; }
NAME="$(basename "$BUNDLE" .tar.gz)"
REMOTE_DIR="/tmp/sbc-deploy"

echo "==> copying $(basename "$BUNDLE") to $TARGET"
ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$TARGET" "mkdir -p $REMOTE_DIR"
scp ${SCP_OPTS[@]+"${SCP_OPTS[@]}"} "$BUNDLE" "$TARGET:$REMOTE_DIR/"

ARGS="$(printf '%q ' "$@")"
echo "==> installing on $TARGET"
ssh -t ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$TARGET" "set -e
  cd $REMOTE_DIR && rm -rf '$NAME' && tar -xzf '$NAME.tar.gz'
  cd '$NAME' && sha256sum --quiet -c SHA256SUMS
  sudo python3 install_sbc.py $ARGS"
