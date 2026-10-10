# TMC5160 sample-stage controller

## Five-axis architecture

The stage model now exposes X, Y, Z, tilt (`T`), and rotation (`R`). The two
TMC5160 channels below are the X/Y prototype implementation, not a claim that
all five production axes use stepper motors. Z, tilt, and rotation are modeled
as external closed-loop drive contracts until their motors, encoders, and drive
interfaces are selected. Hardware mode rejects those placeholder channels;
simulation mode permits five-axis UI and API development without energizing
unknown hardware.

The sourced performance benchmark and electrical partition are documented in
`GlasgowDataIO/Hardware/StepperController/GlasgowRevC3FiveAxisStage/README.md`.

## Delivered X/Y boundary

The dedicated sample-stage Glasgow builds one Amaranth SPI controller for X
and one for Y. Each controls one TMC5160 using an independent four-wire bus
(`SCK`, `CSN`, `SDI`, `SDO`). The host sends complete 40-bit datagrams while
CSN remains asserted. This separation fits on one 16-pin Glasgow and avoids
shared-bus arbitration in the first hardware iteration.

The TMC5160 internal ramp generator performs absolute positioning. The service
writes `RAMPMODE=0` and `XTARGET`, then polls signed `XACTUAL`, `RAMP_STAT`, and
`DRV_STATUS`. Browser position values therefore come from driver readback, not
from the requested target or a host-side step counter.

## Configuration

`GlasgowDataIO/Json/sampleStageSystem.json` contains all commissioning values:

- Glasgow serial ID and I/O voltage
- per-axis SPI pin assignments, frequency, clock idle level and sample edge
- physical minimum/maximum and direction polarity
- microsteps per configured axis unit (µm for X/Y/Z)
- move timeout, poll interval and position tolerance
- current, ramp, chopper, PWM and switch register writes
- global travel and required safety controls

`registerWrites` accepts a named register exposed by `TMC5160Register` or a
numeric address such as `0x6C`. This provides an extension point for additional
TMC5160 registers without changing the schema.

The committed register values are placeholders, not validated motor-current
settings. Keep `Simulate=true` until the motor, sense resistors, external
MOSFETs, supply, mechanics and thermal limits are known.

## SPI and readback details

- SPI mode 0: SCK idle low, input sampled on the rising edge, MSB first.
- One transaction is an address/status byte plus four data bytes.
- Writes set bit 7 of the register address.
- Reads are pipelined; the requested value arrives in the following datagram.
- `XACTUAL` is interpreted as a signed 32-bit two's-complement microstep count.
- `microstepsPerUnit` converts XACTUAL to the configured API/UI unit. The five-axis stage uses µm for X/Y/Z and degrees for T/R.

## Hardware interlocks

Software travel checks are not sufficient protection for a microscope stage.
The carrier must provide hard limit inputs and an emergency-stop path that can
remove driver power independently of Glasgow, USB and host software. Those
electrical inputs must be finalized with the carrier-board design before real
motion is enabled.
