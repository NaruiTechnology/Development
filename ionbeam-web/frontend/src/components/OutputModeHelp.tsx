/**
 * Help for the Output mode field. Used by both raster and vector
 * forms. Picks the bit depth at which the FPGA serializes each ADC
 * sample to USB: 16 bits (raw, full dynamic range) or 8 bits
 * (truncated, half the bandwidth).
 *
 * A third mode `NoOutput` exists in the firmware but is not exposed
 * to the UI — it's a diagnostic mode where the scan runs but no
 * data is returned, used for timing measurements during bring-up.
 */
import { HelpPopover } from "./HelpPopover";

export function OutputModeHelp() {
  return (
    <HelpPopover
      title="Output mode — sample bit depth"
      ariaLabel="What does the output mode field do?"
    >
      <p>
        Selects how each ADC sample is serialized on the USB IN path
        from the FPGA back to the host. Both modes always use the
        full 14-bit ADC; the difference is only in how those bits are
        packed on the wire.
      </p>

      <ul className="dwell-help__list">
        <li>
          <strong>SixteenBit</strong> — 2 bytes per pixel. The raw
          14-bit ADC reading is zero-extended into a uint16, little-endian.
          This is the only mode where you can recover the full ADC
          dynamic range in post-processing.
        </li>
        <li>
          <strong>EightBit</strong> — 1 byte per pixel. The FPGA
          discards the bottom 6 bits and sends only the top 8. Halves
          the USB bandwidth, but you lose 6 bits of dynamic range
          — you can&apos;t recover faint features that needed those
          low bits.
        </li>
      </ul>

      <div className="dwell-help__rule">
        <strong>Bandwidth and chunk math change with this field.</strong>
        {" "}
        At <code>latency_bytes = 16 384</code>, SixteenBit gives 8 192
        pixels per chunk; EightBit gives 16 384 pixels per chunk —
        twice as many. Validation checks that compare
        &ldquo;expected chunks&rdquo; to &ldquo;received chunks&rdquo;
        already account for this, but if you&apos;re doing your own
        bookkeeping, divide the byte count by 1 for EightBit, 2 for
        SixteenBit.
      </div>

      <p>
        Picking between them:
      </p>

      <ul className="dwell-help__list">
        <li>
          <strong>SixteenBit, default</strong> — when you care about
          image quality at all. Quantitative SEM, EBIC, anything where
          you&apos;ll do contrast adjustment or noise analysis in
          post.
        </li>
        <li>
          <strong>EightBit</strong> — when USB bandwidth is the
          bottleneck and you only need a preview. Large vector scans
          (millions of points) at high dwell rates where the scan
          would otherwise outrun the 480 Mbps USB 2.0 link. The
          on-screen image still looks fine; you just can&apos;t
          quantitatively recover faint signal.
        </li>
      </ul>

      <div className="dwell-help__table-wrap">
        <table className="dwell-help__table">
          <thead>
            <tr>
              <th>Mode</th>
              <th>Bytes / pixel</th>
              <th>1024² frame size</th>
              <th>Dynamic range</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>SixteenBit</td><td>2</td><td>2 MB</td>
              <td>14-bit (16 384 levels)</td>
            </tr>
            <tr>
              <td>EightBit</td><td>1</td><td>1 MB</td>
              <td>8-bit (256 levels)</td>
            </tr>
          </tbody>
        </table>
      </div>
    </HelpPopover>
  );
}
