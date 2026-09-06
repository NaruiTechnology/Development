# Fabrication release checklist

Run from the package root with KiCad 9 or newer:

```sh
KICAD_CLI=/path/to/kicad-cli tools/export_manufacturing.sh
```

Then confirm:

- `obi-interconnect-drc.txt` has zero violations.
- Gerbers include F/B copper, inner copper, solder mask, paste, silkscreen, and Edge.Cuts.
- Drill output includes plated and non-plated holes as applicable.
- The position file contains J1–J4, JP1/JP2, RN1–RN3, C1–C6, and R1–R3.
- The exported STEP opens and has the connector models present.
- The board revision and source hash are recorded in the purchase order.
