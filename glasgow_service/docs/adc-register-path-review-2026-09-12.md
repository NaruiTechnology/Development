# ADC register path review, 12 September 2026

The resumed review found a **proven installed-code defect**: `/home/vboxuser/IobeamPlatform/Development/GlasgowDataIO/IobeamControl/applet/busController.pyc` contains no ADC FSM or ADC clock generator. It is not the controller in the editable Operations repository. Its generated scan netlist ties logical ADC OE and clock to zero, hence physical G3 OE high and the external ADC register disabled. Correct pin inversion cannot compensate for a missing FSM.

This installed-package defect is distinct from the September 9 production capture, which did clock and return samples. That older evidence localizes the failure to the ADC register/input path but does **not** prove a defective subtarget or a polarity error. Current source pin polarity agrees with upstream and the supplied board netlist.

## Installed package versus active local service

Read the installed controller bytecode without executing it, then built the installed production scan image offline. The `elaborate` method contains only limited DAC-side assignments: no ADC FSM, no ADC clock, and no ADC stream production. The emitted RTLIL explicitly has `bus__adc_clk=0`, `bus__adc_oe=0`, `bus__data_oe=0`. Installed-file timestamp: September 11, 22:45 UTC. Installed build ID with this review's buffer settings: `113275d54ca628c230b9bdf53d5f8733`; full build succeeds despite being functionally unsuitable for acquisition. Installed ADC-only builds separately as `937acdfc389a3fe6a342d680b16f49f0`.

Both the installed and source `streamData.json` files specify G3, output direction, `invert=true`. The installed controller still holds OE inactive because its logical enable is never asserted. A successful bitstream build is therefore not a functional ADC test.

The current systemd unit points to **Operations source**, not `IobeamPlatform`, subject to its optional environment-file overrides. No claim is made that the currently running process loads the broken installed copy. The September 9 uploaded log explicitly came from `IobeamPlatform`; its earlier timestamp means that capture cannot be attributed to the presently inspected September 11 bytecode. The no-activity timeout is consistent with this missing-FSM behavior, but matching its historical build requires the original build inputs.

Found and corrected a separate packaging risk in `buildCompiledDist.py`: it previously flattened every `*.cpython-*.pyc` cache into a common filename, allowing different interpreter caches to overwrite each other, and ignored `compileall` failure. It now compiles each selected `.py` directly into the destination `.pyc` with errors raised. This removes stale/orphan cache selection; it does not prove which process originally produced the installed stub.

All six distribution tests pass, including two new archive-level regressions: stale/multiple-interpreter/orphan caches cannot replace selected source, and invalid source stops archive creation instead of shipping cached code.

Prepared `glasgow_service/output/adc-fsm-repair.zip`, an eight-module bytecode overlay with source/bytecode SHA256 manifest and interpreter tag. It restores the source controller and its timing dependencies in a compiled deployment. The archive does not change configuration and has not been installed. Its bytecode uses the interpreter tag recorded in `manifest.json` (cpython-313 for this build). The active local service has not been restarted. Review the archive's interpreter compatibility and back up installed files before applying it.

## Sources and hardware identity

Inspected both pages of `/home/vboxuser/Downloads/装完软件，J8一直提供波形，测_202609091740_57101.pdf`, `/home/vboxuser/Downloads/GlasgowService(16).log`, and the current service log. The supplied archive is expanded at `/home/vboxuser/Downloads/rawData (1)/rawData.zip/`; the space in `rawData (1)` matters. Inspected the Open Beam Interface schematic PDF and extracted footprint/pad nets from its KiCad PCB and the OBI Data Interconnect PCB. This is design connectivity, not continuity testing of the assembled board or a full Gerber manufacturing audit.

The supplied design identifies **U9 as LTC2246HLX#PBF (ADC)** and **U6 as SN74ALVCH16374DGGR (tri-state output register)**. They are reversed in the written request. The PDF's U6 pin 47 and pin 2 comparison is consistent with the design: input D1 versus output Q1. Follow the part numbers if the assembled board uses different reference designators.

| Signal | FPGA / interconnect | Analog board |
| --- | --- | --- |
| ADC output enable, active low | G3 → RN1 pad 12 / pad 5 → D-21 → J2.11 | S.WRITE_A → U6.1 and U6.24 |
| ADC register clock, rising edge | H2 → RN1 pad 11 / pad 6 → D-22 → J2.13 | S.LATCH_A → U6.48 and U6.25 |
| ADC conversion clock | G1 → RN1 pad 9 / pad 8 → D-24 → J2.17 | S.CLK_A → U9.14 |
| Representative ADC data bit | U9.19 → A-1 → U6.47 | U6.2 → D-1 → interconnect → FPGA B2 |

U9.17 (its own OE) is grounded in the PCB netlist. FPGA `adc_oe` controls **U6**, not U9. U6 supply pins 7/18/31/42 are on +3.3 V. Its schematic labels the clock pins `LE`, but the specified 16374 is edge-triggered, not a transparent 16373 latch. Its data inputs must be valid at the rising edge; holding OE active cannot substitute for that clock edge. At 3.3 V, a low must be ≤0.8 V and a high ≥2.0 V. A genuine flat ~2 V on U6 OE therefore does not enable its outputs. [TI datasheet](https://www.ti.com/lit/ds/symlink/sn74alvch16374.pdf).

## What the logs and photographs establish

* Uploaded log lines 3–17: production ADC TEST, half-period 6, latch phase 0, sample phase 3, image `a230dd86f2d7343a8d666c44f5ee89dd`. It reads `3fff` immediately. Raw FPGA input masks show `seen_low=0000`, `seen_high=3fff`, `sampled_low=0000`.
* Lines 36994–36997: 363,872,256 bytes received; the same raw masks persist. This is not a WebSocket establishment failure or merely a serializer filling in `ffff`. All 14 input bits were high at the monitored 48 MHz edges. Sub-clock transitions are not excluded.
* ADC TEST has no scan BusController or FPGA DAC data driver and holds logical OE asserted continuously while running. Thus a conflict solely between scan ADC/DAC ownership states cannot explain both tests. Their common latch/pad/interconnect path remains a candidate.
* Lines 37074–37082: VECTOR receives all-full-scale data and aborts validation; internal ownership flags show ADC drive, FPGA drive, turnaround, and no logical contention. These are internal intentions, not physical OE voltage measurements. A later `ok=True` means transport completion, not validated analog data.
* The PDF reports a sine at J8 and analog test points, changing U6 input pin 47, and no useful change at output pin 2. That supports investigating U6's clock/OE/output path before blaming the analog input circuitry. The visible scope settings are AC coupling and 50 µs/div; these images do not resolve a 20.8 ns latch pulse or establish the absolute DC OE low level. This limitation does not negate the separately reported ~2 V plateau.
* Local log lines 32474–32806: simulation (`production=False`), image `6f327e625c34b8909dc407c430a6b8f3`, no observed ADC/FPGA ownership and a ~29.5 s read timeout. Lines 32820–32844 and 50446–50461 show a later image `e6b48e166fcfed58e4f947022119f022`, both ownership states, and completion with 620 chunks. This newer successful simulation still cannot verify U6. The API accepts the WebSocket before starting `_stream_scan`'s generator; the observed USB read timeout is downstream of acceptance in that path.

## Comparison with the requested upstream checkout

Reference checkout: `0f6e62c829dadbde17a8f9b8d27e1ab839c5ba2f`. Requested `__init__.py` SHA256: `2704d86a39022008d35e9aae07203333842f83528bb186deb67aed87f53d6a6c`. The actual reference BusController is imported from `modules/bus_controller.py`, so comparing only `__init__.py` misses its FSM.

| Aspect | Upstream OBI | Current local implementation before this review's patch |
| --- | --- | --- |
| OE mapping | G3, inverted | Same; logical 1 drives physical low |
| ADC/DAC clocks | G1/F3, inverted | Same |
| ADC register clock | H2, non-inverted | Same |
| DAC register clocks | H3/H1, non-inverted | Same |
| Shared data | B2 C4 B1 C3 C2 C1 D3 D1 F4 G2 E3 F1 E2 F2 | Same 14-bit ordering |
| Default conversion rate at 48 MHz | Half-period 3: 8 MHz | Half-period 6: 4 MHz |
| Latch trigger | Logical clock high, counter 0 (physical falling edge) | Logical clock low, counter 1 (after physical rising edge) |
| Latch pulse | One 48 MHz cycle | One 48 MHz cycle, even when conversion is slowed |
| ADC acquisition | Direct shared-bus value during ADC_Read | External latch, OE enable, settle, registered capture, read |
| Bus release | ADC_Read directly to X_DAC_Write | Explicit high-impedance turnaround before X write |
| ADC-only test | No corresponding path in requested file | Independent autonomous sampler; common physical mapping |
| Host framing | OBI endpoint and its output format | Service WebSockets; raw/right-aligned 14-bit samples in 16-bit words |

LTC2246H specifies up to 6 ns clock-to-data delay under its stated test conditions and five conversion cycles of silicon pipeline latency. The current delayed register clock provides nominal FPGA-cycle separation; neither ideal timing simulation nor the silicon number includes unknown cable/loading skew. [Analog Devices datasheet](https://www.analog.com/media/en/technical-documentation/data-sheets/2246hfb.pdf).

The current checkout already contains delayed capture and turnaround fixes, and its baseline timing tests passed. Blindly restoring upstream timing or inverting OE again is not justified by these observations.

### State-by-state correspondence and OE polarity

Here `ADC enable` is the FPGA's logical `adc_oe`; `U6 /OE` is the physical active-low pin after inversion. `data_oe` controls the FPGA's 14 data outputs, not the G3 control pad driver.

| Function | Upstream state | Local state(s) | ADC enable / U6 /OE | FPGA data_oe |
| --- | --- | --- | --- | --- |
| Wait for phase | ADC_Wait before trigger | ADC_Wait before trigger | 0 / 1 | 0 |
| Clock external register | Trigger within ADC_Wait | Trigger within ADC_Wait, optional ADC_Latch extension | Upstream 1 / 0; local 0 / 1 | 0 |
| Enable register outputs and settle | Trigger and ADC_Read | ADC_Enable, ADC_Settle | 1 / 0 | 0 |
| Capture data | ADC_Read (direct) | ADC_Capture (registered), then ADC_Read (submit) | 1 / 0 | 0 |
| Release external driver | Implicit transition to X_DAC_Write | Bus_Turnaround | 0 / 1 | 0 locally |
| Present X | X_DAC_Write | X_DAC_Write | 0 / 1 | 1 |
| Clock X register | X_DAC_Write_2 | X_DAC_Write_2 | 0 / 1 | 1 |
| Present Y | Y_DAC_Write | Y_DAC_Write | 0 / 1 | 1 |
| Clock Y register | Y_DAC_Write_2 | Y_DAC_Write_2 | 0 / 1 | 1 |

Upstream has six named states. Local has ten in the pre-patch source and eleven including the optional ADC_Latch extension. Extra states supply settling, sample registration and turnaround; they do not inherently reverse polarity. Keeping /OE high while clocking U6 is valid for a 16374: its internal register captures independently of output enable. Local phase selection differs from upstream, so these are not cycle-identical FSMs.

If the configured inversion were wrong, the ADC read window would drive U6 /OE high, and the DAC window would drive it low. That would disable ADC reads and risk physical contention during DAC writes even though the internal flags said no contention. This is why the source, pad buffer, constraints and actual deployed configuration all matter. The reviewed configuration contains exactly the intended G3 inversion. A swapped polarity normally swaps rail-level intervals; a confirmed intermediate low plateau additionally calls for examining drive/loading/grounding rather than assuming inversion alone explains its voltage.

The resumed review also compiled and routed both default and wider-pulse scan/ADC images for Glasgow C3. In **all four** generated designs, the OE constraint assigns G3, the pad buffer RTLIL has exactly one `$not`, and the synthesized `SB_IO` has `PIN_TYPE=101001` with `OUTPUT_ENABLE=1`. Thus G3 is actively driven in both directions: `G3 = NOT logical_adc_oe`. No second inversion, open-drain control, or disabled G3 output driver was found. All 14 ADC-only data pads have no enabled output driver. These results concern the inspected builds, not an unverified previously installed bitstream.

## Remaining interconnect timing issue and implemented change

RN1's PCB metadata links **EXB-2HV471JV**, an isolated eight-element **470 Ω** resistor network. The schematic itself only says `R_Pack08`; the fitted value still needs confirmation. [Panasonic specification](https://na.industrial.panasonic.com/products/resistors/smd-chip-resistors/series/57492/model/58353).

This makes external pulse shape a concrete suspect. For illustration only, 470 Ω driving 50 pF gives a 23.5 ns time constant. An ideal 3.3 V, 20.8 ns high pulse reaches only about 1.94 V at its end under this first-order model. That is not a guaranteed high at U6. These capacitance and waveform assumptions are **not measured board facts**, but show why a one-cycle clock can fail even with logically correct polarity. An 83.3 ns pulse offers more settling time. A 470 Ω resistor with a 10 kΩ pull-up alone would not explain a sustained 2 V low; actual loading, ground reference, and both ends of the resistor matter.

Added `actionData.adcLatchCycles` to the shared timing model, scan FSM, ADC-only sampler, configuration propagation, and launcher logs. The scan now holds the external ADC register clock high for that many cycles with both shared-bus drivers disabled, then enables OE, settles, captures, and turns the bus around. ADC-only uses the same pulse width while retaining continuously asserted OE. Capture timing shifts with the width. Invalid scan periods and ADC-only pulses extending outside their period are rejected.

The default remains one cycle to preserve existing timing. The patch supplies a controlled test of the suspected pulse-width limitation; it is **not a claim that the measured electrical failure is repaired**. Increasing `adcHalfPeriod` alone does not lengthen the latch pulse; the new parameter does.

Example diagnostic values in the existing `streamData.actionData` object:

```json
{
  "adcHalfPeriod": 12,
  "adcSettleCycles": 4,
  "adcLatchCycles": 4
}
```

This is 2 MHz conversion, an 83.3 ns ADC register clock pulse, default latch phase 1 and capture phase 10. Omit old explicit `adcLatchPhase`/`adcSamplePhase` overrides for the comparison. It leaves DAC register pulse widths unchanged; those require separate characterization if DAC waveform fidelity is also in question. Scan throughput and dwell duration change with the conversion rate. The September 9 log comes from compiled code under `IobeamPlatform`; editing this checkout does not update that installation. Its old phase 0/3 log is not evidence that this patch is running.

## Decisive physical verification

1. Run ADC TEST with the new profile on the deployed build and confirm the logged `latch_cycles=4`, `latch_phase=1`, `sample_phase=10`. Measure DC-coupled at U6 OE pins 1/24 and clock pins 48/25 relative to a nearby U6 ground, with a short probe ground and nanosecond-scale timebase. Measure G3 and both sides of RN1 if U6 OE remains high. Also confirm the fitted RN1 resistance.
2. Compare changing U6.47 (D1) with U6.2 (Q1), aligned to the U6 clock rising edge. If widening the clock restores Q and `seen_low`, the control-path timing hypothesis gains direct support. If OE and clock levels/timing are correct but Q remains stuck, investigate the fitted register, power, connectivity and pin identity. If Q changes but FPGA B2 does not, follow the data interconnect next.
3. Repeat VECTOR only after ADC TEST shows changing raw input masks. Verify OE low reaches ≤0.8 V and that the register releases the bus before the FPGA drives it. Internal `contention=False` cannot certify that external release time.

An unresolved scan OE mean can be misleading: the original default is low for 5/12 of the cycle, giving a 1.925 V average for ideal 0/3.3 V levels. This is **not an explanation for a confirmed flat 2 V low plateau**. ADC TEST holds OE continuously low, which makes it the simpler discriminator.

## Validation

Baseline: six timing/capture tests, with 12 parameter subtests, passed before edits. After edits: 18 focused timing, ADC-only, pin-contract and launcher tests passed with 24 parameter subtests. Three additional physical-buffer-to-USB and loopback tests passed with 18 subtests, including the wider profile in VECTOR and RASTER. Total: **21 tests and 42 parameter subtests passed**. Tests cover extended pulses, one transaction per conversion, registered samples through backpressure, no logical driver overlap, valid-period checks, and unchanged defaults. `git diff --check` passed.

Four full Yosys/nextpnr/icepack builds succeeded for Glasgow C3 using the production pin configuration and a 65,536-byte interface buffer. All met the required 48 MHz internal clock. The builds ran under `/tmp/adc-review/netlist`; those temporary artifacts were cleared during resumption. The build IDs and timing results below were captured from the successful build outputs.

| Build | Plan ID | Final reported maximum internal frequency |
| --- | --- | --- |
| Scan default | a2425d2f9e9d4e3d0876f6c3c95cd2bf | 75.95 MHz |
| ADC default | d92cee1c2c1eeb17e2c7c832f790df6e | 107.11 MHz |
| Scan wide | 97c9106901aedb41a60253d81ed1ac77 | 78.46 MHz |
| ADC wide | 8f56292ec59ade9dcf1d7ec9400703c2 | 111.51 MHz |

The reported FPGA clock timing does not include board/cable propagation or certify external U6 setup/hold/voltage. Build IDs depend on build inputs; use the corresponding logged configuration as well as an ID when comparing deployments.

Finally, loaded the prepared repair **bytecode** over the installed package's remaining modules without modifying that installation. All ten physical-buffer, BusController and ADC timing tests passed in that environment, including VECTOR/RASTER USB output, wider latch pulses and backpressure. Reproducer: `glasgow_service/output/verify_adc_repair.py`. This verifies the repair overlay rather than merely retesting editable source.

No board was flashed, no scan was started by this review, and no electrical measurement was made. Production closure requires the above physical evidence; there is presently no defensible single proven hardware-versus-FPGA root cause for the plateau.
