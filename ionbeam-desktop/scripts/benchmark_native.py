"""Measure the eliminated sample representation work, not end-to-end scan FPS."""
import array
import json
from pathlib import Path
import statistics
import sys
import time

root = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(root), str(root/'GlasgowDataIO'), str(root/'glasgow_service')]
from glasgow_service.service import _sample_chunk_to_wire_bytes
from glasgow_service.desktop_native import native_payload

results = []
for resolution in (512, 1024, 2048):
    chunk = array.array('H', [0x1234] * 32768)
    chunks = [chunk] * (resolution * resolution // len(chunk))
    timings = {}
    for label, convert in [('web_big_endian_copy', _sample_chunk_to_wire_bytes),
                           ('native_buffer_view', lambda data: native_payload(data)[1])]:
        measured = []
        for iteration in range(21):
            start = time.perf_counter_ns()
            payloads = [convert(data) for data in chunks]
            elapsed = (time.perf_counter_ns() - start) / 1e6
            assert sum(len(data) for data in payloads) == resolution * resolution * 2
            if iteration:
                measured.append(elapsed)
        timings[label] = round(statistics.median(measured), 6)
    results.append({'resolution': resolution, 'median_ms': timings})
output = {'scope': 'Sample representation preparation only. Excludes USB, IPC copies, Node, rendering, persistence and device timing. Not an OBI throughput comparison.',
          'python': sys.version.split()[0], 'trials_after_warmup': 20, 'results': results}
target = Path(__file__).resolve().parents[1]/'docs/native-buffer-benchmark.json'
target.write_text(json.dumps(output, indent=2))
print(json.dumps(output, indent=2))
