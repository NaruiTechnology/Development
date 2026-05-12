/**
 * Help for the vector default-pattern Resolution field. Sets the
 * sampling density of the built-in DAC sweep when `pattern` is
 * `default`.
 */
import { HelpPopover } from "./HelpPopover";

export function VectorResolutionHelp() {
  return (
    <HelpPopover
      title="Vector resolution — default-sweep density"
      ariaLabel="What does the vector resolution field do?"
    >
      <p>
        When <strong>Pattern</strong> is <code>default</code>, this
        sets how densely the built-in sweep samples the DAC range.
        Coverage is <em>always</em> the full DAC range — smaller
        resolution just sub-samples.
      </p>

      <ul className="dwell-help__list">
        <li>
          <strong>2048 — native (stride 1)</strong>: every DAC code
          is visited. Equivalent to a 2048-resolution raster but
          through the vector path.
        </li>
        <li>
          <strong>1024 — stride 2</strong>: every 2nd DAC code.
          ¼ the points, ¼ the scan time.
        </li>
        <li>
          <strong>512 — stride 4</strong>: every 4th DAC code.
          1/16th the points and time.
        </li>
        <li>
          <strong>256 — stride 8</strong>: every 8th DAC code.
          1/64th the points; useful for fast preview scans.
        </li>
      </ul>

      <div className="dwell-help__rule">
        <strong>Allowed values are 256, 512, 1024, 2048.</strong> The
        backend rejects anything else — the stride must be an
        integer divisor of 2048, or the sweep wouldn&apos;t close
        cleanly at the edges of the DAC range.
      </div>

      <p>
        Unlike raster Resolution, this field has{" "}
        <em>no effect on custom-pattern scans</em>. When you set
        Pattern to <code>custom</code>, the visit list comes entirely
        from the textarea below — this field is ignored.
      </p>

      <div className="dwell-help__table-wrap">
        <table className="dwell-help__table">
          <thead>
            <tr>
              <th>Resolution</th>
              <th>Stride</th>
              <th>Total points</th>
              <th>Approx scan time<br /><span className="muted">(dwell=1)</span></th>
            </tr>
          </thead>
          <tbody>
            <tr><td>256</td><td>8</td><td>65 536</td><td>~8 ms</td></tr>
            <tr><td>512</td><td>4</td><td>262 144</td><td>~33 ms</td></tr>
            <tr><td>1024</td><td>2</td><td>1 048 576</td><td>~131 ms</td></tr>
            <tr><td>2048</td><td>1</td><td>4 194 304</td><td>~524 ms</td></tr>
          </tbody>
        </table>
      </div>

      <p>
        Scan times are order-of-magnitude; vector mode adds USB
        overhead per pixel (every point carries a 6-byte command, vs
        run-length-encoded raster), so real-world numbers run
        somewhat longer.
      </p>
    </HelpPopover>
  );
}
