# Exposure / LiveView alignment diagnostic build

Lattice exposure diagnostics are enabled by default at INFO level in the existing
`GlasgowService.log` logger. Search for `[exposure-diag]`. This is instrumentation:
it does not change DAC coordinates, dwell, beam control, ADC settings, sample order,
scan requests, or error policy. A bad synchronization reply is logged as a warning,
not newly rejected by this change.

## Files to deploy

Include the service, its `exposure_diagnostics.py` module, API/model changes, and
`GlasgowDataIO/IobeamControl/macros/vector.py`. Include the frontend hook and type
changes to obtain browser run/pass/segment identifiers. Older frontends remain
compatible but cannot provide those identifiers. Deploy through the normal build;
no production exposure was started during implementation.

## What the log records

- `start`: unique scan ID, source, bounded request metadata, exact lattice grid,
  optional browser run/step/pass/segment, cookie and implementation source hashes.
- `command`: first three actual command chunks after write/flush, sample ordinal
  ranges, first/last encoded `(x, y, dwell, blank, pass_marker)` tuples and CRC32.
  The protocol pass marker is not the UI pass number: use `pass_index` in context.
- `command_setup`: effective command type, pipeline depth, conversion rate, nominal
  dwell and sender-completion policy.
- `synchronize`: actual four reply bytes versus `ffff` plus the expected cookie.
  `matches=false` is an alignment warning worth investigating immediately.
- `adc`: first three chunks, then at most once per five seconds, with at most 128
  records per request. Includes exact ordinals/counts, first/last eight samples,
  running wire CRC32 and statistics sampled from at most 2048 values. Values are
  wire-scale sample codes (normally raw ADC14 shifted left by two); the log includes
  the output mode. Statistics are sampled, not full-chunk extrema or ADC counts.
- `padding`: planned pipeline-drain commands and whether host flush returned,
  separate from exposure sample totals. A failed flush must not be interpreted as
  confirmed padding delivery.
- `end`: actual commanded and returned totals, sample count agreement, samples
  handed to the consumer, synchronization status, first/last spot, padding count,
  source/received checksums, and completion/abort/error outcome. A normal Stop can
  have incomplete totals; it is not labelled a successful acquisition mismatch.
- `wire_end`: bytes/chunks successfully handed to WebSocket send, wire CRC32,
  completion status and maximum send latency. The scan ID matches service records.
  Compare `wire_crc32` and `bytes_sent` with `end` to check service-to-socket output.

The logging does not retain full images or full sample streams, perform a second
spot traversal, or write a record for every spot. Large polygon lists are reduced
to count, endpoints and a SHA256 digest. Set `IONBEAM_EXPOSURE_DIAGNOSTICS=0` in the
service environment and restart through the usual procedure to disable it.

## Capture to return

Return the complete log interval from before exposure start through completion or
Stop, including reconnect/synchronization messages, plus a matching screen recording.
Keep the reproduction settings (ROI, current, pitch, dwell, scan direction and zoom)
identical between simulation and hardware. The same frontend run ID links multiple
passes and segments; individual scan IDs link commands, ADC and socket output.

Interpretation: a bad cookie suggests a protocol-boundary problem; a successful run
with unequal commanded/received totals suggests a count problem; differing service
and socket checksums indicates incomplete/different forwarding. Equal counts alone
do not establish correct ADC-to-spot pairing: a constant sample shift can preserve
counts. These logs describe host-inferred positions, not position tags supplied by
the FPGA, and WebSocket send completion is not browser pixel-map acknowledgement.
Additional raw capture or gateware tagging may still be needed if counts and cookies
are correct but the image remains wrong.


## Milling image simulation

Milling simulation samples the loaded source-image gray value at each generated
exposure spot, using the same clipped, merged, serpentine spot sequence as hardware.
Only the source-image area bounding the pattern ROI is uploaded, at native pixel
resolution, with a one-pixel border. Sampling remains restricted to the actual
pattern shape (including ring holes). Original image size and crop offsets preserve
exact source-pixel addressing, even with calibrated rotation or unequal axes.
The uploaded crop supports up to 4096 pixels per side; asset transport is bounded
at 128 MiB. A large loaded image is not rejected merely for exceeding one million
pixels when its pattern ROI crop is small.
The bitmap is prepared/uploaded once per pattern for each run and remains immutable.

The browser sends the current one-based milling pass index. Pass 1 uses original
pixel values. Pass N subtracts `(N-1)` raw ADC14 codes, clamped at zero. One code is
1/64 of an 8-bit gray level (four units in the left-aligned 16-bit wire format).
Production uses actual ADC values; this synthetic darkening applies only to image
simulation. Auto contrast can compensate for uniform darkening; the raw sample
values still decrease as logged. The default Enhanced Auto display is unchanged.
Deploy the frontend and Glasgow service changes together. This package supersedes
the previous diagnostics-only archive for testing the new image-source behavior.


## Scan-tab resolution

The LiveView sample buffer uses the selected Scan resolution for the active scan
type: Raster resolution for Raster, Vector resolution for Vector. It is fixed at
the start of the milling run, while the exposure lattice still uses beam pitch and
overlap. The original source crop is not resized to that preview grid. Incoming
samples are projected into the selected grid, and saved completed-pass references
are only reused when their dimensions match. The 640-pixel display canvas is a
presentation surface, not the acquisition buffer resolution.


## Milling change-threshold slider

The Milling panel includes a 0-100% Change threshold slider, default 10%, styled
like Auto's View hold control. It remains adjustable during acquisition and after
completion. The current interpretation is absolute change relative to the previous
completed pass: `100 * abs(current - previous) / abs(previous)`.

Qualifying spots (`change >= threshold`) are drawn at the current contrast upper
limit (white). This affects only LiveView rendering: raw ADC/source pixels, pass
averages, histograms and contrast levels remain unchanged. The first pass has no
highlight reference. Comparison uses the exact emitted spot ordinal and DAC
coordinate before preview-pixel binning, including across transport segments.
If several spots land in one preview pixel, any qualifying spot makes that pixel
qualify. Previous highlights stay visible between passes until fresh samples arrive.

0% includes unchanged matched spots, following the inclusive comparison. A previous
zero changing to a nonzero value qualifies at every threshold; zero staying zero
has 0% change. Incomplete passes, mismatched coordinates, different patterns and new
runs cannot supply a comparison reference. Only two passes of typed spot buffers
are retained during a run and released at its end. The displayed change map stays
available for adjusting the slider after the run.
