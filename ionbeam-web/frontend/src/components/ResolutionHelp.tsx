/**
 * Help for the raster Resolution field.
 *
 * Explains the N×N pixel grid, what it means for DAC stride and
 * sampling density, and how it interacts with dwell to determine
 * frame time and output file size.
 */
import { HelpPopover } from "./HelpPopover";

export function ResolutionHelp() {
  return (
    <HelpPopover
      title="Resolution — pixel grid size"
      ariaLabel="What does the resolution field do?"
    >
      <p>
        Sets the raster grid to <code>N × N</code> pixels. The beam
        sweeps the same physical DAC range no matter what you pick;
        smaller resolution just samples fewer points along each axis.
        The DAC has 16 384 codes (0..16383); at <code>N = 2048</code>{" "}
        every 8th DAC code is sampled, and at <code>N = 256</code>{" "}
        every 64th.
      </p>

      <div className="dwell-help__rule">
        <strong>Powers of two only.</strong> The DACCodeRange helper
        divides the 16 384-code DAC range by <code>N</code> with
        integer math; non-power-of-two resolutions produce uneven
        strides and image artifacts. Stick to 256, 512, 1024, 2048.
      </div>

      <p>
        Resolution drives three quantities you usually care about:
      </p>

      <ul className="dwell-help__list">
        <li>
          <strong>Frame time</strong> — scales as{" "}
          <code>N² × dwell × 125 ns</code>. Doubling the resolution
          quadruples the time.
        </li>
        <li>
          <strong>Pixel count for the CSV / figure</strong> —{" "}
          <code>N²</code> values. A 2048² 16-bit raster is 8 MB on
          the wire and ~32 MB once expanded to a CSV.
        </li>
        <li>
          <strong>Spatial sampling rate</strong> — finer grid resolves
          smaller features but with the same total dwell budget,
          higher resolution means proportionally less time per pixel
          unless you also raise dwell.
        </li>
      </ul>

      <div className="dwell-help__table-wrap">
        <table className="dwell-help__table">
          <thead>
            <tr>
              <th>Resolution</th>
              <th>DAC stride</th>
              <th>Total pixels</th>
              <th>Frame time<br /><span className="muted">(dwell = 2)</span></th>
              <th>16-bit output</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>256</td><td>64</td><td>65 536</td>
              <td>16 ms</td><td>128 KB</td>
            </tr>
            <tr>
              <td>512</td><td>32</td><td>262 144</td>
              <td>66 ms</td><td>512 KB</td>
            </tr>
            <tr>
              <td>1024</td><td>16</td><td>1 048 576</td>
              <td>262 ms</td><td>2 MB</td>
            </tr>
            <tr>
              <td>2048</td><td>8</td><td>4 194 304</td>
              <td>1.05 s</td><td>8 MB</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p>
        Frame times above assume continuous streaming at the
        supersampler&apos;s 8 MSPS sample rate. Real-world numbers
        are slightly longer due to per-chunk USB overhead and the
        pipeline-drain padding at the tail of each scan.
      </p>
    </HelpPopover>
  );
}
