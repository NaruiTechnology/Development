/**
 * Help for the Latency (bytes) field. Used by both raster and vector
 * parameter forms — the underlying concept is the same: it sets the
 * size of each chunk on the USB OUT path that the FPGA receiver
 * uses to bound how much output it sends back before pausing for
 * more input.
 */
import { HelpPopover } from "./HelpPopover";

export function LatencyHelp() {
  return (
    <HelpPopover
      title="Latency — chunk size on the USB pipeline"
      ariaLabel="What does the latency field do?"
    >
      <p>
        Sets the size, in bytes, of each chunk on the USB OUT path.
        The macro sender breaks the scan into chunks of this size and
        waits for the receiver to drain them before queuing the next
        batch. The name &ldquo;latency&rdquo; is historical — the FPGA
        firmware uses the same field as &ldquo;send up to this many
        bytes of result before pausing for more input&rdquo;, which is
        what bounds end-to-end latency in the worst case.
      </p>

      <div className="dwell-help__rule">
        <strong>Must be a multiple of the pixel size.</strong> Each
        16-bit (SixteenBit) output pixel is 2 bytes; each 8-bit pixel
        is 1 byte. Sizes that don&apos;t divide evenly produce
        truncated chunks and trip the validation checks.
      </div>

      <p>
        Pixels per chunk =
        {" "}
        <code>latency_bytes / sample_size</code>
        {" "}
        where <code>sample_size</code> is 2 for SixteenBit, 1 for
        EightBit. At default 16 384 bytes and 16-bit output, each
        chunk is 8 192 pixels.
      </p>

      <p>
        The tradeoffs:
      </p>

      <ul className="dwell-help__list">
        <li>
          <strong>Smaller latency (e.g. 4 096)</strong> — more chunks,
          more USB round-trips per scan, lower throughput. Aborts and
          mid-scan UI updates land sooner, since the receiver checks
          the abort flag between chunks.
        </li>
        <li>
          <strong>Larger latency (e.g. 32 768)</strong> — fewer chunks,
          better throughput, slightly higher peak host memory in
          flight. Mid-scan aborts can take up to one chunk longer to
          land.
        </li>
        <li>
          <strong>Sender pipeline</strong> — up to{" "}
          <code>max_pipeline</code> (32 for raster, 4 for vector)
          chunks can be in flight on the OUT endpoint at once. At
          large latency × large max_pipeline the in-flight window can
          exceed the FX2 OUT FIFO and stall — the macros pre-tune for
          this, so you don&apos;t normally need to touch max_pipeline.
        </li>
      </ul>

      <div className="dwell-help__table-wrap">
        <table className="dwell-help__table">
          <thead>
            <tr>
              <th>latency_bytes</th>
              <th>Pixels / chunk<br /><span className="muted">(SixteenBit)</span></th>
              <th>Chunks / 1024² frame</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>4 096</td><td>2 048</td><td>512</td>
              <td>Fastest abort response</td>
            </tr>
            <tr>
              <td>8 192</td><td>4 096</td><td>256</td>
              <td>Vector default-ish</td>
            </tr>
            <tr>
              <td>16 384</td><td>8 192</td><td>128</td>
              <td>Raster default</td>
            </tr>
            <tr>
              <td>32 768</td><td>16 384</td><td>64</td>
              <td>Highest throughput</td>
            </tr>
          </tbody>
        </table>
      </div>
    </HelpPopover>
  );
}
