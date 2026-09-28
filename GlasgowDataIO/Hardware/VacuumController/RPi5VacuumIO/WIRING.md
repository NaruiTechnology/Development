# Wiring guide: RPi5 Vacuum Controller I/O board (rev A.1)

This guide wires the board to a Raspberry Pi 5 and to the vacuum devices that the software controls. Those are the devices on the **SBC Vacuum Controller** dashboard:

```
 MechanicalVacuumPump  ──►  TurboVacuumPump  ══►  UH PUMPS (grouped stage)
      A0 → B0                  A1 → B1              UHVacuumPump_1   A2 → B2
                                                     UHVacuumPump_2   A3 → B3
                                                 + HighVoltageTransformer A4 (interlocked on vacuum ready)
```

Each software channel `An` is an output (the board turns a pump **on**). Each channel `Bn` is the pump's **ready** input (the controller moves to the next stage). The guide also covers the gauges, valves, pneumatic cylinders, E-stop and serial links.

> **Before you start**
> - Work with the 24 V supply and the tool's own pump controllers switched off and locked out.
> - The board grants **permissives**. It must never bypass the DB235's own interlocks, and it never switches pump motor mains power. Relay contacts go only to the *remote / enable* inputs of the pump controllers, or to the coil of a separately installed, rated contactor.
> - The pin names of the tool's pump controllers, gauges and valves vary by make and model. Confirm every tool-side terminal against the DB235 service manual and each controller's manual before connecting.
> - Keep `"Simulate": true` until step 12 (commissioning) is complete.

---

## 0. Tools and materials

| Item | Specification |
|---|---|
| 24 V field wiring (supply, solenoids, E-stop) | 0.75–1.0 mm² (AWG 18) stranded, with ferrules |
| Signal wiring (inputs, relay contacts to controller remote inputs) | 0.25–0.5 mm² (AWG 22–20) stranded, with ferrules |
| Gauge / analog signals | Shielded twisted pair, 0.25 mm² (for example Belden 8761 or LiYCY 2×0.25) |
| RS-485 | Shielded twisted pair, 120 Ω (for example Belden 3105A) |
| Mating plugs | Phoenix MSTB 2,5/…-ST-5,08 (J1, J11–J18) and MC 1,5/…-ST-3,5 (all others). Part numbers are in `fab/RPi5VacuumIO-bom.csv` |
| Ferrules and crimp tool, 2.5 mm flat screwdriver, multimeter | – |
| 40-way IDC ribbon cable, 15–20 cm, female–female | Pi header to J3 |

Plug-in terminals are numbered **1 → n from the pin with the ▷ marker** (the square pad). The silkscreen next to each terminal prints its signal names.

---

## 1. Mount the board and plan the cabinet

1. Mount the board on M3 standoffs or a DIN-rail PCB carrier (four M3 holes, 3.5 mm from each corner). Leave about 25 mm clearance above the relays.
2. Put the Raspberry Pi 5 next to J3, so the 40-way ribbon is at most 20 cm long.
3. Suggested DIN-rail order:
   - E-stop safety relay;
   - 24 V PSU;
   - 5 V/USB-C supply for the Pi;
   - this board;
   - terminal blocks for the tool-side cables.
4. Route the 24 V power and solenoid wiring along one side of the board (J1, J2, bottom edge). Route gauge and RS-485 cables along the other side (right edge). Keep them apart.

---

## 2. 24 V DC supply → J1 (left edge, `24VDC IN`)

| J1 pin | Silk | Connect to |
|---|---|---|
| 1 | `+` | 24 V PSU **+V** |
| 2 | `-` | 24 V PSU **−V (0 V)** |

- Use a 60–100 W DIN-rail PSU (for example Mean Well HDR-60-24).
- The board has a 4 A slow-blow fuse (F1), reverse-polarity protection and a surge clamp.
- Bond the PSU **0 V** to the cabinet protective earth at **one** point (the PSU's 0 V terminal). The board's 0 V is also the Pi's ground through the ribbon.
- Check: with J1 powered, green LED **D3** (24 V) is on. **D9** (E-stop rail) and **D10** (output rail) stay off until steps 3 and 12.

---

## 3. E-stop loop → J2 (left edge, `E-STOP NC LOOP`)

J2 powers relay K9. K9 feeds the **+24V_ESTOP** rail, which in turn feeds everything the board switches.

| J2 pin | Silk | Function |
|---|---|---|
| 1 | `1` | +24 V out (fused 0.5 A, F2) |
| 2 | `2` | Loop return to the K9 coil |

**Option A: plain E-stop buttons (bench and commissioning only).** Wire all E-stop NC contacts in series between J2-1 and J2-2.

**Option B: with a safety relay (required for the tool).**
1. Wire the E-stop buttons to the safety relay's input channels, following the safety relay's manual. That gives dual-channel monitoring, with a manual reset.
2. Wire one safety-relay **output contact** (for example 13–14) between **J2-1 and J2-2**.
3. Wire a second safety-relay output contact into the **tool's own** pump / HV controller enable chain, so hazardous energy is removed even if this board or Linux misbehaves.

Check: close the loop, and yellow **D9** comes on. Open any E-stop, and D9 goes off.

---

## 4. Raspberry Pi 5 → J3 (ribbon)

1. With everything unpowered, plug the 40-way ribbon into the Pi's GPIO header and into **J3**. Line up **pin 1** on both ends: the red stripe on the ribbon, the square pad and ▲ marker on J3, and the pin nearest the SD card on the Pi.
2. Power the Pi from its **own** 27 W USB-C supply. The board's J3 deliberately leaves the Pi 5 V pins unconnected; it draws only 3.3 V logic power from the Pi.
3. On the Pi, add these lines to `/boot/firmware/config.txt`, then reboot:
   ```
   dtparam=i2c_arm=on
   enable_uart=1
   dtoverlay=uart4-pi5
   ```
4. Run `sudo apt install i2c-tools` then `i2cdetect -y 1`. It must show **20, 21, 48, 49**.

---

## 5. Pump outputs → J11–J14, and the HV permissive → J15 (top edge)

Each relay terminal is `COM | NO | NC` (the silkscreen above the terminal prints `NC NO COM` from left to right, because pin 1 = COM is on the right).

| Terminal | Relay | Software device | Wire to |
|---|---|---|---|
| J11 | K1 | `MechanicalVacuumPump` (A0) | Mechanical pump remote-enable input |
| J12 | K2 | `TurboVacuumPump` (A1) | Turbo pump controller remote "start / pumping station ON" input |
| J13 | K3 | `UHVacuumPump_1` (A2) | UH pump 1 (turbo) controller remote start input |
| J14 | K4 | `UHVacuumPump_2` (A3) | UH pump 2 (turbo) controller remote start input |
| J15 | K5 | `HighVoltageTransformer` (A4) | Tool HV interlock / HV-enable permissive input |
| J16 | K6 | spare (suggested: gauge HV on) | – |
| J17, J18 | K7, K8 | spare | – |

### 5a. Pump controller with a remote start input (turbo controllers, most modern pumps)

```
 controller "+24 V out" (or "remote common") ──── COM  (Jxx pin 1)
 controller "START / REMOTE ON" input ──────────── NO   (Jxx pin 2)
```

- The relay contact closes when the software turns the pump on. It is a potential-free contact, so it works whether the controller expects 24 V or a contact closure.
- If the controller's manual says its remote start must be **held closed to run** (the usual case), use NO as shown. If it needs a **pulse**, don't use this board directly; ask for a pulse mode in the software first.
- Set the controller to **remote** (not local / front-panel) control mode. The turbo controller's own protections (fore-vacuum monitoring, over-temperature) stay active.

### 5b. Mechanical pump with only a mains switch

**Do not** run pump mains power through the board. Have a qualified electrician install a rated motor contactor (24 V DC coil) with motor protection:

```
 +24 V (from J1 supply) ── K1 COM (J11-1)
 K1 NO (J11-2) ──────────── contactor coil A1
 contactor coil A2 ───────── 0 V
```

K1 then only switches the 24 V contactor coil (under 0.5 A).

### 5c. HV permissive (K5 → J15)

Put K5's NO contact **in series** with the tool's HV enable / interlock loop (J15-1 COM and J15-2 NO). HV can then only be enabled when the software has granted it. The software only closes K5 once the whole vacuum cascade reports ready, and it opens K5 on any loss of vacuum. The tool's own HV interlocks stay in series and in charge.

### Rail selection (JP1–JP8)

- **K1** (mechanical pump) runs from the **E-stop rail**. The backing pump keeps running if the Pi hangs or reboots, so the turbo pumps are never left without backing, and it stops only on E-stop.
- **K2–K8** run from the **watchdog rail**, which drops about 100 ms after the Pi stops its heartbeat.
- To change a channel, cut the solder bridge between pads 1–2 of JPn and bridge pads 2–3.

---

## 6. Pump ready and fault inputs → J31, J32 (bottom edge)

Inputs are opto-isolated 24 V inputs in groups of four. Each 6-pin plug is `DIa | DIb | DIc | DId | COM | +24`.

- **COM** is the 0 V return for that group of four.
- **+24** is a fused 24 V sensor supply.
- An input is **ON when 18–30 V is applied between DIn and COM**, drawing about 4.5 mA. A green LED next to each input shows its state.

### J31: pump ready inputs (the software's B channels)

| J31 pin | Input | Software | Signal from the device |
|---|---|---|---|
| 1 | DI1 | `B0` MechanicalVacuumPump ready | Pump running / fore-vacuum OK contact |
| 2 | DI2 | `B1` TurboVacuumPump ready | Turbo "normal speed reached / at speed" output |
| 3 | DI3 | `B2` UHVacuumPump_1 ready | UH pump 1 "at speed" output |
| 4 | DI4 | `B3` UHVacuumPump_2 ready | UH pump 2 "at speed" output |
| 5 | COM | – | 0 V of the 24 V supply (or of the device's supply, see 6b) |
| 6 | +24 | – | Sensor / contact supply |

### J32: pump fault inputs (wired "healthy = ON")

| J32 pin | Input | Device |
|---|---|---|
| 1 | DI5 | MechanicalVacuumPump fault / thermal relay |
| 2 | DI6 | TurboVacuumPump error output |
| 3 | DI7 | UHVacuumPump_1 error output |
| 4 | DI8 | UHVacuumPump_2 error output |
| 5 | COM | 0 V |
| 6 | +24 | Contact supply |

Wire the fault inputs so the input is **ON while the device is healthy**. Use the controller's "no error" contact, which is closed when OK. A broken wire then reads as a fault.

### How to wire each kind of device output

**6a. Potential-free (dry) relay contact.** This is preferred, and it is what most pump controllers provide.
```
 J3x pin 6 (+24) ── device contact ── J3x pin n (DIn)
 J3x pin 5 (COM) ── 0 V of the board's 24 V supply (J1 pin 2)
```

**6b. PNP / 24 V sourcing output** (the output drives +24 V when active):
```
 device output ───── DIn
 device 0 V ──────── COM of that group
```
All devices wired into the same group must share that 0 V. If they have separate supplies, bond their 0 V lines, or use their dry contacts instead.

**6c. NPN / open-collector (sinking) output.** This can't be wired per channel, because COM is shared by the group. Use a small 24 V interposing relay: the NPN output switches the relay coil, and the relay contact is wired as in 6a.

**6d. 3-wire proximity / reed sensor (PNP):** brown → `+24`, blue → `COM`, black → `DIn`.

---

## 7. Valves and pneumatic cylinders → J21–J24 (bottom edge)

Each 4-pin plug carries two solenoid outputs: `+24 | V(n)− | +24 | V(n+1)−`.

- Connect each 24 V DC solenoid coil between its `+24` pin and its `Vn−` pin.
- Outputs are low-side MOSFET switches, fed from the **watchdog rail**. They turn off on E-stop, on a Pi hang, and whenever the service is stopped.
- Up to **1 A per coil**, 4 A total board fuse.
- Flyback diodes are on the board, so use plain coils or connectors without their own diode. Coils with a built-in LED or diode are fine if they are wired with the correct polarity (+ to `+24`).
- A yellow LED per output shows it is energised.

| Terminal / pins | Output | Suggested device (confirm against the DB235 vacuum diagram) |
|---|---|---|
| J21 1–2 | V1 | Roughing / fore-line valve |
| J21 3–4 | V2 | Chamber gate valve (TurboVacuumPump inlet), pneumatic |
| J22 1–2 | V3 | Vent valve (dry N2) |
| J22 3–4 | V4 | UH stage isolation valve 1 (UHVacuumPump_1 inlet), pneumatic |
| J23 1–2 | V5 | UH stage isolation valve 2 (UHVacuumPump_2 inlet), pneumatic |
| J23 3–4 | V6 | Bypass / chamber roughing valve |
| J24 1–2 | V7 | Pneumatic cylinder (for example a load-lock or clamp) |
| J24 3–4 | V8 | Spare |

### Pneumatic valves and cylinders

- Use **normally-closed, spring-return** valves (3/2 NC, or 5/2 monostable for double-acting cylinders), so that "power off" means **closed / retracted**.
- A 5/2 bistable (two-coil) valve holds its last position on power loss. Use it only where that is the safe behaviour, with one output per coil.
- Wire the cylinder's position reed switches to J33 (step 8). The controller can then check the valve really moved.

---

## 8. Valve positions, door and utilities → J33, J34 (bottom edge)

Wire these the same way as step 6 (dry contacts preferred; PNP sensors as in 6d).

| Terminal pin | Input | Suggested signal |
|---|---|---|
| J33-1 | DI9 | V2 chamber valve **open** switch |
| J33-2 | DI10 | V2 chamber valve **closed** switch |
| J33-3 | DI11 | V4 UH isolation valve **open** switch |
| J33-4 | DI12 | V4 UH isolation valve **closed** switch |
| J33-5 / 6 | COM / +24 | – |
| J34-1 | DI13 | Chamber door closed |
| J34-2 | DI14 | Compressed air pressure OK (pressure switch) |
| J34-3 | DI15 | N2 vent gas OK |
| J34-4 | DI16 | Cooling water flow OK (flow switch) |
| J34-5 / 6 | COM / +24 | – |

---

## 9. Vacuum gauges and pump analog outputs → J41, J42 (right edge)

Each 8-pin plug is `AI | 0V` pairs. The pin with the ▷ marker (pin 1) is at the **bottom** of the vertical connector.

- Inputs accept **0–10.5 V** with about 90 kΩ input impedance, 16-bit resolution, and are protected to ±30 V.
- 4–20 mA current outputs need a 500 Ω, 0.1 % resistor across AI–0V, giving 2–10 V.

| Terminal pins | Input | Software | Signal |
|---|---|---|---|
| J41 1 / 2 | AI1 / 0V | `Gauges.B0` → MechanicalVacuumPump value | Fore-line Pirani gauge analog output |
| J41 3 / 4 | AI2 / 0V | `Gauges.B1` → TurboVacuumPump value | Chamber full-range / cold-cathode gauge output |
| J41 5 / 6 | AI3 / 0V | `Gauges.B2` → UHVacuumPump_1 value | UH stage 1 gauge output |
| J41 7 / 8 | AI4 / 0V | `Gauges.B3` → UHVacuumPump_2 value | UH stage 2 gauge output |
| J42 1 / 2 | AI5 / 0V | – | TurboVacuumPump speed / current analog output |
| J42 3 / 4 | AI6 / 0V | – | UHVacuumPump_1 speed analog output |
| J42 5 / 6 | AI7 / 0V | – | UHVacuumPump_2 speed analog output |
| J42 7 / 8 | AI8 / 0V | – | Spare |

Wiring rules:

1. Use one **shielded twisted pair** per gauge: signal to `AIn`, the gauge controller's **signal ground** to the matching `0V`.
2. Connect the shield to protective earth at **one end only**, normally the board / cabinet end. Leave the far end insulated.
3. Don't share a gauge's analog ground with a solenoid or motor return.
4. Then set each gauge's conversion law in `vacuumSystem.json` → `SBC.Gauges` (see step 11). The numbers on the dashboard ("Real-time value") come from these inputs.

---

## 10. Serial links → J4 (RS-485) and J5 (RS-232) (right edge)

### J4: RS-485 to the three turbo pump controllers (multi-drop)

| J4 pin | Silk | Connect |
|---|---|---|
| 1 | `485A` | A (D+ / "RS485+") of every controller |
| 2 | `485B` | B (D− / "RS485−") of every controller |
| 3 | `GND` | Signal ground of every controller (the third conductor or the shield drain) |

1. Daisy-chain the bus: board → `TurboVacuumPump` controller → `UHVacuumPump_1` controller → `UHVacuumPump_2` controller. No star wiring, and stubs under 0.3 m.
2. Give each controller a unique RS-485 address: suggested 1, 2, 3 respectively.
3. Termination: bridge **JP9** on the board (it's at one end of the bus), and enable or fit the 120 Ω terminator at the **last** controller only.
4. Set all controllers to the same baud rate and format (commonly 9600 8N1; check each controller's manual).
5. On the Pi this bus is `/dev/ttyAMA0` (UART0). The driver enable (GPIO18) is handled by the software.

If the A/B naming on a controller is ambiguous and nothing responds, swap A and B at that controller. It does no harm.

### J5: RS-232 to a gauge controller (optional)

| J5 pin | Silk | Connect to the device's DE-9 |
|---|---|---|
| 1 | `232TX` (board transmits) | Device **RXD** (DE-9 pin 2 on a DTE device / pin 3 on DCE; check its manual) |
| 2 | `232RX` (board receives) | Device **TXD** |
| 3 | `GND` | Device signal ground (DE-9 pin 5) |

On the Pi this port is UART4 (`/dev/ttyAMA4`).

---

## 11. Software configuration

1. Copy `GlasgowDataIO/Json/vacuumSystem.rpi5-io.example.json` over the controller's `vacuumSystem.json`. Keep `"Simulate": true` for now. The example already maps the dashboard devices to the board:
   ```json
   "Channels": {"A0": "K1", "A1": "K2", "A2": "K3", "A3": "K4", "A4": "K5",
                "B0": "DI1", "B1": "DI2", "B2": "DI3", "B3": "DI4"},
   "Gauges":   {"B0": {"AIN": "AI1", ...}, "B1": {"AIN": "AI2", ...},
                "B2": {"AIN": "AI3", ...}, "B3": {"AIN": "AI4", ...}}
   ```
2. For each gauge, set `Law`, `Slope` and `Offset` from the gauge manual:
   - `log`: p = 10^(Slope·U + Offset);
   - `linear`: p = Slope·U + Offset.

   The example values are a Pirani curve (Slope 1, Offset −5.5) and a full-range curve (Slope 1.667, Offset −11.33), both in mbar.
3. Set each pump's `value` (the threshold on the dashboard) to the pressure at which the next stage may start.
4. Install the service with `pip install -e '.[sbc]'`. That adds `smbus2`.

---

## 12. Commissioning (do this before connecting the tool)

Do steps 1–4 with **all tool-side plugs unplugged** except J1 (24 V), J2 (E-stop) and J3 (Pi).

| # | Action | Expected |
|---|---|---|
| 1 | Power 24 V, E-stop closed, Pi off | D3 on, D9 on, **D10 off**, all relay/solenoid LEDs off |
| 2 | Boot the Pi, service **not** running | Same as 1: outputs stay off, D10 off |
| 3 | Start the service with `"Simulate": false` | D10 (output rail) and the blue RUN LED come on. `MechanicalVacuumPump` K1 LED comes on (the cascade starts the mechanical pump) |
| 4 | Using a jumper wire from J31-6 (+24) to J31-1 (DI1) | DI1 LED on. Dashboard: MechanicalVacuumPump ready. **K2** (TurboVacuumPump) turns on |
| 5 | Jumper +24 to DI2 | K3 and K4 (UH pumps) turn on |
| 6 | Jumper DI3 and DI4 | All four ready. HV permissive K5 can be enabled from the UI |
| 7 | Remove the DI2 jumper | K3, K4 and K5 drop at once (loss of turbo ready). K1 stays on |
| 8 | Open the E-stop | D9 and D10 off; **every** relay and valve drops, including K1 |
| 9 | Close the E-stop, then `sudo systemctl stop sbc-vacuum` | D10 drops within about 0.1 s. K2–K8 and all valves off; K1 stays on its E-stop rail |
| 10 | Check each gauge input with a 0–10 V source or the gauge itself | Dashboard "Real-time value" follows the gauge |
| 11 | Plug in the tool-side connectors one device at a time, and repeat the relevant check with the real device | – |

Record the results, then keep a copy of `vacuumSystem.json` with the commissioned values.

---

## 13. Troubleshooting

| Symptom | Check |
|---|---|
| `i2cdetect` shows nothing | Ribbon orientation (pin 1); `dtparam=i2c_arm=on`; the Pi powered on |
| D10 never comes on | E-stop closed (D9 on)? Service running? The heartbeat is GPIO19; `pinctrl get 19` should show PWM / toggling |
| An input LED is on but the dashboard shows not ready | Channel map in `SBC.Channels`; COM of that group returned to the device's 0 V |
| An input LED never lights | 24 V actually present between DIn and COM; a PNP vs NPN device (see 6c) |
| Gauge reads unknown (null) | Voltage outside 0.5–10 V (sensor off or error); wiring AI/0V swapped; `Gauges` map |
| RS-485 no response | A/B swapped; address / baud; JP9 and the far-end terminator; common GND wire |
| A relay clicks but the pump doesn't start | Controller not in remote mode; contact wired to the wrong remote pin (NO vs NC) |
