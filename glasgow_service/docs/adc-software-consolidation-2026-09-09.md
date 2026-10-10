# ADC control software consolidation — 2026-09-09

Hardware is provisionally assumed functional while subtarget testing is pending.
This is an investigation assumption, not a conclusion that software caused the
reported OE low plateau of 2.9 V or constant raw ADC code 0x3fff.

## Implemented change

`GlasgowDataIO/IobeamControl/applet/adcTiming.py` defines the common timing
configuration used by both applet builders, the scan bus controller, and the
ADC launcher. The launcher logs the same resolved phases used by ADC gateware.
Invalid timing now raises ValueError rather than being silently clamped; scan
period checks also remain effective when Python assertions are disabled.

Default ADC TEST timing changes from latch/sample phases 0/3 to 1/5 at
half-period 6 and settle 2. Scan timing stays at 1/5. Phases count FPGA clock
intervals from the logical falling ADC clock edge (physical rising with the
shipped pin inversion). LE rises at the beginning of phase 1; the FPGA sample
register captures at the end of phase 5. One period remains 12 clocks at 48 MHz.
For other supported settle settings, sample phase is settle + 3.

This removes the isolated applet's simultaneous conversion/latch edges. The
prior independent board-model investigation identified sensitivity to assumed
clock skew at phase zero; it did not prove a violation on the actual board.
See `/home/vboxuser/adc-investigation-2026-09-09/REPORT.md` for its assumptions.

Explicit `actionData.adcLatchPhase` and `adcSamplePhase` remain ADC-only
experimental overrides; setting both to 0 and 3 reproduces the old timing.
Unspecified values use the common defaults independently. Remove both overrides
for the aligned defaults. Overrides are checked for period bounds, but their
relative phase and electrical timing are deliberately not certified.

OE ownership remains distinct by design: isolated ADC holds the active-low
output enabled during capture; scanning releases it before driving XY data.
The common timing definition does not add DAC drivers to the isolated image.
The raw14 big-endian wire format, averaging, and diagnostic masks are retained.

## Verification

34 targeted unittest tests passed across ADC timing, isolated capture, scan
capture, physical input-to-USB paths, pin mapping, low-level command handling,
loopback timing, scan configuration, ADC startup and connection cleanup.
The new regression model delays conversion data, latches it on LE rising edges,
and checks complete USB words under stalls at three timing configurations.
A separate regression measures scan latch and capture phases against conversion
edges, and existing tests check independent XY/sample ordering and turnaround.

Full synthesis, placement/routing and bitstream packing succeeded for both C3
images at 48 MHz. Final reported maximum clock rates: ADC 104.91 MHz, scan
69.48 MHz. Build files and logs are in `/tmp/adc-consolidation-20260909/{adc,scan}`.
Final-source RTLIL and pin constraints were compared byte-for-byte with these
build inputs after the configuration cleanup; both matched. `manifest.json`
in that directory records source and bitstream SHA256 hashes (not Glasgow IDs).

These images have not been loaded onto the instrument. Running services and the
compiled deployment under IobeamPlatform were not changed. Deployment must
include the new adcTiming.py module and rebuild the ADC image to use the change.

## Remaining diagnosis

A real 2.9 V low plateau remains unexplained by the digital tests. The timing
change is not evidence of a voltage-level repair. On the next controlled run,
record the loaded image provenance, effective phases, and independent ADC PAD
masks alongside the USB stream and OE/clock/latch waveforms. Changing data at
pads but not accepted samples points toward capture phase; changing accepted
samples but constant complete USB words points downstream.

Do not label 0x3fff as analog full scale until ADC coding is established. The
existing board investigation identified a possible two's-complement setting,
where that raw pattern represents -1 count. This consolidation preserves raw
values and makes no unverified coding-mode change.
