# Adapting the rev C3 stepper carrier to different motors

This carrier is intentionally generic. The FPGA side always stays the same:

- `STEP`
- `DIR`
- `EN`

What changes between motors is the external driver setup and the motion timing.

## What the carrier does not do

The carrier does not drive motor coils directly.
It only presents control lines to a stepper driver module such as:

- A4988
- DRV8825
- TMC2209
- TMC2208
- similar `STEP/DIR/EN` drivers

If your motor does not use a step/dir driver, you need a different power stage.

## What you tune in JSON

Use [`/home/vboxuser/Project/Operations/Development/GlasgowDataIO/Json/stepper_c3_generic.json`](/home/vboxuser/Project/Operations/Development/GlasgowDataIO/Json/stepper_c3_generic.json) as the starting point.

The knobs that matter are:

- `pins.step`, `pins.dir`, `pins.en`
- `pins.*.invert`
- `timing.pulseHighUs`
- `timing.defaultPeriodUs`
- `timing.minimumPeriodUs`

The motor-specific items in the file are guidance for the operator, not FPGA constraints:

- `recommendedMicrostep`
- `recommendedPulseHighUs`
- `recommendedStartPeriodUs`

## How to adapt for a new motor

1. Check the motor datasheet for rated current, coil voltage, and step angle.
2. Set the driver current limit to the motor's rated phase current or lower.
3. Pick a microstepping mode that matches the motion quality you need.
4. Increase `recommendedStartPeriodUs` for high-torque or high-inductance motors.
5. Increase `pulseHighUs` if the driver datasheet requires a longer STEP high pulse.
6. Invert `EN` or `DIR` in JSON if the external driver uses opposite polarity.

## Practical defaults by motor class

### NEMA 17

- Good starting point: `pulseHighUs = 5`
- Start with `1/16` microstepping
- Keep acceleration conservative until motion is stable

### NEMA 23

- Use a slower start period than a NEMA 17
- Keep an eye on supply voltage and driver heat
- Consider `1/8` microstepping first, then refine

### High-speed lightweight axis

- Lower the period gradually after confirming the driver accepts the pulse width
- Watch for missed steps under acceleration
- If needed, shorten `pulseHighUs` only after confirming the driver minimum

## Polarity notes

- `STEP` is edge-triggered on the rising edge for most drivers.
- `DIR` is usually latched by the driver before the next `STEP` edge.
- `EN` is driver-specific and is often active-low; use the JSON `invert` flag if needed.

## If the motor behaves backward

- Flip the `DIR` inversion in JSON, or
- swap one coil pair on the motor side, depending on your wiring standard

## If the motor stalls

- Slow the step period
- Increase the supply voltage within driver limits
- Raise the current limit within the motor rating
- Reduce microstepping if torque is too low at the chosen speed

