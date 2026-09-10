# Glasgow Rev C3 Vacuum Wafer Stage Interface

This directory is the first-pass hardware specification for the ion-beam DUT stage.

Target application:
- UHV or high-vacuum wafer positioning
- 300 mm travel
- 12 inch wafer load
- micron-class positioning target

## Architecture decision

Do not implement this as a bare open-loop stepper axis.
For this class of motion the safer implementation is:

1. Glasgow rev C3 generates low-level motion commands.
2. A small interface PCB buffers control signals and carries interlocks.
3. The motor drive stays outside the vacuum envelope when possible.
4. Position feedback comes from a linear encoder.
5. The actual closed-loop motion controller lives on the driver/controller side, not in the vacuum chamber.

If the stage itself must move in vacuum, use UHV-compatible mechanics and keep the motor and heat sources outside the chamber through a feedthrough or bellows coupling.

## Board role

This board is a control and conditioning layer, not a motor-coil power stage.
It provides:

- STEP / DIR / EN command routing
- encoder signal conditioning
- interlock and fault lines
- connectorization for vacuum feedthrough wiring

## Recommended connectors

### J1 - Glasgow control input

Pin order:

1. `STEP`
2. `DIR`
3. `EN`
4. `GND`

### J2 - External driver output

Pin order:

1. `STEP_OUT`
2. `DIR_OUT`
3. `EN_OUT`
4. `GND`

### J3 - Encoder input

Pin order:

1. `A+`
2. `A-`
3. `B+`
4. `B-`
5. `Z+`
6. `Z-`
7. `+5V_ENC`
8. `GND`

### J4 - Encoder output to controller

Pin order:

1. `ENC_A`
2. `ENC_B`
3. `ENC_Z`
4. `GND`

### J5 - Interlock chain

Pin order:

1. `ESTOP_CHAIN`
2. `CHAMBER_OK`
3. `DRIVER_FAULT`
4. `GND`

## Suggested active parts

- `U1`: `74HCT14` or equivalent Schmitt inverter used as a double-inversion buffer for `STEP`, `DIR`, `EN`
- `U2`: `AM26LS32` or equivalent RS-422 differential line receiver for encoder A/B/Z
- `C1`, `C2`: 100 nF decoupling capacitors close to each IC
- `C3`: 10 uF bulk decoupling near the connector cluster
- `R1` to `R3`: optional series resistors on the command outputs
- `R4` to `R6`: optional differential termination pads for encoder pairs

## Layout notes

- Keep encoder traces short and routed as differential pairs.
- Keep encoder routing away from the command lines and any motor power wiring.
- Put the interlock connector at the board edge.
- Use a solid ground plane and tie cable shield to the chassis strategy used by the vacuum rack.
- If the encoder uses single-ended TTL instead of differential RS-422, stuff the alternate receiver footprint instead of changing the rest of the board.

## JSON source of truth

The configuration file for this design is:

- `../../../Json/vacuum_wafer_stage_c3.json`

That JSON keeps the low-level STEP/DIR/EN compatibility fields and adds the vacuum-stage metadata, encoder interface, and interlock definitions.

## Scope boundary

This board is intended to support a precision vacuum stage, not a generic desktop stepper motor.
If a different stage model is selected later, keep the connector contract and update only the encoder scale, current limit, interlock wiring, and mechanical feedthrough details.
