# Raspberry Pi 4 Model B vacuum controller: shopping list and boot plan

Target tool: FEI (Philips) Strata DB235 DualBeam. Software: `glasgow_service.sbc_vacuum_app`
(see [`sbc-vacuum-controller.md`](sbc-vacuum-controller.md)) behind the `ionbeam-web` Vacuum
dashboard, driving the **RPi5VacuumIO rev A.1** interface board
(`GlasgowDataIO/Hardware/VacuumController/RPi5VacuumIO`).

## Why a Raspberry Pi 4 Model B (and not a Pi 5)

The SBC was changed from the Pi 5 to the **Pi 4 Model B** so the controller's OS image can be
run in QEMU before hardware arrives. Upstream QEMU has a `raspi4b` machine (QEMU 9.0 and
later) and no Raspberry Pi 5 machine (BCM2712/RP1).

What that buys, and what it does not:

| | QEMU `raspi4b` | Python emulator (`glasgow_service.emulation`) |
|---|---|---|
| Runs the real Raspberry Pi OS kernel and userspace | yes | no |
| Boot, systemd unit, Python environment, `config.txt` | yes (no firmware: dtoverlays are not applied) | `config.txt` muxing and boot rules are modelled |
| The I/O board (MCP23017, ADS1115, relays, E-stop, watchdog) | **no**, `i2cdetect` shows an empty bus | yes, register-level |
| DB235 pumps, gauges, valves | no | yes |
| Network to reach the API on :8765 | **no** upstream (no GENET); patched builds exist | yes (runs on the host) |
| RAM | 2 GiB fixed | n/a |

So controller logic is developed and tested on the Python emulator, which models both the Pi 4B and
the Pi 5; QEMU checks the OS image. See [`vacuum-emulator.md`](vacuum-emulator.md).

The RPi5VacuumIO board works unchanged on the Pi 4B: it uses only the 40-pin header, and every
pin it uses has the same function on both models. Only `config.txt` differs (below).

Prices were checked on 4 October 2026 at PiShop.us (US). Pi prices rose several times in 2026
because of LPDDR4 costs, so re-check before ordering. "est." marks a typical street price that was
not checked against a specific listing.

## Shopping list: one controller

### Core computer

| # | Item | Qty | Price (USD) | Notes |
|---|---|---|---|---|
| 1 | **Raspberry Pi 4 Model B, 2 GB** | 1 | 67.50 (in stock) | Matches QEMU `raspi4b` (2 GiB) exactly and is plenty for the SBC API (Python, FastAPI, lgpio, smbus2: well under 300 MB). The 4 GB is $100 but was out of stock; the 8 GB ($165) is only worth it if the web backend or Postgres also runs on this Pi |
| 2 | Raspberry Pi 15 W USB-C power supply (5.1 V / 3 A) | 1 | 8 est. | The Pi 4B's rated supply. USB peripherals share 1.2 A in total |
| 3 | Pi 4 case with fan (official case + fan, or a DIN-rail Pi 4 enclosure with a heatsink) | 1 | 10 - 25 est. | Rack enclosures run warm; throttling slows boot and logging. Prefer a DIN-rail mount |
| 4 | Time source | – | – | The Pi 4B has **no RTC connector**. Use NTP (`chrony`) on the control network. Vacuum-log timestamps are wrong after a power cut only until the network is back |

### Storage (see the boot plan below)

| # | Item | Qty | Price (USD) | Notes |
|---|---|---|---|---|
| 5 | **microSD: Raspberry Pi A2 card, 64 GB** (or SanDisk High Endurance 64 GB) | 1 | 39.95 | First boot, EEPROM update, and the recovery / rescue image |
| 6 | **Primary, recommended:** USB 3 SSD, e.g. Samsung T7 500 GB | 1 | 60 - 80 est. | Plug into a blue USB 3 port. Well inside the 1.2 A USB budget |
| 7 | **Alternative:** USB 3-to-SATA UASP adapter + 2.5" SATA **SSD** 250 - 500 GB | 1 + 1 | 10 + 30 - 45 est. | ASMedia or JMicron adapters generally work. Avoid a spinning HDD (see below) |

Buy **6** or **7**, not both. The M.2 HAT+ / NVMe option from the Pi 5 list does not exist for the
Pi 4B (no exposed PCIe).

### Interface to the tool

| # | Item | Qty | Price (USD) | Notes |
|---|---|---|---|---|
| 8 | **RPi5VacuumIO rev A.1 board**: fabricated PCB plus parts | 1 | board-house quote | Gerbers: `RPi5VacuumIO/fab/`; BOM with MPNs: `fab/assembly/RPi5VacuumIO-bom.csv`; mating plugs are listed there too |
| 9 | Mating plugs, ribbon cable, field cables, cabinet wiring hardware | – | 675 - 1,055 | Itemized in [Sockets, connectors and cables](#sockets-connectors-and-cables) below |
| 10 | 24 V DIN-rail PSU, 60 - 100 W (e.g. Mean Well HDR-60-24) | 1 | 20 - 30 est. | Feeds J1. Keep it separate from the Pi's USB-C supply |

The generic relay and opto modules from the first (Pi 5) list are no longer needed: the board
provides the isolated I/O, the gauge ADCs, RS-485 / RS-232, the E-stop rail and the watchdog.

### Safety chain (not optional)

| # | Item | Qty | Price (USD) | Notes |
|---|---|---|---|---|
| 12 | E-stop mushroom button (2 NC contacts) + safety relay (e.g. Pilz PNOZ s-series or Phoenix PSR) | 1 + 1 | 150 - 300 est. | Removes hazardous energy independently of Linux; one output contact goes to the board's J2 (WIRING.md step 3) |

### Commissioning extras

USB microSD reader ($3), micro-HDMI to HDMI cable ($8), Cat6 patch cable, and a USB-TTL 3.3 V
serial cable ($13), useful when the network is down. Note that with `dtoverlay=disable-bt` the
console UART on GPIO14/15 is the RS-485 port, so use SSH or HDMI for the console on the controller.

**Budget for one controller** with a 2 GB Pi 4B and a USB SSD, excluding the board fabrication:
about **$1,070 - 1,660** (Pi 5 with NVMe: about $1,180 - 1,750). About $675 - 1,055 of that is sockets,
connectors and cables, and about a quarter is the safety relay and E-stop.

## Sockets, connectors and cables

Prices checked 17 October 2026: Phoenix plugs at Mouser (single piece), Belden 8761 at PacRad (per foot);
the rest are estimates. Cable lengths assume the cabinet is about 3 m (10 ft) from each pump controller and
gauge; scale them to the real distances.

**Board mating plugs** (Phoenix Contact; not in an assembly quote, order separately):

| Part | Type | Terminals | Qty | Unit (USD) |
|---|---|---|---|---|
| 1757019 | MSTB 2,5/2-ST-5,08 | J1 24 V in | 1 | 1.81 |
| 1757022 | MSTB 2,5/3-ST-5,08 | J11–J18 relay contacts | 9 (8 + 1 spare) | 2.71 |
| 1840366 | MC 1,5/2-ST-3,5 | J2 E-stop loop | 1 | 2.34 |
| 1840379 | MC 1,5/3-ST-3,5 | J4 RS-485, J5 RS-232 | 2 | 3.52 |
| 1840382 | MC 1,5/4-ST-3,5 | J21–J24 solenoids | 4 | 4.62 |
| 1840405 | MC 1,5/6-ST-3,5 | J31–J34 digital inputs | 5 (4 + 1 spare) | 7.03 |
| 1840421 | MC 1,5/8-ST-3,5 | J41, J42 analog inputs | 2 | 9.32 |

Subtotal $107.85. The board BOM had three wrong Phoenix numbers, corrected in rev A.1's fab data:
J31–J34 plug 1840395 (a 5-position part) → 1840405; J41/J42 plug 1840411 → 1840421; J41/J42 header
1844265 (7-position) → 1844278. The PCB footprints were already right.

**Cables and wiring:**

| Item | Qty | Unit (USD) | Use |
|---|---|---|---|
| 40-way IDC ribbon, female–female, 150 mm | 1 | 3 - 5 est. | Pi header → J3, pin 1 to pin 1 |
| Cat6 patch 2 m; optional RJ45 panel / DIN feed-through | 1 + 1 | 5 - 8 / 10 - 15 est. | Network |
| Belden 8761, 1 pair 22 AWG, foil shield | 70 ft | 1.70 / ft | Gauges AI1–AI4, pump speed AI5–AI7 (7 runs) |
| Belden 3105A, 1 pair 22 AWG, 120 Ω | 30 ft | 3.2 - 4.0 / ft est. | RS-485 daisy chain board → turbo → UH1 → UH2 |
| Control cable 6 × 22 AWG shielded (e.g. LiYCY 6×0.34) | 50 ft | 1 - 2 / ft est. | Per pump: start, ready, fault, common; plus HV permissive |
| Solenoid cable 2 × 18 AWG | 80 ft | 0.40 - 0.80 / ft est. | V1–V8 |
| Sensor cable 3 × 22 AWG | 80 ft | 0.40 - 0.80 / ft est. | Valve switches, door, air, N2, water (DI9–DI16) |
| Hook-up wire 18 AWG, red / black / blue, 25 ft each | 1 lot | 20 - 30 est. | 24 V supply, E-stop loop, safety relay |
| Device-side plugs (D-sub, RJ45/FCC68 or M12, per manual) | ~10 | 5 - 15 est. | Pump controllers and gauges; confirm each against its manual |
| DE-9 female solder plug + backshell (optional) | 1 | 4 - 8 est. | J5 RS-232 gauge controller |
| Feed-through terminal blocks 2.5 mm² (Phoenix PT 2,5 or WAGO 2002-1201) + end plates, jumpers, markers | 40 + lot | 0.8 - 1.5 + 10 - 20 est. | Field cables land here, then short jumpers to the board plugs |
| DIN rail 1 m, wire duct 2 m, cable glands M16/M20 ×12 | – | 32 - 59 est. | Cabinet |
| EMC shield clamps + earth bar | 1 lot | 25 - 50 est. | 8761, 3105A and control-cable shields, cabinet end only |
| Ferrule assortment 0.25–1.5 mm² + square crimp tool | 1 + 1 | 12 - 20 / 25 - 40 est. | All stranded wire into terminals |
| Wire markers / labels | 1 lot | 10 - 15 est. | |

Board-side sockets are fitted by the assembler and are part of the board quote: J1 1757242, J11–J18 1757255,
J2 1844210, J4/J5 1844223, J21–J24 1844236, J31–J34 1844252, J41/J42 1844278, J3 2×20 shrouded box header.

## Development host (QEMU)

QEMU `raspi4b` needs **QEMU 9.0 or later**. Ubuntu 24.04 ships 8.2, which lacks it: use Debian
trixie or Ubuntu 24.10+, or build QEMU from source. Then:

```bash
xz -d 2026-xx-xx-raspios-trixie-arm64-lite.img.xz
glasgow_service/scripts/qemu/run-raspi4b.sh prepare raspios-lite-arm64.img vacuum
glasgow_service/scripts/qemu/run-raspi4b.sh run raspios-lite-arm64.img
```

## Can the Pi boot from the VirtualBox VM?

**Technically yes, but do not do it for the production vacuum controller.**

- The Pi 4B bootloader supports **network boot** (`BOOT_ORDER` mode `2`: DHCP + TFTP, then an NFS
  root). The VM could serve TFTP and NFS with `dnsmasq` and `nfs-kernel-server`.
- VirtualBox's default **NAT** adapter cannot do this. The VM needs a **Bridged** adapter on the same
  wired segment as the Pi. If the lab's DHCP server is not yours, run `dnsmasq` in proxy-DHCP mode.
- With an NFS root the controller only lives while the host PC, the VM and the network are all up. A
  pump-permissive controller has to come back by itself after a power cut with no PC in the loop.
  (The board's watchdog drops every output except the backing pump if the Pi hangs, but the
  controller should still not depend on the PC.)

**Use the VM for development, not as the boot device.** Keep it as the build and imaging host: flash
the microSD and SSD from it (USB passthrough of a card reader or the SSD), run the Python emulator
and QEMU there, and optionally netboot a *development* Pi from it.

**Production boot, in order of preference:**

1. **USB 3 SSD** (item 6). Set `BOOT_ORDER=0xf14` (USB first, then SD, then retry).
2. **USB-SATA adapter + SATA SSD** (item 7). Same `BOOT_ORDER`. Use an SSD, **not an HDD**: a
   2.5" HDD's spin-up current strains the shared 1.2 A USB budget, and a spinning disk in the rack
   adds vibration a FIB/SEM column does not need.
3. **microSD only**. Works, but SD cards wear out under continuous logging; keep it as the rescue
   image.

Set it with `sudo rpi-eeprom-config --edit`. Leave the microSD (item 5) in the slot as the rescue
system, or keep it labelled in the rack.

## `config.txt` for the I/O board

| Raspberry Pi 4 Model B | Raspberry Pi 5 |
|---|---|
| `dtparam=i2c_arm=on` | `dtparam=i2c_arm=on` |
| `enable_uart=1` | `enable_uart=1` |
| `dtoverlay=disable-bt` (full PL011 `/dev/ttyAMA0` on GPIO14/15 for RS-485; also `sudo systemctl disable hciuart`) | – |
| `dtoverlay=uart5` (RS-232 on GPIO12/13; usually `/dev/ttyAMA1`, check `ls -l /dev/ttyAMA*`) | `dtoverlay=uart4-pi5` (RS-232 on GPIO12/13, `/dev/ttyAMA4`) |

Without `disable-bt`, the Pi 4B puts the mini UART on GPIO14/15. Its baud rate follows the VPU
clock, which is not reliable enough for the turbo drives' RS-485 bus.

## Migrating to a Raspberry Pi 5 later

Nothing in the software or the PCB is tied to the Pi 4B. To move:

1. Swap the Pi, use the 27 W (5 A) supply, and optionally add the M.2 HAT+ with NVMe (`BOOT_ORDER=0xf416`).
2. Replace the two Pi 4B `config.txt` lines with `dtoverlay=uart4-pi5`.
3. In `vacuumSystem.json` set `"PiModel": "5"` and `"Serial": {"RS232": "/dev/ttyAMA4"}`.
4. Run `python -m glasgow_service.emulation --model 5 commission`, then repeat WIRING.md step 12 on
   the hardware.

## Sources

- QEMU Raspberry Pi boards (raspi4b: Cortex-A72, 2 GiB; missing PWM, PCIe, GENET): qemu.org/docs/master/system/arm/raspi.html
- Upstream raspi4b has no networking; GENET/PCIe patches not merged (qemu-devel, Aug 2026); patched build: github.com/fpgas-online/rpi-qemu
- Pi 4B prices (1 GB $35, 2 GB $67.50, 3 GB $87.35, 4 GB $100, 8 GB $165) and Pi 5 prices: pishop.us, 4 October 2026
- Boot modes, `BOOT_ORDER`, USB current limits, UART overlays: Raspberry Pi documentation (computers/raspberry-pi: boot, eeprom-bootloader, power-supplies, configuration/uart)
- Official microSD 64 GB $39.95: pishop.us (September 2026)
