# Redesign decisions

## What changed

1. The Glasgow expansion remains the single source-side connector, so the proven applet pin mapping is not remapped.
2. The three field headers retain the established D-1..D-24 grouping, but the active/reserved split is now documented and printed on the revised silkscreen.
3. The misleading “LVDS I/O Breakout” board identification is replaced with “OBI DATA INTERCONNECT / Glasgow C3”. This is a digital single-ended interconnect with GNDD returns, not an LVDS transceiver.
4. JP1/JP2 remain mutually exclusive power-source selectors. The warning is retained on the board and repeated in assembly documentation.
5. The existing 33 ohm resistor arrays remain in series with the outgoing data groups. They are the signal-integrity damping elements; do not bypass or populate them with zero ohms without a new bus validation.
6. No analogue conversion is placed on this board. ADC/DAC conversion remains on the scan subtarget and uses the same D-1..D-14 physical bus, synchronized by the Glasgow pixel-cycle state machine.

## Assembly constraints

- Populate exactly one of JP1 or JP2.
- Keep the Glasgow +3.3 V source off when an external 3.3 V source is selected.
- Use the connector orientations and pin-1 marks in the supplied custom footprints.
- Verify D-1..D-14 continuity end-to-end before connecting an ADC or DAC board.
- The board must never be used to connect two powered 3.3 V sources in parallel.
