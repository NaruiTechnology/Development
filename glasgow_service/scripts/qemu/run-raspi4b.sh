#!/usr/bin/env bash
# Boot Raspberry Pi OS (64-bit, Lite) on QEMU's raspi4b machine.
#
#   scripts/qemu/run-raspi4b.sh prepare  raspios-lite-arm64.img  [user] [password]
#   scripts/qemu/run-raspi4b.sh run      raspios-lite-arm64.img  [-- extra qemu args]
#
# What this is for: checking the controller's OS image (boot, systemd unit,
# Python environment, config.txt) on the same Raspberry Pi 4 Model B
# machine type that the shopping list buys, before the hardware arrives.
#
# What it is NOT for: the vacuum I/O board.  QEMU has no model of the
# board's MCP23017 / ADS1115 chips, relays or field wiring, so `i2cdetect -y 1`
# shows an empty bus.  Test controller logic with the Python emulator instead:
#     python -m glasgow_service.emulation commission
#     SBC_VACUUM_EMULATOR=1 python -m glasgow_service.sbc_vacuum_app
#
# Upstream QEMU raspi4b limits (QEMU docs, "Raspberry Pi boards"):
#   * needs QEMU >= 9.0 (Ubuntu 24.04 ships 8.2: use Debian trixie / Ubuntu
#     24.10+, or build QEMU from source);
#   * 2 GiB RAM, matching the Pi 4B 2 GB on the shopping list;
#   * no Ethernet (GENET), no PCIe (so no USB 3 / VL805), no PWM.
#     Use the serial console.  Patched builds that add GENET exist
#     (e.g. github.com/fpgas-online/rpi-qemu); point QEMU_BIN at one and pass
#     its networking options after "--".
#   * QEMU loads the kernel directly, without the Pi firmware, so config.txt
#     dtoverlay lines (disable-bt, uart5, i2c_arm) are not applied.
set -euo pipefail

QEMU_BIN=${QEMU_BIN:-qemu-system-aarch64}
WORK=${WORK:-"$(dirname "$0")/work"}
ROOTDEV=${ROOTDEV:-/dev/mmcblk1p2}   # if the kernel waits for root, try /dev/mmcblk0p2

die() { echo "error: $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "missing '$1' ($2)"; }

check_qemu() {
    need "$QEMU_BIN" "install qemu-system-arm >= 9.0"
    "$QEMU_BIN" -machine help | grep -q '^raspi4b' ||
        die "$($QEMU_BIN --version | head -1) has no raspi4b machine; QEMU >= 9.0 is required"
}

boot_offset() {
    # Byte offset of the FAT boot partition (partition 1).
    local img=$1 start
    start=$(sfdisk -J "$img" | python3 -c 'import json,sys; print(json.load(sys.stdin)["partitiontable"]["partitions"][0]["start"])')
    echo $((start * 512))
}

prepare() {
    local img=${1:?image path} user=${2:-vacuum} password=${3:-}
    [ -f "$img" ] || die "no such image: $img (unxz the downloaded .img.xz first)"
    need sfdisk "util-linux"; need mcopy "mtools"; need qemu-img "qemu-utils"; need openssl "openssl"
    mkdir -p "$WORK"
    local off; off=$(boot_offset "$img")
    mcopy -o -i "$img@@$off" ::kernel8.img "$WORK/kernel8.img"
    mcopy -o -i "$img@@$off" ::bcm2711-rpi-4-b.dtb "$WORK/bcm2711-rpi-4-b.dtb"

    # Headless first boot: user account and SSH (Raspberry Pi OS has no
    # default user since 2022).
    if [ -z "$password" ]; then
        read -r -s -p "password for '$user': " password; echo
    fi
    printf '%s:%s\n' "$user" "$(openssl passwd -6 "$password")" > "$WORK/userconf.txt"
    : > "$WORK/ssh"
    mcopy -o -i "$img@@$off" "$WORK/userconf.txt" ::userconf.txt
    mcopy -o -i "$img@@$off" "$WORK/ssh" ::ssh

    # Same config.txt lines as the real controller (applied on hardware only).
    mcopy -o -i "$img@@$off" ::config.txt "$WORK/config.txt"
    if ! grep -q 'RPi5VacuumIO' "$WORK/config.txt"; then
        cat >> "$WORK/config.txt" <<'EOF'

[all]
# RPi5VacuumIO board on a Raspberry Pi 4 Model B
dtparam=i2c_arm=on
enable_uart=1
dtoverlay=disable-bt
dtoverlay=uart5
EOF
        mcopy -o -i "$img@@$off" "$WORK/config.txt" ::config.txt
    fi

    # The emulated SD controller needs a power-of-two image size.
    local size pow=1
    size=$(stat -c %s "$img")
    while [ $((pow * 1024 * 1024 * 1024)) -lt "$size" ]; do pow=$((pow * 2)); done
    [ "$pow" -lt 8 ] && pow=8
    qemu-img resize -f raw "$img" "${pow}G" >/dev/null
    echo "prepared $img (${pow} GiB); kernel and DTB in $WORK"
}

run() {
    local img=${1:?image path}; shift
    [ "${1:-}" = "--" ] && shift
    check_qemu
    [ -f "$WORK/kernel8.img" ] || die "run '$0 prepare $img' first"
    exec "$QEMU_BIN" \
        -machine raspi4b -m 2G -smp 4 \
        -kernel "$WORK/kernel8.img" \
        -dtb "$WORK/bcm2711-rpi-4-b.dtb" \
        -drive "file=$img,if=sd,format=raw" \
        -append "console=ttyAMA0,115200 root=$ROOTDEV rootfstype=ext4 rootwait fsck.repair=yes" \
        -serial mon:stdio -display none \
        "$@"
}

case "${1:-}" in
    prepare) shift; prepare "$@" ;;
    run)     shift; run "$@" ;;
    check)   check_qemu; echo "$($QEMU_BIN --version | head -1): raspi4b available" ;;
    *)       sed -n '2,8p' "$0"; exit 2 ;;
esac
