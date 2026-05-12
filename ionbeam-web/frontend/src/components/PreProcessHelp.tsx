/**
 * Help for the vector Pre-process chunks checkbox. Controls whether
 * the macro encodes all chunks into device-ready byte buffers up
 * front (before any USB I/O) or lazily, as the transfer consumes
 * them.
 */
import { HelpPopover } from "./HelpPopover";

export function PreProcessHelp() {
  return (
    <HelpPopover
      title="Pre-process chunks — encode up-front vs lazily"
      ariaLabel="What does the pre-process chunks field do?"
    >
      <p>
        Every vector pixel ships as a 6-byte command on the OUT path:
        <code>x</code> (2 B) + <code>y</code> (2 B) + <code>dwell</code>{" "}
        (2 B), big-endian. The macro batches those into chunks sized
        by <strong>Latency</strong>. <em>When</em> that batching
        happens is what this checkbox controls.
      </p>

      <ul className="dwell-help__list">
        <li>
          <strong>Unchecked (lazy, default for streaming)</strong> —{" "}
          chunks are encoded on demand inside the sender coroutine as
          the transfer consumes them. Lowest memory: only the
          in-flight window of chunks (max_pipeline × latency_bytes)
          lives in RAM at once. But the host CPU now has to keep up
          with USB; if the iterator producing the points is slow, the
          device can stall waiting for the next chunk.
        </li>
        <li>
          <strong>Checked (pre-process)</strong> — the macro&apos;s{" "}
          <code>_pre_process_chunks()</code> runs once at scan start,
          materializing every chunk into a memoryview held by the
          command object. Transfer is then bound only by USB
          throughput, not by host-side encoding speed. Cost: peak RAM
          equal to roughly <code>6 × total_pixels</code> bytes (so 6
          MB for a million-point scan).
        </li>
      </ul>

      <div className="dwell-help__rule">
        <strong>The wet-run pre-process time is reported separately.</strong>{" "}
        <code>process_time_s</code> in the run report shows how long
        the pre-processing took; <code>send_time_s</code> shows USB
        transfer time alone. The two used to be conflated in older
        UIs.
      </div>

      <p>
        When to enable:
      </p>

      <ul className="dwell-help__list">
        <li>
          <strong>Yes:</strong> any custom point list with more than
          ~100k points, especially if the point iterator does
          non-trivial work (computed paths, image-based rastering).
        </li>
        <li>
          <strong>Yes:</strong> the default sweep at high resolution
          (1024+) when total throughput matters.
        </li>
        <li>
          <strong>No:</strong> very long scans where peak RAM matters
          more than total time (≥ 10M points and you&apos;re running
          on a memory-constrained host).
        </li>
        <li>
          <strong>No:</strong> small scans under ~10k points —
          pre-processing overhead is comparable to the savings.
        </li>
      </ul>
    </HelpPopover>
  );
}
