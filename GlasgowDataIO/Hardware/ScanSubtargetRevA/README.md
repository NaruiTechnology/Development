# Scan Subtarget Rev A

Status: Rev-A engineering package assembled from the reference Rev-A4 KiCad
source, with the shared-bus and pixel-synchronization contract captured here.
It is still a prototype release candidate, not a signed fabrication release.

This project is a new detector-acquisition and X/Y scan-output board for the
Glasgow Interface Explorer used by the Operations platform. It excludes stepper,
vacuum-stage, and other motion-control boards. The existing Open Beam Interface
files are evidence and interface references. The editable Rev-A4 source baseline
is carried under `board/`.

## Work saved

- `ADC_FINDINGS.md`: measured/logged symptoms, reference connectivity, and limits
  on what can be concluded about the old ADC failure.
- `DESIGN.md`: design direction using the reference IC set and Glasgow shared
  bus.
- `SHARED_BUS_CONTRACT.md`: cycle-level ADC/DAC bus ownership and XY-pixel
  association.
- `RELEASE_STATUS.md`: package contents, validation state, and fabrication gates.
- `board/`: editable KiCad source package based on the reference Rev-A4 design.
- `Open Beam Interface-bom.csv`: reference component list retained for the same
  ICs and peripheral population.
- `evidence/reference_audit.json`: reproducible capture statistics, source
  hashes, reference pad nets, and current Glasgow signal mapping.
- `tools/audit_reference.py`: read-only evidence extraction; exports only the
  electrical fields from the platform configuration.

Baseline inspected: Operations Development Git commit
`aa671f1bd629d499c995a73054da2412329e9a3d`, on 2026-09-06.
The capture-time gateware revision is not established by the supplied logs.

## Design basis

The board uses the Glasgow Interface Explorer rev C3 as the controller and keeps
the existing physical shared-bus contract. The current applets establish the
required order: ADC capture, bus turnaround, X DAC write, Y DAC write, then the
next ADC interval. X/Y calibration maps the 14-bit logical code to the measured
world-system voltage and position; it does not change the board's analog IC set
or FPGA bus width. See `SHARED_BUS_CONTRACT.md`.

The Rev-A4 source is the component, footprint, connector, power, and protection
baseline. The ADC failure evidence remains recorded in `ADC_FINDINGS.md`; it is
not treated as proof that the converter itself failed.

## Reproduce the evidence audit

From the Operations Development repository root:

```sh
rtk proxy python3 GlasgowDataIO/Hardware/ScanSubtargetRevA/tools/audit_reference.py \
  --raw-data /home/vboxuser/Downloads/rawData \
  --glasgow-data-io /home/vboxuser/Project/Operations/Development/GlasgowDataIO
```

The command prints JSON and does not modify the reference files or live system.
Statistics count visible log words; the majority of USB payloads are truncated
in the source logs. The parser is not a replacement for KiCad ERC/DRC.

## Intended manufacturing handoff

Once the electrical contract is resolved, the handoff must include editable
KiCad schematic/project/board and custom libraries, checked BOM with exact part
numbers and population variants, stackup/fabrication notes, Gerbers and drills,
placement and assembly files, schematic/assembly drawings, and versioned
ERC/DRC results. Include the matching gateware/configuration and board-level
bring-up procedure. Distinguish fabrication readiness from prototype-tested
analog performance; neither has been demonstrated at this stage.
