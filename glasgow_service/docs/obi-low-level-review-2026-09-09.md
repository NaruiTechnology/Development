# Low-level review and saturation investigation

## Reference and module coverage

Downloaded the exact [requested OBI file](https://github.com/nanographs/Open-Beam-Interface/blob/main/software/obi/applet/open_beam_interface/__init__.py).
Its SHA256 is `2704d86a39022008d35e9aae07203333842f83528bb186deb67aed87f53d6a6c`,
identical to the existing local OBI checkout's file. This review covers that
snapshot, not a promise about future `main` revisions.

| Reference responsibility | Local implementation | Result |
| --- | --- | --- |
| Command executor and image/sync state machines | `applet/commandExecutor.py` | Present; synchronization defect reproduced and fixed below |
| Image byte serializer | `applet/imageSerializer.py` | Present; high byte first, output backpressure and low-byte retention |
| Component interconnect and IO buffers | `applet/iobeamDataSubtarget.py` | Present; explicit data/control buffers and optional beam ports |
| Applet setup and voltage/pin configuration | `DataStreamApplet.py`, `scanConfiguration.py`, `IobeamLauncher.py` | Present; previous pin audit fixes retained |
| Host pipe read/write/flush/readuntil | `transfer/glasgowStream.py` and vendored demultiplexer | Present; service replaces OBI's standalone socket endpoint |
| Benchmark entrypoint | Local counters and test suite | No equivalent public continuous OBI socket benchmark; not part of ADC acquisition |
| Parser and command arrays (imported by reference) | `commandParser.py`, `commands/low_level_commands.py` | Present; actual byte-stream tests exercise parser through capture |
| Raster traversal (imported) | `rasterScanner.py` | Present; exact ROI fill followed by synchronization passes |
| Dwell expansion and averaging (imported) | `supersampler.py`, `powerOfTwoDetector.py` | Present; two arithmetic width limits corrected |
| Shared ADC/DAC bus and buffering (imported) | `busController.py`, `skidBuffer.py` | Present; capture/turnaround timing intentionally differs |
| Output-only bus (imported) | `fastBusController.py` | Present; separate path, not used for ADC TEST or ordinary VECTOR acquisition |
| Loopback (imported) | `pipelinedLoopbackAdapter.py`, plus local fake-image source | Present; digital test coverage only |

The size difference is largely file organization, not absence of those low-level
blocks. This is not a claim of complete electrical or protocol equivalence.
Existing deliberate differences remain: raw14 wire scaling, six effective bits
in EightBit mode, 4 MHz conversion timing, registered capture and turnaround,
sync-clock blanking, and the independent ADC-only applet. The output-only path
does not implement the normal controller's coordinate transforms; it is not a
validated replacement for the normal scan path. Neither implementation supplies
the raster scanner's commented AC-line/trigger/flyback features.

## Reproduced defects fixed

1. Synchronization changed image output mode before old pixels drained and
   serialized the cookie using EightBit/NoOutput. This truncated or removed the
   four-byte reply, and could change the encoding of preceding image pixels.
   The executor now drains with the old mode, emits both synchronization words
   as SixteenBit, then switches mode. A single queued sequence changes through
   SixteenBit, EightBit, NoOutput and back under FIFO backpressure.
2. Full16 simulation values overflowed the 30-bit sum at long dwell: 32768
   samples of 65535 produced 32767. The accumulator is now 32 bits. The sample
   count and power-of-two detector are 17 bits, representing all 65536 samples
   encoded by maximum 16-bit dwell. Tests also preserve the existing
   power-of-two-prefix averaging rule for non-power-of-two counts.

The suspected raster-fill accounting failure did not reproduce: four pixels
and the subsequent synchronization complete correctly. No speculative change
was made there. These defects do **not** explain ADC TEST's constant raw14 data.

## What GlasgowService(15).log establishes

Source: `/home/vboxuser/Downloads/GlasgowService(15).log`.

- Lines 3–15: production ADC TEST, image `882da814d42ecd502478936677d91015`,
  capture running, 3.3 V set on A/B, half-period 6 and settle 2; the first USB
  sample bytes are `3fff`, and min/max are both `0x3fff`.
- Lines 3423, 6907, 10517, 14212: the same values persist, with roughly 8 MB/s
  payload transfer, consistent with the nominal 4 million 16-bit samples/s.
- Line 15480: some FIFO stalls and dropped conversion points occurred. They
  do not by themselves explain why all the visible received values are equal.
- Lines 15483–15567: production VECTOR, image `cade08c3406cc008c44acc599ee78924`,
  the new named beam mapping and voltage/pull configuration are active;
  synchronization returns `ffff007b`, followed by all-`3fff` USB data.
- Internal bus ownership flags report no logical simultaneous ADC/FPGA drive.
  These flags do not measure the physical OE level or prove absence of
  electrical contention.

The capture came from compiled code under `IobeamPlatform`, not the editable
Operations path. Different plan IDs alone do not prove stale code: build
provenance can affect IDs. The log contains no independent per-bit input
observation before the serializer, nor an analog waveform; it cannot select a
unique physical/capture root cause.

## OE measurements: distinguish plateau from duty-cycle mean

The user reports 0.6 V during ADC TEST and 2.09 V during VECTOR at every
measured point between the FPGA and U6, using an oscilloscope. These
observations are accepted as reported; the measurement statistic is not yet
established.

For the specified SN74ALVCH16374 at VCC=2.7–3.6 V, TI specifies VIL <=0.8 V
and VIH >=2.0 V. Therefore 0.6 V qualifies as low; a flat 2.09 V plateau
qualifies as high and would disable U6 outputs. U6 stores data on the rising
clock edge; OE exposes the stored value and does not perform capture.
[TI datasheet, recommended conditions and function table](https://www.ti.com/lit/ds/symlink/sn74alvch16374.pdf).
The fitted part and actual VCC must match these conditions.

The digital scan simulation shows physical OE low for 5 of every 12 clocks:
104.17 ns low in a 250 ns period. ADC TEST holds OE low continuously while
running. With high=3.3 V and low=0.6 V, the scan waveform's time average would
be 2.175 V; with an ideal 0 V low, 1.925 V. This is a conditional calculation,
not proof that the reported 2.09 V is an average. If it is the actual flat low
plateau, duty cycle cannot explain it.

The synthesized SB_IO cells for both OE paths have output-enable tied to 1;
ADC TEST's 14 data pads have input-only SB_IO cells. Thus the inspected build
does not implement a floating/open-drain OE or a DAC data driver in ADC TEST.
This is a netlist result, not a voltage measurement on the deployed device.

## Added diagnostics for the next capture

ADC TEST now reads separate FPGA registers every five seconds and on close:

`ADC PAD diagnostic ... raw_last=... seen_low=... seen_high=... sampled_low=...`

These observe the raw 14 input bits independently of the image serializer.
`seen_low`/`seen_high` accumulate observations on every 48 MHz edge while
capture is running. `sampled_low` accumulates only values actually accepted
into the serializer's sample register, excluding points dropped under stalls.

| Result while USB remains all `3fff` | Next conclusion/test |
| --- | --- |
| `seen_low=0000`, `seen_high=3fff` | Every observed input bit is high before capture/serialization. Compare one known-changing U6 D/Q data bit and its FPGA pad; changing OE code alone is not established as a fix. Sub-clock transitions can escape these observations. |
| `seen_low!=0000`, `sampled_low=0000` | Low values occur outside accepted captures. Investigate phase selection and dropped points. |
| `sampled_low!=0000` | The sample register accepted non-full-scale data. Compare the corresponding complete USB stream; investigate serialization/transport rather than explaining everything by OE. |

Optional `actionData.adcLatchPhase` and `adcSamplePhase` allow controlled timing
experiments within one ADC period; defaults preserve the previous timing
(latch phase 0, sample phase 3 at half-period 6/settle 2). These settings are
logged. They have not been asserted to repair saturation. The diagnostic test
deliberately produces a changing input between captures with an all-`3fff`
output and verifies that the masks distinguish it from accepted changing data.

## Validation and limits

35 targeted tests passed before the final refinement restricting sampled_low
to accepted, non-dropped samples; the ADC tests were rerun after that change.
Full FPGA synthesis/place/route/packing succeeds at the required 48 MHz.
Artifacts are in `/tmp/iobeam-pin-alignment-20260909/scan` and `adc` (these
replace the earlier build artifacts); logs are retained there. Final scan ID:
`2cc6c0846077fffad4af74726428900c`; ADC diagnostic ID:
`93b8a6d15c1d9ca18ffd07410a02b125`. The final ADC/launcher/connection rerun
passed all 12 tests.

No image was loaded and no measurement on the user's instrument was made in
this review. The saturation root cause is **not yet established**. The next
evidence required is the independent pad-diagnostic result and confirmation
whether 2.09 V is a low plateau or a mean; claiming a repaired ADC or defective
subtarget before that would be unsupported.
