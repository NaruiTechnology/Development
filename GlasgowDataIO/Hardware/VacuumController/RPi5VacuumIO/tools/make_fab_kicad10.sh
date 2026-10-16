#!/usr/bin/env bash
# Build the RPi5VacuumIO manufacturing package with KiCad 10 (Linux / macOS).
# Windows: tools/make_fab_kicad10.ps1 produces the same package.
#
#   tools/make_fab_kicad10.sh                     # rev from the board title block, today's date
#   REV=A.2 tools/make_fab_kicad10.sh             # set the revision (title block + all outputs)
#   KICAD_CLI=/opt/kicad10/bin/kicad-cli tools/make_fab_kicad10.sh
#   NO_SAVE_BOARD=1 tools/make_fab_kicad10.sh     # do not write the checked board back
#
# Gates (the package is not written unless all pass):
#   ERC: 0 errors.  DRC (zones refilled, all severities): 0 errors, 0 unconnected,
#   0 schematic-parity issues.  Warnings are listed in fab/reports/.
#
# Output: fab/  (see fab/README.md, generated)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROJ="$(cd "$HERE/.." && pwd)"
N=RPi5VacuumIO
CLI="${KICAD_CLI:-kicad-cli}"
FAB="$PROJ/fab"

ver="$("$CLI" version 2>/dev/null || true)"
case "$ver" in
  10.*) echo "kicad-cli $ver" ;;
  *) echo "need kicad-cli 10.x (found '${ver:-none}'); set KICAD_CLI" >&2; exit 2 ;;
esac

REV="${REV:-$(python3 - "$PROJ/$N.kicad_pcb" <<'E'
import re, sys
m = re.search(r'\(rev "([^"]*)"\)', open(sys.argv[1]).read())
print(m.group(1) if m else "A.1")
E
)}"
DATE="${DATE:-$(date -u +%Y-%m-%d)}"

W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
cp "$PROJ/$N.kicad_pcb" "$PROJ/$N.kicad_sch" "$PROJ/$N.kicad_pro" "$W/"
[ -f "$PROJ/$N.kicad_prl" ] && cp "$PROJ/$N.kicad_prl" "$W/"
PCB="$W/$N.kicad_pcb"; SCH="$W/$N.kicad_sch"
python3 "$HERE/prodprep.py" "$PCB" --rev "$REV" --date "$DATE"

OUT="$W/fab"; GER="$OUT/gerbers"; REP="$OUT/reports"; ASM="$OUT/assembly"
mkdir -p "$GER" "$REP" "$ASM"

step() { printf '\n=== %s ===\n' "$1"; }

step "ERC"
"$CLI" sch erc --format json --units mm --severity-all -o "$REP/$N-erc.json" "$SCH" >/dev/null || true
"$CLI" sch erc --format report --units mm --severity-all -o "$REP/$N-erc.rpt" "$SCH" >/dev/null || true

step "DRC (refill zones, schematic parity, save board)"
"$CLI" pcb drc --format json --units mm --severity-all --refill-zones --schematic-parity \
  --save-board -o "$REP/$N-drc.json" "$PCB" >/dev/null || true
"$CLI" pcb drc --format report --units mm --severity-all --schematic-parity \
  -o "$REP/$N-drc.rpt" "$PCB" >/dev/null || true

# Advisory pass: rules the project ignores (silk overlap, text size) reported, not gating.
mkdir -p "$W/adv" && cp "$PCB" "$SCH" "$W/$N.kicad_pro" "$W/adv/"
python3 "$HERE/fabnotes.py" advisory-project "$W/adv/$N.kicad_pro"
"$CLI" pcb drc --format json --units mm --severity-all -o "$REP/$N-drc-advisory.json" "$W/adv/$N.kicad_pcb" >/dev/null || true

python3 "$HERE/fabnotes.py" gate --erc "$REP/$N-erc.json" --drc "$REP/$N-drc.json" \
  --summary "$REP/summary.json"

step "Gerber X2 + job file"
LAYERS="F.Cu,B.Cu,F.Paste,B.Paste,F.Silkscreen,B.Silkscreen,F.Mask,B.Mask,Edge.Cuts"
"$CLI" pcb export gerbers --layers "$LAYERS" --subtract-soldermask --use-drill-file-origin \
  -o "$GER/" "$PCB" >/dev/null

step "Excellon drill (PTH/NPTH separate, mm) + maps"
"$CLI" pcb export drill --format excellon --excellon-separate-th --excellon-units mm \
  --drill-origin plot --generate-map --map-format gerberx2 --generate-report \
  --report-path "$REP/$N-drill-report.txt" -o "$GER/" "$PCB" >/dev/null
mkdir -p "$W/map" && "$CLI" pcb export drill --format excellon --excellon-separate-th \
  --drill-origin plot --generate-map --map-format pdf -o "$W/map/" "$PCB" >/dev/null
cp "$W"/map/*-drl_map.pdf "$OUT/"

step "IPC-D-356 netlist (bare-board electrical test)"
"$CLI" pcb export ipcd356 -o "$OUT/$N-ipcd356.ipc" "$PCB" >/dev/null

step "IPC-2581 and ODB++"
"$CLI" pcb export ipc2581 --units mm --bom-col-mfg-pn MPN -o "$OUT/$N-ipc2581.xml" "$PCB" >/dev/null
"$CLI" pcb export odb --units mm --compression zip -o "$OUT/$N-odb.zip" "$PCB" >/dev/null

step "Assembly: BOM, pick-and-place, drawing"
"$CLI" sch export bom \
  --fields 'Reference,${QUANTITY},Value,Footprint,MPN' \
  --labels 'Refs,Qty,Value,Footprint,MPN / specification' \
  --group-by 'Value,Footprint,MPN' --exclude-dnp -o "$ASM/$N-bom.csv" "$SCH" >/dev/null
"$CLI" pcb export pos --format csv --units mm --side both --smd-only --exclude-dnp \
  --use-drill-file-origin -o "$ASM/$N-pos.csv" "$PCB" >/dev/null
"$CLI" pcb export pos --format csv --units mm --side both --exclude-dnp \
  --use-drill-file-origin -o "$ASM/$N-pos-all.csv" "$PCB" >/dev/null
"$CLI" pcb export pdf --layers "F.Fab,Edge.Cuts" --common-layers "F.Silkscreen" \
  --include-border-title --mode-single -o "$ASM/$N-assembly-top.pdf" "$PCB" >/dev/null

step "Schematic PDF, STEP, renders"
"$CLI" sch export pdf -o "$OUT/$N-schematic.pdf" "$SCH" >/dev/null
"$CLI" pcb export step --subst-models --force -o "$OUT/$N.step" "$PCB" >/dev/null 2>&1 \
  || echo "  STEP export failed (3D models missing?) - continuing"
for side in top bottom; do
  "$CLI" pcb render --side "$side" --quality basic --width 1600 --height 1300 \
    -o "$OUT/$N-render-$side.png" "$PCB" >/dev/null 2>&1 || echo "  render $side skipped (no OpenGL)"
done
"$CLI" pcb export stats --format json -o "$REP/$N-stats.json" "$PCB" >/dev/null 2>&1 || true

step "Notes, archives, checksums"
python3 "$HERE/fabnotes.py" notes --board "$PCB" --summary "$REP/summary.json" \
  --stats "$REP/$N-stats.json" --advisory "$REP/$N-drc-advisory.json" --rev "$REV" --date "$DATE" --kicad "$ver" --out "$OUT/README.md"
(cd "$GER" && zip -qX "../$N-gerbers-$REV.zip" -- *)
(cd "$OUT" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
(cd "$OUT" && zip -qrX "$N-manufacturing-$REV.zip" . -x "$N-manufacturing-*.zip")

rm -rf "$FAB"; mkdir -p "$FAB"; cp -a "$OUT"/. "$FAB"/
if [ "${NO_SAVE_BOARD:-0}" != 1 ]; then
  cp "$PCB" "$PROJ/$N.kicad_pcb"
  echo "board written back (KiCad 10, zones refilled, rev $REV)"
fi
printf '\nDONE  rev %s\n  board house : fab/%s-gerbers-%s.zip\n  assembly    : fab/assembly/\n  everything  : fab/%s-manufacturing-%s.zip\n' \
  "$REV" "$N" "$REV" "$N" "$REV"
