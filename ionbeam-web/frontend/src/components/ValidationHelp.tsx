/**
 * Help for the do_validate checkbox. Shared by raster and vector
 * forms. Explains what the post-scan checks actually check and when
 * to turn them off.
 */
import { HelpPopover } from "./HelpPopover";

export function ValidationHelp() {
  return (
    <HelpPopover
      title="Validation — post-scan integrity checks"
      ariaLabel="What does the validation field do?"
    >
      <p>
        When enabled, the service runs a battery of cheap checks on
        the captured byte stream after the scan completes, before
        returning the result. They run in &lt; 100 ms for typical
        scans and don&apos;t touch the device — they just inspect the
        in-memory chunk list.
      </p>

      <p>Raster checks:</p>

      <ul className="dwell-help__list">
        <li>
          <strong>chunk count</strong> — the receiver got the number
          of chunks predicted by{" "}
          <code>ceil(resolution² / pixels_per_chunk)</code>. A
          mismatch means the FPGA hit a back-pressure stall or the
          drain padding got short-cut.
        </li>
        <li>
          <strong>chunk size</strong> — every chunk except the last
          is exactly <code>latency_bytes / sample_size</code>{" "}
          samples long. Truncated chunks usually mean an
          output_mode / latency_bytes alignment mismatch.
        </li>
        <li>
          <strong>padding present</strong> — the trailing pipeline-
          drain padding (~128 pixels minimum, plus 0.5 % of frame
          size) was correctly emitted by the sender. Without it the
          last few real pixels can stay trapped in the FPGA
          pipeline.
        </li>
      </ul>

      <p>Vector checks:</p>

      <ul className="dwell-help__list">
        <li>
          <strong>non-empty</strong> — every chunk contains at least
          one sample. An all-empty stream is a sign the scan never
          actually triggered (e.g. the FPGA didn&apos;t see the
          SynchronizeCommand).
        </li>
        <li>
          <strong>padding present</strong> — same drain-padding check
          as raster. Particularly important for vector since the
          drain floor is much higher there (~21 000 pixels for the
          default setup).
        </li>
      </ul>

      <div className="dwell-help__rule">
        <strong>The validation report drives the result panel.</strong>{" "}
        When disabled, you still get the chunk count and timing in the
        run report, but the per-check pass/fail list is omitted and
        the Run pane shows just &ldquo;validation: off&rdquo;.
      </div>

      <p>
        When to turn off:
      </p>

      <ul className="dwell-help__list">
        <li>
          <strong>High-rate repeated scans</strong> where you&apos;ve
          already confirmed the setup is healthy and you don&apos;t
          need the report for every run.
        </li>
        <li>
          <strong>Maximum-throughput streaming</strong> — although the
          checks are cheap (&lt; 100 ms), they do hold the result in
          RAM long enough to scan it. Disabling skips that hold.
        </li>
      </ul>

      <p>
        For first-time setup, debugging a flaky USB cable, or
        validating a new bitstream, keep this on. The checks are
        designed to catch exactly the &ldquo;scan completed but the
        data is silently wrong&rdquo; failure modes that are
        otherwise expensive to notice.
      </p>
    </HelpPopover>
  );
}
