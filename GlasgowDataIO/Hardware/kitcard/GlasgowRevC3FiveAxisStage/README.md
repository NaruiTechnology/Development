# Glasgow Rev C3 five-axis microscope stage controller

Status: **engineering specification / not released for fabrication**

This package defines a modular X/Y/Z/tilt/rotation controller for an SEM/FIB
sample stage. It deliberately separates the Glasgow motion-command board from
replaceable power/actuator modules. That lets the X/Y TMC5160 prototype remain
useful without assuming that a TMC5160 can drive the piezo or servo actuators
normally used for high-precision translation and rotation.

## Published benchmark

The Stanford Helios NanoLab 600i page publishes the following stage envelope:

- five motorized axes;
- 150 mm X/Y travel, piezo driven;
- 10 mm Z travel;
- tilt from -10 degrees to +60 degrees;
- continuous rotation, piezo driven;
- 1.0 micrometre X/Y repeatability;
- 500 g maximum sample-plus-holder mass.

Sources (retrieved 2026-08-11):

- https://snsf.stanford.edu/facilities/eim/helios
- https://www.thermofisher.com/cv/en/home/electron-microscopy/products/dualbeam-fib-sem-microscopes/helios-5-dualbeam.html.html

These are performance benchmarks only. Neither source publishes the proprietary
motor, encoder, power electronics, connector, or safety-controller design.

## Controller architecture

1. Glasgow rev C3 supplies deterministic low-voltage commands and telemetry.
2. X/Y may use one TMC5160 each during mechanical prototyping.
3. Z, tilt, and rotation use isolated external closed-loop drive contracts until
   the selected actuator vendors provide electrical interface specifications.
4. Every axis exposes home, positive limit, negative limit, drive-ready, drive-
   fault, and position feedback.
5. A safety chain independent of USB, Linux, FPGA gateware, and application
   software removes actuator torque through contactors or certified STO inputs.
6. Chamber motion permit, door state, vacuum state, working-distance clearance,
   and Z/tilt collision limits are wired into the safety chain and also reported
   to software.

## TMC5160 boundary

The Analog Devices TMC5160 supports 8 V to 60 V supplies, external N-channel
MOSFETs, SPI/step-direction control, ABN encoder input, and two reference-switch
inputs. It is a one-axis bipolar-stepper controller; it is not a piezo amplifier.

Primary source:

- https://www.analog.com/en/products/tmc5160.html
- https://www.analog.com/media/en/technical-documentation/data-sheets/tmc5160a_datasheet_rev1.17.pdf

Current, MOSFET, sense-resistor, braking, bulk-capacitance, and thermal values
remain `TBD` until motors and the DC supply are selected. Copy the official
TMC5160 evaluation/reference layout rather than improvising the gate-drive loop.

## Axis contract

| Axis | Benchmark | Prototype interface | Production direction |
| --- | --- | --- | --- |
| X | -75 to +75 mm | TMC5160/SPI | closed-loop piezo or servo |
| Y | -75 to +75 mm | TMC5160/SPI | closed-loop piezo or servo |
| Z | 0 to 10 mm | isolated external drive | closed-loop motorized lift |
| Tilt | -10 to +60 deg | isolated external drive | closed-loop rotary/tilt drive |
| Rotation | continuous | isolated external drive | closed-loop piezo or servo |

The finite -180 to +180 degree software representation of rotation is a wrapped
command coordinate, not a mechanical stop.

## Proposed PCB partition

- `CONTROL`: Glasgow connectors, digital isolation, watchdog, command routing,
  drive-ready/fault inputs, limit/home inputs, encoder translation, and test pads.
- `SAFETY`: dual-channel E-stop input, chamber/vacuum permits, external safety-
  relay interface, contactor/STO feedback, and hardware enable gating.
- `POWER_XY`: two removable TMC5160 power modules or a separate validated power
  board. Do not place unvalidated high-current bridges on the control PCB.
- `AXIS_EXPANSION`: three identical isolated command/feedback connectors for Z,
  tilt, and rotation drives.

## Required release artifacts

- reviewed `.kicad_sch`, `.kicad_pcb`, and `.kicad_pro` files;
- ERC and DRC reports with zero unresolved errors;
- approved component values and manufacturer part numbers;
- Gerbers, IPC-356 netlist, drill files, stack-up and fabrication drawing;
- BOM, centroid/placement file, assembly drawing and programming instructions;
- STEP model of the assembled PCB and STL/STEP enclosure/mounting parts;
- creepage, clearance, current-density and thermal calculations;
- FMEA and verified emergency-stop/STO test procedure;
- prototype motion, repeatability, vacuum, EMC and collision-test results.

The machine-readable operating assumptions live in
`../../../Json/sampleStageSystem.json`. Keep `Simulate=true` until every external
driver contract and safety input is implemented and validated.
