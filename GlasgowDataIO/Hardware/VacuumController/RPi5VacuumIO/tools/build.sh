#!/usr/bin/env bash
# Rebuild RPi5VacuumIO KiCad project + fabrication outputs from design.py (KiCad 7+ on Linux).
# Routing is replayed from routes.ses; REROUTE=1 (with FREEROUTING_CP set) autoroutes again.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; OUT="$(cd "$HERE/.." && pwd)"; N=RPi5VacuumIO
# The board is now maintained in KiCad 10. This script regenerates it from design.py
# with KiCad 7 and would overwrite RPi5VacuumIO.kicad_pcb and fab/. Fabrication data
# comes from tools/make_fab_kicad10.sh (or .ps1).
if grep -q '(generator_version "10\.' "$OUT/$N.kicad_pcb" && [ "${FORCE_REGENERATE:-0}" != 1 ]; then
  echo "refusing: $N.kicad_pcb is a KiCad 10 board; use tools/make_fab_kicad10.sh for fab data" >&2
  echo "(FORCE_REGENERATE=1 rebuilds the board from design.py and discards KiCad 10 edits)" >&2
  exit 2
fi
W="$(mktemp -d)"; cd "$W"
python3 "$HERE/safetycheck.py"
python3 "$HERE/genpcb.py" place.kicad_pcb && python3 "$HERE/mkpro.py" place
if [ "${REROUTE:-0}" = 1 ]; then
  python3 -c "import pcbnew;pcbnew.ExportSpecctraDSN(pcbnew.LoadBoard('place.kicad_pcb'),'place.dsn')"
  xvfb-run -a java -cp "$FREEROUTING_CP" app.freerouting.gui.MainApplication -de place.dsn -do place.ses -mp 40
  cp place.ses "$HERE/routes.ses"
fi
python3 "$HERE/importses.py" place.kicad_pcb "$HERE/routes.ses" routed.kicad_pcb
python3 "$HERE/finish.py" routed.kicad_pcb "$OUT/$N.kicad_pcb"
cd "$OUT"; python3 "$HERE/mkpro.py" "$N"; python3 "$HERE/gensch.py" "$N.kicad_sch"
mkdir -p fab
python3 -c "import pcbnew;pcbnew.WriteDRCReport(pcbnew.LoadBoard('$N.kicad_pcb'),'fab/$N-drc.rpt',pcbnew.EDA_UNITS_MILLIMETRES,True)"
kicad-cli sch export netlist -o "$W/n.net" "$N.kicad_sch" >/dev/null && python3 "$HERE/checknet.py" "$W/n.net"
rm -rf fab/gerbers && mkdir -p fab/gerbers
kicad-cli pcb export gerbers --layers F.Cu,B.Cu,F.Paste,B.Paste,F.SilkS,B.SilkS,F.Mask,B.Mask,Edge.Cuts --subtract-soldermask --use-drill-file-origin -o fab/gerbers/ "$N.kicad_pcb" >/dev/null
kicad-cli pcb export drill --format excellon --excellon-separate-th --drill-origin plot --generate-map --map-format gerberx2 -o fab/gerbers/ "$N.kicad_pcb" >/dev/null
kicad-cli pcb export pos --format csv --units mm --side both --use-drill-file-origin -o "fab/$N-pos.csv" "$N.kicad_pcb" >/dev/null
kicad-cli sch export pdf -o "fab/$N-schematic.pdf" "$N.kicad_sch" >/dev/null
kicad-cli pcb export step --subst-models -f -o "fab/$N.step" "$N.kicad_pcb" >/dev/null 2>&1 || true
(cd "$HERE" && python3 bom.py "$OUT/fab/$N-bom.csv")
(cd fab && rm -f "$N-gerbers.zip" && zip -qj "$N-gerbers.zip" gerbers/*)
grep Found "fab/$N-drc.rpt"
