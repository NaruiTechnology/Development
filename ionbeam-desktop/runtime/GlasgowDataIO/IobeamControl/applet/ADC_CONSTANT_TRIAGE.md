# Constant ADC readback: triage runbook

Symptom: every ADC sample is identical (log: `ADC sample summary: ... unique=1`),
e.g. `0x3fff` or `0x1dff`, whatever the DAC position.

**Status: root cause NOT yet identified.** Nothing in this repo has been shown to
fix it. This document records what is proven, what the evidence points at, and
the measurements that will decide it.

## 1. Proven equal to upstream OBI (commit `0f6e62c`), no hardware needed

Run the suite with `OBI_REFERENCE_ROOT=<path to Open-Beam-Interface>`.

| Layer | Result | Evidence |
|---|---|---|
| Bus FSM (upstream profile) | identical | `test_upstreamEquivalence.py`: `elaborate` AST equal; six strobes + `data_o`/`data_oe` equal cycle-for-cycle over 2500 cycles with random stalls, three transform sets |
| Parser / executor / blanking | equivalent | same file, raster and vector, array and non-array |
| Pin balls | identical | generated `top.pcf`: control H3/H1/H2/G3/F3/G1, data `B2 C4 B1 C3 C2 C1 D3 D1 F4 G2 E3 F1 E2 F2`, same order |
| I/O cells | identical | all 20 control/data `SB_IO` cells: `PIN_TYPE=101001`, `SB_LVCMOS33`, no pull-up |
| Strobe polarity | identical | exactly one inverter in each inverted strobe buffer (`adc_oe`, `adc_clk`, `dac_clk`), none in the others |

Because the FSM is proven identical, changing it would *reduce* confidence, not
increase it. The FSM is deliberately untouched.

## 2. Physical evidence already on record

From `glasgow_service/docs/adc-register-path-review-2026-09-12.md` (bench
measurements, not simulation):

* ADC output pin **U6.47 (register D input) changes** with the analog input, but
  **U6.2 (register Q output) shows no useful change.** So the ADC and its analog
  input are alive; the value is stuck at or after the register U6.
* U6 is an **SN74ALVCH16374**: an *edge-triggered* register with active-low
  /OE (not a transparent latch). FPGA `adc_le_clk` (H2) is its clock, FPGA
  `adc_oe` (G3, inverted) is its /OE, both through a 470 ohm resistor network
  (RN1, fitted value still to be confirmed).
* A flat ~2 V "low" plateau was observed on the OE line; a valid /OE low is
  <= 0.8 V.

This supersedes two guesses in an earlier draft of this note: "ADC clock not
running" and "analog input railed". The measurements above disfavour both.

A stuck register output explains why the readback has *zero* noise over 4 M
samples (a live ADC always shows a few LSB of noise), and `0x3fff` is what a
disabled (Hi-Z) register plus a pulled-up bus would look like.

## 3. What the 2026-09-16 log adds

Run `python Scripts/analyze_glasgow_log.py GlasgowService.log`.

* Scans 3-8: six timing profiles, six bitstreams, identical `0x1dff`.
* Wider register-clock pulses were already tried: `latch=2` (scan 5), `latch=4`
  (scan 7), `latch=8` (scan 8). No change, so "the 20.8 ns pulse is too short"
  is **not supported** by this log on its own.
* `0x3fff` (scans 1-2) to `0x1dff` (scans 3-8) is **confounded** with
  `half_period` 4 -> >=5, a 32-minute gap and a service restart.
* The log predates the current code (no `Scan controller: profile=` line; ran
  `half=4/turn=1` instead of upstream `3/0`), and ran from a compiled
  `IobeamPlatform/...pyc` deployment. A stale compiled overlay has already
  caused one incident (2026-09-12 review), so confirm what was actually loaded.

## 4. The open paradox

Upstream OBI reportedly works on the same hardware, and this repo's gateware and
pins are proven identical to it. So the difference is not in the FSM, pins or
I/O cells. Candidates left, roughly by likelihood:

1. **Deployed code is not the tested source** (compiled overlay, stale `.pyc`).
   Check the `Scan controller: ... code_sha256=` log line against a hash of the
   source you tested.
2. **Glasgow runtime setup** (voltage, pull configuration, activation and reset
   order) differs between the vendored Glasgow and upstream's.
3. **The bench differs** between the working upstream run and the failing one:
   board supplies (`power_good`), cabling, RN1 value, probing/loading.
4. A real fault in the fitted U6 or its connections.

## 5. Decide it with measurements (cheapest first)

Use the current build so the log carries `profile=upstream` and the new
`power_good (connect|close)` lines. Run the analyzer after each run.

1. **Upstream profile only** (shipped `streamData.json`, `half=3`, all others
   default). Compare with `half=4` the same day. Separates the confound.
2. **`power_good`**: if K1 reads LOW and is wired to the board's power-good, fix
   supplies first. K1 polarity on your board revision is unverified.
3. **ADC-only test** (holds OE low continuously), scope U6 pins 1/24 (/OE) and
   48/25 (CLK) against a nearby U6 ground, short probe ground. Then U6.47 (D1)
   versus U6.2 (Q1) aligned to the CLK rising edge.
4. **A/B with upstream's own host and gateware on the same bench, same power-up.**

| Observation | Means | Next action |
|---|---|---|
| U6 /OE never reaches <= 0.8 V | drive/loading problem on G3 -> RN1 -> U6 | check RN1 value, G3 level at the FPGA side, board pull-up; only then consider gateware |
| /OE valid low, CLK edge present, Q still stuck | fitted U6 / power / solder / pin identity | rework the board |
| /OE and CLK good, Q follows D, FPGA B2 stuck | data interconnect | trace U6.2 -> D-1 -> FPGA B2 |
| Everything good on the scope but log still constant | software path | verify deployed code hash; A/B with upstream host |
| Upstream also reads constant on the same bench | bench/board state | not a code problem |
| Upstream works, ours does not, scope identical | runtime setup | diff Glasgow voltage/pulls/activation order |

## 6. Test fixtures

`GlasgowDataIO/Json/streamData unit_test.json` has six **empty** control pins but
`IsProduction: true`. Built for hardware as-is it would route no ADC control
lines. `validate_obi_pin_config` rejects it for physical builds
(`test_streamDataPins.py` pins that behaviour). Do not use it against a board.
