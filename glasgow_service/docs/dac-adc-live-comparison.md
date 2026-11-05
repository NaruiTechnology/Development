# DAC/ADC loopback and live hardware comparison

Reviewed source based on commit `5aa2f60`. The original production log described
in the handoff was not available for independent reanalysis. Hardware behavior
and the reported roughly three-second delay remain unverified in this iteration.

## Paths and what they establish

| Stage | FPGA image loopback | Physical DAC/ADC | Hardware-free service simulation |
| --- | --- | --- | --- |
| Coordinates | Real command executor and transformed DAC codes | Same executor and transformed DAC codes | Python coordinate generators |
| DAC output | ROM addressed using internal latched coordinates | Shared bus, output-enable, X/Y latch strobes, physical DAC and deflection | No physical output |
| ADC input | Native 14-bit ROM data, delayed by configured `adc_latency` on conversion-clock edges | Physical ADC through input buffer, captured in `ADC_Read` | Python-generated samples |
| Timing | Deterministic delay constructed to match configured acceptance pipeline | External conversion/analog delay must match configured acceptance and last-sample pipeline | No converter timing |
| Output | Averaged then shifted left two bits in `commandExecutor.py` | Same averaging and left shift | `_obi_aligned_*` explicitly shifts left two bits |
| Live geometry | Real transfer queue when using FPGA loopback | Real transfer queue | Bounded encoded-chunk FIFO using the routed command’s configured pipeline |

Source locations: `applet/iobeamDataSubtarget.py`, `fakeAdcSimulator.py`,
`pipelinedLoopbackAdapter.py`, `busController.py`, `upstreamBusController.py`,
`supersampler.py`, and `commandExecutor.py` under `GlasgowDataIO/IobeamControl`.
The default timing profile delegates to the pinned upstream bus-controller FSM.

Successful FPGA loopback establishes command execution, coordinate generation,
modeled conversion timing, averaging, serialization, and transport. It does not
establish physical pin correctness, ADC electrical timing, actual analog settling,
ADC pipeline alignment, detector gain, or beam response. Hardware-free simulation
establishes still less about the FPGA and transport. These simulation modes must
be distinguished when interpreting a successful test.

Raw samples are right-aligned *inside* the bus controller and supersampler.
`commandExecutor.py` shifts the averaged sample left two bits at the image-stream
boundary. Thus both hardware paths emit the same SixteenBit convention, with full
scale `0xfffc`. A value above `0x3fff` downstream is not alone evidence of bad ADC
data. No sample-format or gateware timing changes were made here.

## Live Zoom and queue behavior

Production and simulation both send Zoom updates on the existing continuous
stream. Zoom does not issue an HTTP abort or close/reopen the WebSocket.
Sequential ROI scans update their requests between passes.

With no ROI, the narrowed DAC field fills the whole canvas. With ROI(s), each
narrowed acquisition fills its original ROI rectangle; background pixels outside
those rectangles remain unchanged. Zoom 1 restores the original acquisition
bounds.

The service's in-band geometry API remains available:

Raster updates replace the command's ranges and later frame generators prepend a
new `RasterRegionCommand`. Vector updates replace the points factory for later
passes. Neither replaces already encoded or written chunks. The browser queues
its display change after the service accepts geometry, without an FPGA execution
acknowledgment. Acceptance therefore does not prove the new geometry is on the
DAC yet. A partly generated chunk/frame can add further delay.

The handoff's estimated 32 chunks × 100 ms = 3.2 s is a useful experiment target,
not a measured guarantee. Chunk beam time, variable dwell, frame boundaries, USB
buffering, and the sender/receiver token schedule all affect actual latency.
A smaller pipeline can also empty the device command queue and introduce DAC
pauses, so responsiveness and waveform continuity must both be checked.

There is an additional existing client issue: `appendRaster` applies pending
live display geometry only for its parallel layout; a single-ROI raster layout
ignores that pending change. Reducing the transport queue cannot fix this client
case. It is recorded here separately from this configuration/scale/logging change.

## Software queue alignment

Software streaming now reads the same configured pipeline as the corresponding
hardware command route, including vector sweeps routed to the raster generator
and parallel raster regions routed to streamed vector commands. It queues up to
`max_pipeline + 1` encoded chunks, reflecting the initial receiver credit.
Already encoded data retains its geometry. A new geometry request affects later
frame/pass generation; another request can supersede it before encoding starts.
Single-frame streams also use the queue; blocking runs remain unpaced.

The simulator retains its existing chunk batching and `chunkIntervalMs` playback
speed. It models FIFO ordering, backpressure and geometry snapshots, not exact
hardware chunk byte counts, USB scheduling, analog settling or converter timing.
Real macros can also have an additional partly encoded chunk waiting to send.
Do not interpret a simulated elapsed delay as a prediction of physical latency.
Stop wakes playback delays and discards the FIFO. No background producer task is
left running after stream closure. Feedback retains a simulated acquisition
clock while chunks are encoded ahead.

See [reproduction results and logs](zoom-queue-reproduction/README.md) for the
32-versus-4 comparison and accepted-but-superseded Zoom scenario.

## Pipeline configuration

Previously Configuration did not expose this setting. Its JSON source is:

- `Actions[0].streamData.actionData.rasterScan.max_pipeline` (fallback 8).
- `Actions[0].streamData.actionData.vectorScan.max_pipeline` (fallback 8).

Both accept the legacy camelCase alias `maxPipeline`; snake_case takes precedence.
The source config is `GlasgowDataIO/Json/streamData.json`; use the active config
path shown by the deployed Configuration dialog rather than assuming production
loads the source checkout. Normalized values are visible in `/defaults` under
`raster_params` and `vector_params`.

Configuration now exposes **Sender pipeline (chunks)** in both Raster and Vector.
The current default is **8** for both modes; try **4** when comparing a shallower queue, save using **Update**, let the service restart, and
start a new scan. Both raster and vector defaults are now 8, including the macro fallbacks and
shipped JSON. The earlier 4-versus-32 reproduction remains a historical comparison. The UI offers presets and
custom positive integers up to 128. Backend saves reject non-integer/non-positive
values before modifying the config. A horizontal-sawtooth vector request may use
a raster command internally; inspect the logged command class and actual pipeline.

## Scale label

The live bar keeps the width selected from the full-field calibration. Zoom only
divides its displayed length: for a baseline 150 µm, Zoom 2 displays 75 µm and
Zoom 4 displays 37.5 µm. Unit conversion is retained. ROI overlays do not resize
the bar. This is an immediate UI indication of selected Zoom, not an indication
that the FPGA has already consumed the geometry update. Archived-image scale
behavior is unchanged in this iteration.

## Production log capture

INFO logs now include initial effective ROI bounds and parallel regions, command
class, actual pipeline, effective chunk latency, and continuous mode. Live control
logs include request ID and browser Zoom/region-count diagnostics, old/new bounds,
acceptance/rejection, and a snapshot of sent/received chunk counts and outstanding
chunks when available. They explicitly describe acceptance as queued rather than
hardware-applied. Existing ADC-presence and end-of-transfer link summaries remain.
Full custom point arrays are not logged.

For the next hardware run, capture the service log from before starting until
after Stop and the browser console. Run a full field, define an ROI, and change
Zoom 1 → 2 → 4 → 1 while live, leaving several seconds between changes. Repeat
with pipeline 4 and the prior value, keeping resolution/dwell the same. Record
when the image visibly changes and, if available, the scope's DAC window change.
Include one raster and one vector run and identify FPGA loopback versus physical
hardware. This will separate browser mapping, queued DAC commands, and analog/ADC
response. No claim of hardware repair can be made before that comparison.

## Verification scope

Frontend and backend TypeScript checks passed for the configuration/UI changes.
The image-scale, ROI-layout and live-parallel frontend tests passed. The queue,
live-continuous, bitmap-dwell and scan-asset regression run now passes 67 tests,
including reproductions through the production live-control handler. Backend
pipeline persistence/rejection checks passed.

Five packet-count tests in `test_simulation_scan_path.py` fail identically against
the base-commit service source because they expect smaller packets than the
existing simulation batching produces. The unrelated timing-settings-help test
also expects controls and locale keys removed before these changes. Asynchronous
simulation checks need an unrestricted test environment here: sandboxed worker
wakeups stalled, while the same tests outside the sandbox completed normally.
No production deployment, FPGA rebuild or physical hardware validation was performed.
