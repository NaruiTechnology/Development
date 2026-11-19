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
