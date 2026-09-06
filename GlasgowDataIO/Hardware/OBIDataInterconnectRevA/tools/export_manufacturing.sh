#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOARD="$ROOT/board/OBI Data Interconnect.kicad_pcb"
OUT="$ROOT/manufacturing"
KICAD_CLI="${KICAD_CLI:-kicad-cli}"

command -v "$KICAD_CLI" >/dev/null || {
  echo "KiCad 9 kicad-cli is required; set KICAD_CLI to its executable." >&2
  exit 2
}

mkdir -p "$OUT"
"$KICAD_CLI" pcb drc --exit-code-violations --output "$OUT/obi-interconnect-drc.txt" "$BOARD"
"$KICAD_CLI" pcb export gerbers -o "$OUT/" "$BOARD"
"$KICAD_CLI" pcb export drill -o "$OUT/" "$BOARD"
"$KICAD_CLI" pcb export pos --output "$OUT/obi-interconnect.pos" "$BOARD"
"$KICAD_CLI" pcb export ipc2581 --output "$OUT/obi-interconnect.xml" "$BOARD"
"$KICAD_CLI" pcb export step --output "$OUT/obi-interconnect.step" "$BOARD"

echo "Manufacturing outputs exported to $OUT"
