#!/usr/bin/env bash
# Install the Ion Beam native desktop app from a Development checkout (or from
# a bundle made by scripts/build.py, which has the same layout).
#
#   ionbeam-native/scripts/install_linux.sh [options]
#
# Options
#   --venv DIR            virtualenv to create/use (default: ionbeam-native/.venv;
#                         pass the Operations .venv to share it with glasgow_service)
#   --python BIN          interpreter used to create the venv (default: python3)
#   --dev                 also install pytest/pyflakes/pyinstaller
#   --skip-pip            do not install requirements (already installed in the venv,
#                         e.g. by the DistributionDeploy installPipRequirements action)
#   --no-desktop-entry    skip the applications-menu entry
#   --no-launcher         skip ~/.local/bin/ionbeam-native
#   --udev                install the Glasgow udev rule (sudo) so USB works without root
#   --skip-smoke          skip the post-install smoke test
#   --uninstall           remove launcher + desktop entry (the venv is left alone)
#
# Idempotent: re-running upgrades packages to the pinned versions and rewrites
# the launcher.
set -Eeuo pipefail

APP_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEV_ROOT="$(cd -- "${APP_ROOT}/.." && pwd -P)"
VENV="${APP_ROOT}/.venv"
PYTHON="${PYTHON:-python3}"
DEV=0 DESKTOP=1 LAUNCHER=1 UDEV=0 SMOKE=1 UNINSTALL=0 SKIP_PIP=0
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/256x256/apps"
UDEV_RULE=/etc/udev/rules.d/60-glasgow-ionbeam.rules

while [[ $# -gt 0 ]]; do
  case "$1" in
    --venv) VENV="$(realpath -m "$2")"; shift 2 ;;
    --python) PYTHON="$2"; shift 2 ;;
    --dev) DEV=1; shift ;;
    --skip-pip) SKIP_PIP=1; shift ;;
    --no-desktop-entry) DESKTOP=0; shift ;;
    --no-launcher) LAUNCHER=0; shift ;;
    --udev) UDEV=1; shift ;;
    --skip-smoke) SMOKE=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

if [[ $UNINSTALL -eq 1 ]]; then
  rm -f "${BIN_DIR}/ionbeam-native" "${APPS_DIR}/ionbeam-native.desktop" "${ICON_DIR}/ionbeam-native.png"
  command -v update-desktop-database >/dev/null && update-desktop-database "${APPS_DIR}" 2>/dev/null || true
  say "removed launcher and desktop entry (venv kept: ${VENV})"
  exit 0
fi

# ---------------------------------------------------------------- preflight
for d in GlasgowDataIO glasgow_service AutomationPy; do
  [[ -d "${DEV_ROOT}/${d}" ]] || die "${DEV_ROOT}/${d} not found - run this from a Development checkout or bundle"
done
command -v "${PYTHON}" >/dev/null || die "${PYTHON} not found (install Python >= 3.10)"
"${PYTHON}" - <<'EOF' || die "Python >= 3.10 is required"
import sys
sys.exit(0 if sys.version_info >= (3, 10) else 1)
EOF

# ---------------------------------------------------------------- venv + packages
if [[ ! -x "${VENV}/bin/python" ]]; then
  say "creating virtualenv ${VENV}"
  "${PYTHON}" -m venv "${VENV}" || die "venv creation failed (Debian/Ubuntu: sudo apt install python3-venv)"
fi
VPY="${VENV}/bin/python"
say "installing pinned requirements"
if [[ $SKIP_PIP -eq 0 ]]; then
  "${VPY}" -m pip install --upgrade --quiet pip
  "${VPY}" -m pip install --quiet -r "${APP_ROOT}/requirements.txt"
  [[ $DEV -eq 1 ]] && "${VPY}" -m pip install --quiet -r "${APP_ROOT}/requirements-dev.txt"
else
  say "skipping requirements (--skip-pip)"
fi
# A checkout is installed editable; a compiled distribution (.pyc only, as
# built by buildCompiledDist.py) runs from PYTHONPATH set by the launcher.
if [[ -f "${APP_ROOT}/ionbeam_native/__init__.py" ]]; then
  say "installing ionbeam-native (editable, from ${APP_ROOT})"
  "${VPY}" -m pip install --quiet --no-deps -e "${APP_ROOT}"
else
  say "compiled distribution detected: running from ${APP_ROOT} via PYTHONPATH"
fi
export PYTHONPATH="${APP_ROOT}${PYTHONPATH:+:${PYTHONPATH}}"

# ---------------------------------------------------------------- verify
say "verifying imports"
VERIFY_DIR="$(mktemp -d)"   # the service loggers create *.log files in the cwd
(cd "${VERIFY_DIR}" && QT_QPA_PLATFORM=offscreen IONBEAM_DEVELOPMENT_ROOT="${DEV_ROOT}" "${VPY}" -c '
import ionbeam_native.engine.engine    # GlasgowDataIO + glasgow_service + AutomationPy
import ionbeam_native.ui.main_window   # PyQt6
print("    imports ok")')
rm -rf "${VERIFY_DIR}"
QT_PLUGIN="$("${VPY}" -c 'import PyQt6, pathlib; print(pathlib.Path(PyQt6.__file__).parent / "Qt6/plugins/platforms/libqxcb.so")')"
if [[ -f "${QT_PLUGIN}" ]] && command -v ldd >/dev/null; then
  MISSING="$(ldd "${QT_PLUGIN}" 2>/dev/null | awk '/not found/{print $1}' | sort -u | tr '\n' ' ')"
  if [[ -n "${MISSING}" ]]; then
    warn "Qt's X11 platform plugin is missing system libraries: ${MISSING}"
    warn "Debian/Ubuntu: sudo apt install libxcb-cursor0 libxkbcommon-x11-0 libxcb-icccm4 libxcb-keysyms1 libxcb-shape0 libegl1"
  fi
fi

# ---------------------------------------------------------------- launcher + menu entry
if [[ $LAUNCHER -eq 1 ]]; then
  mkdir -p "${BIN_DIR}"
  cat > "${BIN_DIR}/ionbeam-native" <<EOF
#!/usr/bin/env bash
# generated by ionbeam-native/scripts/install_linux.sh
export IONBEAM_DEVELOPMENT_ROOT="\${IONBEAM_DEVELOPMENT_ROOT:-${DEV_ROOT}}"
if [[ -z "\${GLASGOW_CONFIG:-}" && -f "${DEV_ROOT}/GlasgowDataIO/Json/streamData.json" ]]; then
  export GLASGOW_CONFIG="${DEV_ROOT}/GlasgowDataIO/Json/streamData.json"
fi
export PYTHONPATH="${APP_ROOT}\${PYTHONPATH:+:\${PYTHONPATH}}"
exec "${VPY}" -m ionbeam_native "\$@"
EOF
  chmod +x "${BIN_DIR}/ionbeam-native"
  say "launcher: ${BIN_DIR}/ionbeam-native"
  case ":${PATH}:" in *":${BIN_DIR}:"*) ;; *) warn "${BIN_DIR} is not on PATH" ;; esac
fi
if [[ $DESKTOP -eq 1 && $LAUNCHER -eq 1 ]]; then
  mkdir -p "${APPS_DIR}" "${ICON_DIR}"
  cp "${APP_ROOT}/ionbeam_native/resources/images/brand-logo.png" "${ICON_DIR}/ionbeam-native.png"
  cat > "${APPS_DIR}/ionbeam-native.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Ion Beam (native)
Comment=Ion Beam control console - native desktop client
Exec=${BIN_DIR}/ionbeam-native
Icon=ionbeam-native
Terminal=false
Categories=Science;Engineering;
StartupWMClass=ionbeam-native
EOF
  command -v update-desktop-database >/dev/null && update-desktop-database "${APPS_DIR}" 2>/dev/null || true
  say "desktop entry: ${APPS_DIR}/ionbeam-native.desktop"
fi

# ---------------------------------------------------------------- udev (optional)
if [[ $UDEV -eq 1 ]]; then
  say "installing Glasgow udev rule ${UDEV_RULE} (sudo)"
  echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="20b7", ATTRS{idProduct}=="9db1", MODE="0660", TAG+="uaccess"' |
    sudo tee "${UDEV_RULE}" >/dev/null
  sudo udevadm control --reload-rules && sudo udevadm trigger || warn "reload udev manually or replug the device"
fi

# ---------------------------------------------------------------- smoke
if [[ $SMOKE -eq 1 ]]; then
  say "smoke test (emulator + mock backend, offscreen)"
  SMOKE_SCRIPT="${APP_ROOT}/scripts/smoke.py"
  [[ -f "${SMOKE_SCRIPT}" ]] || SMOKE_SCRIPT="${APP_ROOT}/scripts/smoke.pyc"
  IONBEAM_DEVELOPMENT_ROOT="${DEV_ROOT}" "${VPY}" "${SMOKE_SCRIPT}" --seconds 5 ||
    die "smoke test failed - see the output above"
fi

say "done. Start with: ionbeam-native   (or ionbeam-native --emulator for a hardware-free demo)"
