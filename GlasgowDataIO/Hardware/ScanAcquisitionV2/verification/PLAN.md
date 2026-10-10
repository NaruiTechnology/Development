# Verification plan — not executed for a new board

## Digital checks

- Capture zero, midscale, endpoints and alternating-bit patterns at native width.
- Verify signed/offset-binary decoding, framing and overrange flags independently.
- Exercise maximum dwell accumulation without overflow or truncation.
- Use a changing XY-to-detector behavioral model with defined settling and latency;
  assert frame/pixel/sample IDs through raster, vector, stalls, drops and aborts.
- Verify paired XY updates, exact valid sample counts, and restart with an empty
  tag pipeline. Exercise clock-domain crossings as complete data/tag records.
- Check actual synthesized I/O directions, pin assignments and clock constraints.
- Check host decoding, full-resolution recording and display conversion with the
  same versioned reference vectors.

## Electrical and analog checks

Measure supplies/reference, logic levels, converter timing, input range/noise,
linearity and XY output range/load/settling against numerical requirements once
specified. Compare noise with XY output activity on and off. Correlate conversion
apertures and raw words to measured XY updates and detector response.

## CAD and handoff checks

Run ERC, schematic-to-board consistency and DRC on the new source using a recorded
KiCad version. Verify selected manufacturer packages against footprints and pin
numbers. Generate new BOM/placements/Gerbers/drills only from that source, inspect
the exports, and record hashes. Historical archive reports are not new-board tests.

## Cleanup verification already performed

The 2026-09-10 archive move preserved 307 original files (96,944,628 bytes).
SHA256 and size were verified for every file after moving. The unrelated kitcard
projects were left in their original location. No new electrical checks are
implied by these filesystem checks.
