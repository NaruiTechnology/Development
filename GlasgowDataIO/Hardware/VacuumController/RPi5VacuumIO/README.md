# RPi5 Vacuum Controller I/O board (rev A.1)

This is the interface board between a **Raspberry Pi 5** and the **FEI DB235 vacuum system**:

- the four pumps shown on the SBC Vacuum Controller dashboard: `MechanicalVacuumPump`, `TurboVacuumPump`, and the UH stage `UHVacuumPump_1` / `UHVacuumPump_2` (turbomolecular pumps);
- the vacuum gauges;
- the valves and pneumatic cylinders;
- the high-voltage permissive;
- the E-stop.

Step-by-step device wiring is in **[WIRING.md](WIRING.md)**.

The Pi runs `glasgow_service.sbc_vacuum_app`. This board gives it isolated, fail-safe I/O. The service talks to it through `glasgow_service/vacuum_io_board.py`.

```
 Raspberry Pi 5 ──40-way ribbon──> J3 ─┬─ I2C ─ MCP23017 0x20 ─┬─ ULN2803A ─ K1..K8 relays  ─> pump / HV permissive contacts
                                       │                       └─ AO3400A x8 ─ V1..V8        ─> 24 V valve & cylinder solenoids
                                       ├─ I2C ─ MCP23017 0x21 ─── TLP291-4 x4 ─ DI1..DI16    <─ pump status, valve/cylinder switches
                                       ├─ I2C ─ ADS1115 x2 ─────── 68k/22k ─── AI1..AI8      <─ 0-10 V gauges, pump analog outputs
                                       ├─ UART0 ─ MAX3485 ──────── RS-485                    <─> turbo / gauge controller
                                       ├─ UART4 ─ MAX3232 ──────── RS-232                    <─> gauge controller
                                       └─ GPIO19 heartbeat ─ charge pump ─ K10 ─┐
 24 VDC ─ fuse ─ K9 (E-stop loop J2) ─ +24V_ESTOP ──────────────────────────────┴─ +24V_SAFE ─> solenoids, relay coils
```

## Channel counts

| Function | Channels | Hardware |
|---|---|---|
| Relay outputs | 8 × SPDT, 10 A contacts, COM/NO/NC on pluggable terminals | Omron G5LE-1 24 V, driven by ULN2803A |
| Solenoid outputs | 8 × 24 V low-side switches, up to 1 A each (fused 4 A total), flyback diodes, LED per channel | AO3400A MOSFETs |
| Digital inputs | 16 × opto-isolated 24 V, 4 groups with separate commons, LED per channel | TLP291-4 |
| Analog inputs | 8 × 0–10.5 V, 16-bit, clamped, about 90 Hz filter | ADS1115 × 2 |
| Serial | 1 × RS-485 (termination jumper, fail-safe bias, TVS); 1 × RS-232 | MAX3485, MAX3232 |
| Safety | E-stop loop input, heartbeat watchdog, rail status readback to the Pi | K9, K10, TLP291-4 |

## Channel map (matches the software)

The pumps, their order and their A/B channels are exactly those of `glasgow_service` and `vacuumSystem.json`, as shown on the SBC Vacuum Controller dashboard. The cascade is: `MechanicalVacuumPump` → `TurboVacuumPump` → the UH pump group (`UHVacuumPump_1`, `UHVacuumPump_2`).

| Software device | Output (A) → relay | Ready input (B) → DI | Fault input | Gauge (numeric value) | Speed / analog | Serial |
|---|---|---|---|---|---|---|
| `MechanicalVacuumPump` | A0 → **K1** | B0 → **DI1** (running / pressure OK) | DI5 | AI1 (fore-line Pirani) | – | – |
| `TurboVacuumPump` | A1 → **K2** | B1 → **DI2** (at normal speed) | DI6 | AI2 (chamber gauge) | AI5 | RS-485 J4, address 1 |
| `UHVacuumPump_1` (turbo) | A2 → **K3** | B2 → **DI3** (at normal speed) | DI7 | AI3 | AI6 | RS-485 J4, address 2 |
| `UHVacuumPump_2` (turbo) | A3 → **K4** | B3 → **DI4** (at normal speed) | DI8 | AI4 | AI7 | RS-485 J4, address 3 |
| `HighVoltageTransformer` | A4 → **K5** (HV permissive) | – | – | – | – | – |

The same map is printed on the back silkscreen. It is also in `GlasgowDataIO/Json/vacuumSystem.rpi5-io.example.json`.

### Remaining channels

| Channel | Suggested use |
|---|---|
| K6 | Full-range / cold-cathode gauge HV on |
| K7, K8 | Spare (for example an alarm beacon) |
| V1 | Roughing / fore-line valve (mechanical pump → turbo fore-lines) |
| V2 | Chamber gate valve (TurboVacuumPump inlet), pneumatic |
| V3 | Vent valve (dry N2) |
| V4 | UH stage isolation valve 1 (UHVacuumPump_1 inlet), pneumatic |
| V5 | UH stage isolation valve 2 (UHVacuumPump_2 inlet), pneumatic |
| V6 | Bypass / chamber roughing valve |
| V7 | Pneumatic cylinder (for example a load-lock or clamp) |
| V8 | Spare |
| DI9, DI10 | V2 open / closed position switches |
| DI11, DI12 | V4 open / closed position switches |
| DI13 | Chamber door closed |
| DI14 | Compressed air OK |
| DI15 | N2 vent gas OK |
| DI16 | Cooling water flow OK |
| AI8 | Spare |

The controller software today sequences the pumps and the HV permissive: A0–A4, B0–B3 and the per-pump gauges. The fault, valve, cylinder and utility channels are wired and readable, but automatic valve sequencing is not in the software yet.

## Fail-safe behaviour

| Condition | Result |
|---|---|
| Pi off, booting, or the service not started | GPIO22 is low, so both MCP23017s are held in reset. Every driver input is pulled down, and all relays and solenoids are **off**. |
| Pi or service hangs, crashes or reboots | The GPIO19 heartbeat stops. The charge pump blocks DC, so a pin stuck high or low looks the same. K10 drops in about 100 ms and **+24V_SAFE is removed**: all solenoids and every relay on the SAFE rail go off. |
| The service is alive but its control loop stops polling | The driver's keep-alive stops the heartbeat after 3 s, with the same result as above. |
| E-stop loop opened | K9 drops and **+24V_ESTOP and +24V_SAFE are both removed**. That means everything, including K1. |
| Rail status | GPIO5 (`ESTOP_OK_N`) and GPIO6 (`SAFE_OK_N`) let the software see both rails. |

**JP1–JP8** choose each relay coil's rail. By default K1 (the mechanical pump) runs from +24V_ESTOP, so the backing pump keeps running if the Pi hangs; it stops only on E-stop. K2–K8 run from +24V_SAFE. Move a jumper (cut the 1–2 bridge, bridge 2–3) to change a channel.

Valves must be **normally closed** (spring return) for "rail off = safe" to hold. If a normally-open valve is used, its safe state is open; check that this is acceptable.

K9 is a general-purpose relay, not a certified safety relay. For a category-rated E-stop, wire the output contacts of a safety relay (for example Pilz PNOZ or Phoenix PSR) into J2, and let that safety relay also remove power from the tool's own pump controllers.

Relay contacts are for the **permissive / remote-start inputs** of the tool's own pump controllers. They are not for switching pump motor mains. The PCB is laid out for low-voltage wiring.

## Connectors

| Ref | Where | Pins |
|---|---|---|
| J1 | left edge, Phoenix MSTBA 5.08 | `+24V`, `0V`. 24 VDC 2–4 A (DIN-rail PSU) |
| J2 | left edge, Phoenix MC 3.5 | E-stop NC loop: `ESTOP` (+24V_AUX out) and `LOOP` (return to K9 coil) |
| J3 | 2×20 box header | Ribbon to the Pi 5 40-pin header (pin 1 to pin 1). The Pi's 5 V pins are **not** connected, so power the Pi from its own USB-C supply |
| J11–J18 | top edge, MSTBA 5.08 | K1–K8 `COM`, `NO`, `NC` |
| J21–J24 | bottom edge, MC 3.5 | Two solenoids per connector: `+24`, `Vn-`, `+24`, `Vn+1-` |
| J31–J34 | bottom edge, MC 3.5 | Four inputs, then `COM` (0 V of that group), then `+24` (sensor supply, 0.5 A PTC). An input is active when 24 V is applied between DIn and COM |
| J41, J42 | right edge, MC 3.5 | `AIn` / `0V` pairs, 0–10.5 V |
| J4 | right edge, MC 3.5 | RS-485 `A`, `B`, `GND`. Bridge JP9 for 120 Ω termination |
| J5 | right edge, MC 3.5 | RS-232 `TXD` (out), `RXD` (in), `GND` |

## Raspberry Pi pins used

| BCM | Header pin | Function |
|---|---|---|
| 2 / 3 | 3 / 5 | I2C1 SDA / SCL |
| 14 / 15 | 8 / 10 | UART0 TX / RX → RS-485 |
| 18 | 12 | RS-485 driver enable |
| 12 / 13 | 32 / 33 | UART4 TX / RX → RS-232 (`dtoverlay=uart4-pi5`) |
| 19 | 35 | Watchdog heartbeat (1 kHz PWM) |
| 22 | 15 | `IO_RESET_N` (expanders held in reset while low) |
| 27 | 13 | Input change interrupt |
| 23 | 16 | ADC ALERT/RDY |
| 5 / 6 | 29 / 31 | `ESTOP_OK_N` / `SAFE_OK_N` (low = OK) |
| 26 | 37 | RUN LED |

Add `dtparam=i2c_arm=on`, `enable_uart=1`, `dtoverlay=uart4-pi5` to `/boot/firmware/config.txt`.

## Software configuration

In `vacuumSystem.json`, replace the `SBC.GPIO` map with a board map:

```json
"SBC": {
  "Id": "rpi5-vacuum-io",
  "Board": "RPi5VacuumIO-A",
  "Channels": {"A0": "K1", "A1": "K2", "A2": "K3", "A3": "K4", "A4": "K5",
               "B0": "DI1", "B1": "DI2", "B2": "DI3", "B3": "DI4"},
  "Gauges": {"B0": {"AIN": "AI1", "Law": "log", "Slope": 1.0,   "Offset": -5.5},
             "B1": {"AIN": "AI2", "Law": "log", "Slope": 1.667, "Offset": -11.33},
             "B2": {"AIN": "AI3", "Law": "log", "Slope": 1.667, "Offset": -11.33},
             "B3": {"AIN": "AI4", "Law": "log", "Slope": 1.667, "Offset": -11.33}}
}
```

`Law: "log"` computes p = 10^(Slope·U + Offset). The example values are the Pfeiffer PKR 251 law in mbar. `Law: "linear"` computes p = Slope·U + Offset. Readings outside 0.5–10 V are reported as unknown (sensor error or not connected). Install the extras with `pip install -e '.[sbc]'`, which adds `smbus2`.

## PCB and files

The board is 195 × 160 mm, 2 layers, 1.6 mm FR-4, 1 oz copper, with a GND pour on both sides. Tracks are 0.2 mm for signals (0.15 mm minimum clearance), 0.8 mm for the 24 V rails, 0.6 mm for coil and solenoid lines, and 1.0 mm for relay contacts (with 1.0 mm clearance). Vias are 0.6/0.3 mm. All of this is within any standard 2-layer service.

| Path | Content |
|---|---|
| `RPi5VacuumIO.kicad_pro/.kicad_sch/.kicad_pcb` | KiCad project (KiCad 7 format; opens in KiCad 7–10) |
| `fab/RPi5VacuumIO-gerbers.zip` | Upload to the board house (Gerber X2 + Excellon) |
| `fab/*-bom.csv`, `fab/*-pos.csv` | BOM with MPNs and the pick-and-place file |
| `fab/*-schematic.pdf`, `fab/*.step`, `fab/*-drc.rpt` | Schematic print, 3D model, DRC report |
| `tools/` | Generators (`design.py` is the source of truth), `build.sh`, `make_fab_kicad10.ps1` |

To regenerate on Windows with KiCad 10, run `powershell -ExecutionPolicy Bypass -File .\tools\make_fab_kicad10.ps1` from this folder. On Linux, run `tools/build.sh`.
