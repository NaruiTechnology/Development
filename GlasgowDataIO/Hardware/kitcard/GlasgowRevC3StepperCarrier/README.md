# Glasgow Rev C3 Stepper Carrier

This directory captures the board intent for the current `ControlStepperSubtarget`.

For the ion-beam wafer stage use case, this passive stepper carrier is not the final solution.
See the vacuum-stage spec in `../GlasgowRevC3VacuumWaferStage/` for the encoder-aware architecture.

Scope:
- Target host: Glasgow Interface Explorer rev C3
- FPGA-side signals: `STEP`, `DIR`, `EN`
- Electrical role: passive carrier / adapter for an external stepper driver
- JSON carrier spec: [`/home/vboxuser/Project/IobeamTech/Development/GlasgowDataIO/Json/stepper_c3_generic.json`](/home/vboxuser/Project/IobeamTech/Development/GlasgowDataIO/Json/stepper_c3_generic.json)
- Motor adaptation guide: [`STEPPER_MOTOR_ADAPTATION.md`](/home/vboxuser/Project/IobeamTech/Development/GlasgowDataIO/Hardware/kitcard/GlasgowRevC3StepperCarrier/STEPPER_MOTOR_ADAPTATION.md)
- KiCad board layout: [`GlasgowRevC3StepperCarrier.kicad_pcb`](/home/vboxuser/Project/IobeamTech/Development/GlasgowDataIO/Hardware/kitcard/GlasgowRevC3StepperCarrier/GlasgowRevC3StepperCarrier.kicad_pcb)

The current gateware only needs three digital outputs plus a common ground.
No ADC/DAC path is involved.

## Required Glasgow mapping

The subtarget should be driven from the first three `port_a` outputs on rev C3:

- `port_a[0]` -> `STEP`
- `port_a[1]` -> `DIR`
- `port_a[2]` -> `EN`

On the Glasgow rev C3 platform those resources correspond to FPGA balls:

- `port_a[0]` -> `A1`
- `port_a[1]` -> `A2`
- `port_a[2]` -> `B3`

## Suggested connector layout

The simplest carrier is a passive adapter with:

- `J1`: Glasgow side, `STEP/DIR/EN/GND`
- `J2`: stepper-driver side, same signal order

Recommended pin order:

1. `STEP`
2. `DIR`
3. `EN`
4. `GND`

## Suggested BOM

- 2x 1x4 2.54 mm pin header
- 3x 100 ohm series resistors, one per control line
- optional ground test pad
- no active silicon IC is required for this revision

## Notes

- The applet is now gated to `required_revision = "C3"`.
- The JSON config file is the editable source of truth for pin layout and timing defaults.
- If you want the board to mate to a specific stepper driver module, the next step is to lock the header footprint and outline to that module's mechanical drawing.
- There is no existing KiCad PCB in the repository, so this is the authoritative pin/spec starting point for a future `.kicad_sch` / `.kicad_pcb` layout.
- This revision is intentionally passive; it is meant to be fabbed as a small adapter board for a separate stepper driver module.
