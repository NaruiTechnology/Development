# Scan implementation alignment with the working OBI checkout

Reference: `/home/vboxuser/Project/Open-Beam-Interface`, commit
`0f6e62c829dadbde17a8f9b8d27e1ab839c5ba2f`. The user's clarification establishes
that this implementation works on the same subtarget. The modified upstream
frame-buffer files were left untouched; the reference gateware files are clean.

## What the comparison establishes

The previous turnaround-only patch was not an upstream refactor. Missing-pin
validation was a safeguard, not evidence of the ADC failure's root cause.
The failure log actually contains changing bitstream IDs and ADC/FPGA ownership
activity during timing sweeps; it does not support a claim that those scans
never loaded new gateware or lacked a functioning FSM.

| Area | Before this change | Reference / implemented alignment |
| --- | --- | --- |
| Default scan FSM | Parameterized extended FSM, half-period 4, inserted turnaround | Pinned upstream `elaborate` method; six-state sequence; half-period 3 |
| Turnaround policy | Python/backend/UI disallowed 0 | Accept upstream 0; retain optional diagnostic stretches |
| ADC register / bus | Correct source pins; inference based on self-authored models | Compare physical inverted buffers, shared-bus OE and data against OBIComponent |
| Pixel blanking | `next_blank_enable` initialized high, applied every sync clock | Upstream initialization and local DAC clock domain restored |
| Raster/ROI scanner | Same state machine as upstream with local signatures | Verified through byte-stream differential tests; no gratuitous rewrite |
| Command parser / arrays | Different imports/comments and equivalent header slice notation | Both implementations fed identical scalar and array command bytes |
| Supersampling | Upstream algorithm, wider counter/sums for full16 and maximum dwell | Retained tested overflow fixes; compare physical raw14 results |
| Sample wire format | Raw14 right-aligned, full16 simulation supported | Retained application format; explicitly compare against upstream raw14 shifted left by 2 |
| Synchronization | Local fixes keep cookies 16-bit in every output mode | Retained; separate tests verify mode transitions and draining |
| Physical pin validation | Missing resources could be skipped | Require all six exact C3 strobes, direction/polarity, and ordered 14-bit bidirectional bus |
| Runtime provenance | Launcher/config paths and bitstream ID only | Add controller profile, implementation path and code digest; offline build manifest |

`upstreamBusController.py` preserves the upstream `BusController.elaborate`
method without logic changes. An AST comparison enforces that statement.
`busController.py` selects it for the upstream window widths, while keeping
parameterized diagnostic windows for existing troubleshooting configuration.
Both shipped JSON configurations now select `3/1/1/0/1/1`.

The pre-existing working-tree change `IsProduction=false` in `streamData.json`
was preserved. The offline build explicitly sets production mode in memory.
Do not mistake a simulation run for physical ADC validation.

## Differential verification

`test_upstreamEquivalence.py` loads the reference classes directly from the
downloaded checkout. It does not depend on an installed OBI package or open USB.
Before this change the tests failed: the local baseline could not construct
the upstream six-cycle timing, and the first clock mismatch occurred at tick 3.

Coverage includes every ADC/DAC control output and data word each sync tick,
ready/valid handshakes, ADC sample values and last flags, transforms, long output
stalls, parser/executor scalar and array commands, vector points, raster regions,
blanking/external control, physical pin inversion and USB-facing sample bytes.
The sample-format comparison explicitly accounts for the existing raw14/left-shift
difference; it does not hide an acquisition timing difference.

The existing seven-stage external-register test describes the optional
eight-cycle diagnostic profile, not the board's complete analog/DAC model.
It now requests that profile explicitly. The upstream baseline is checked
against actual upstream gateware and OBIComponent rather than altering that
model's latency to make a new default pass.

Run from `Operations/Development`:

```sh
../.venv/bin/python -m pytest -q \
  GlasgowDataIO/IobeamControl/unittest/applet/test_upstreamEquivalence.py
../.venv/bin/python glasgow_service/scripts/build_obi_reference.py \
  --build-dir /tmp/obi-alignment-production-runtime
```

`OBI_REFERENCE_ROOT` selects another upstream checkout for the tests.
The build script produces `top.bin`, `top.pcf`, synthesized `top.json`, timing
reports, and `manifest.json`. It never opens USB or modifies configuration.
The manifest records effective timing, physical pins, source/interpreter paths,
loaded code digests, the bitstream ID and its SHA256. Use the same interpreter
and inputs when comparing code digests or build IDs across deployments.

The initial production build (65,536-byte host buffer) produced ID
`4ec1ba2d14343470f72308dc8b572f74`; routing passed at 48 MHz (final reported
maximum 67.46 MHz). All fourteen synthesized data pads have input connections
and bidirectional `SB_IO` cells. G3 is an actively driven output
(`PIN_TYPE=101001`, `OUTPUT_ENABLE=1`), rather than an input or open-drain pad.
The rebuild using the JSON's 1,048,576-byte host buffer produced the same ID
and SHA256 (`efa268d686478de3aceb989e7641eba6537b2ac0405cda92ee658ef09047775c`).
The image has not been programmed by this review.

The regression run passed 48 tests and 45 subtests (applet, configuration,
launcher and bitstream-cache coverage). Subsequent expanded reference checks
passed four tests and nine subtests, including AST identity and command arrays.
Frontend tests and both frontend/backend TypeScript checks passed.

## Limits of the root-cause conclusion

The configuration policy and blanking timing differences above are proven
and corrected. They are not proof that either caused a physical full-scale
ADC value or an abnormal OE voltage.

`GlasgowService(24).log` ran under `/home/vboxuser/IobeamPlatform/Development`
using compiled modules. The inspected service unit points at Operations,
subject to environment-file overrides. Source tests do not identify which
package produced a historical bitstream.

The currently inspected installed `busController.pyc` has SHA256
`997cd494941c0583461bd046909bfa65bf4dead77c58841bd04329891a204ee2`
and does contain ADC clock/OE logic and the extended FSM. The older report
about a missing-FSM bytecode stub must not be applied to this file.

The ADC-only capture in log (24) reports all-high input pads across all
observed phases before serialization. This excludes a display-only/scaling
explanation for that capture. ADC TEST uses continuous OE and omits DAC
outputs; it is not the upstream scan transaction and should not substitute
for the scan-path A/B test.

The remaining decisive check is acquisition on the same board with the
new upstream-profile image actually loaded, recording its manifest/profile
and response to a changing known ADC input. Compare G3/H2/G1 and returned
raw samples with the working upstream run. No further timing sweep is
justified by the present evidence. Hardware root cause remains unconfirmed
until that comparison; this report does not claim the voltage fault is fixed.
