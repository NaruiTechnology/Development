# Software reproduction of delayed and superseded Zoom

The simulator now uses the configured `max_pipeline` for a bounded FIFO. These
runs use a synthetic ADC source that returns the X DAC code, so the first sample
identifies the geometry actually delivered. They execute the production live
WebSocket control handler with in-memory messages and the real simulated scan
service; they do not launch a browser or connect to a device.

## Captured results

Playback was explicitly set to 100 ms per chunk. One chunk contains a complete
128 × 128 frame in this diagnostic. The numbers below are measured simulation
results, not hardware latency estimates.

| Run | Accepted Zoom | Old-geometry chunks after acceptance | Time to first new sample |
| --- | --- | --- | --- |
| Raster, pipeline 4 | 2 → 4 → 1, each allowed to arrive | 4 per change | approximately 0.51 s |
| Raster, pipeline 32 | 2 → 4 → 1, each allowed to arrive | 32 per change | approximately 3.37–3.39 s |
| Raster, pipeline 32, rapid | 2 → 4 before encoding resumes | 32, then Zoom 4 | approximately 3.37 s |
| Vector, pipeline 32, rapid | 2 → 4 before encoding resumes | 32, then Zoom 4 | approximately 3.40 s |

In the rapid case, Zoom 2 is accepted but never encoded/delivered. The control
logs record both request IDs and selected Zoom values; the simulation logs show
revision 2 arriving without a revision 1 output event. When Zoom 2 has already
been encoded, tests confirm it remains in FIFO order before Zoom 4.

This demonstrates two possible meanings of “Zoom was skipped”: old data persists
behind a deep command queue, or a newer selection supersedes an unencoded one.
It does not establish which occurred in the reported production run. The separate
single-ROI raster browser display issue documented in the comparison remains.

Evidence:

- [Pipeline 4 samples](raster-pipeline-4.json) and [control/queue log](raster-pipeline-4.txt).
- [Pipeline 32 samples](raster-pipeline-32.json) and [control/queue log](raster-pipeline-32.txt).
- [Rapid raster samples](raster-rapid.json) and [control/queue log](raster-rapid.txt).
- [Rapid vector samples](vector-rapid.json) and [control/queue log](vector-rapid.txt).

## Repeat the experiment

From `Development`, using the environment with the service dependencies:

```bash
PYTHONPATH=.:glasgow_service python -m glasgow_service.zoom_queue_diagnostic --pipeline 4
PYTHONPATH=.:glasgow_service python -m glasgow_service.zoom_queue_diagnostic --pipeline 32
PYTHONPATH=.:glasgow_service python -m glasgow_service.zoom_queue_diagnostic --pipeline 32 --rapid
PYTHONPATH=.:glasgow_service python -m glasgow_service.zoom_queue_diagnostic --pipeline 32 --kind vector --rapid
```

Use `--chunk-ms 0` for fast deterministic ordering tests. Each run creates and
loads a temporary simulation-only config containing the requested pipeline; it
does not modify deployed configuration, start service daemons, or access hardware.
JSON results go to stdout and the INFO timeline goes to stderr.

For browser testing, set **Configuration → Raster/Vector → Sender pipeline**,
click **Update**, and start a new software-simulated live scan. Compare 32 and 4
with the same resolution/dwell, then try separated and rapid Zoom changes. The
log announces the selected command route, pipeline, FIFO capacity and playback
interval, followed by accepted, encoded and output geometry revisions.

## Verification

Regression coverage includes pipeline 1/4/32, raster/vector route selection,
partial frames, rapid updates, preservation of already encoded intermediate Zoom,
Repeat N, single-frame streams, Stop, bitmap feedback and the actual live-control
handler. Existing packet-count tests in `test_simulation_scan_path.py` expect the
old small packets despite the pre-existing 16,384-sample batching optimization;
five fail identically against the original base-commit service source. They are
separate from the queue regressions.
