/**
 * Inline help for the Dwell field. Refactored to use the shared
 * HelpPopover — the open/close/focus/keyboard handling now lives in
 * one place and is shared with every other parameter help on the
 * scan forms.
 *
 * Content is unchanged from the original DwellHelp: explains how the
 * gateware supersampler interprets the dwell value, including the
 * power-of-two pitfall and the sample-rate / SNR table.
 */
import { HelpPopover } from "./HelpPopover";

export function DwellHelp() {
  return (
    <HelpPopover
      title="Dwell — supersampler control"
      ariaLabel="What does the dwell field do?"
    >
      <div className="dwell-help__rule">
        <strong>Pick powers of two.</strong> If your effective sample
        count per pixel isn&apos;t a power of two, the gateware only
        averages the last power of two samples and the remaining ones
        are thrown away. A pixel with 7 samples averages 4 of them;
        with 9 samples, 8 of them. So always pick{" "}
        <code>dwell_time</code> so the resulting sample count per
        pixel is 2, 4, 8, 16, 32, 64, ….
      </div>

      <p>
        The <code>dwell</code> field is the supersampler control.
        Change it:
      </p>

      <ul className="dwell-help__list">
        <li>
          <code>"dwell": 1</code> → supersampler does nothing,
          fastest scan, full 8 MSPS pixel rate
        </li>
        <li>
          <code>"dwell": 2</code> → 2× averaging, half the pixel
          rate (4 Mpix/s), √2 SNR gain
        </li>
        <li>
          <code>"dwell": 4</code> → 4× averaging (2 Mpix/s),
          2× SNR gain
        </li>
        <li>
          <code>"dwell": 8</code> → 8× averaging (1 Mpix/s),
          ~2.8× SNR gain
        </li>
        <li>
          <code>"dwell": 16</code> → 16× averaging (500 kpix/s),
          4× SNR gain
        </li>
        <li>
          … up to <code>dwell = 65535</code> (≈ 8.19 ms per pixel)
        </li>
      </ul>

      <div className="dwell-help__table-wrap">
        <table className="dwell-help__table">
          <thead>
            <tr>
              <th>dwell</th>
              <th>Samples / pixel</th>
              <th>Pixel rate</th>
              <th>
                SNR gain
                <br />
                <span className="muted">(vs dwell=1)</span>
              </th>
              <th>1024² frame time</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>1</td><td>1</td><td>8.0 MPix/s</td>
              <td>1.00×</td><td>131 ms</td>
            </tr>
            <tr>
              <td>2</td><td>2</td><td>4.0 MPix/s</td>
              <td>1.41×</td><td>262 ms</td>
            </tr>
            <tr>
              <td>4</td><td>4</td><td>2.0 MPix/s</td>
              <td>2.00×</td><td>524 ms</td>
            </tr>
            <tr>
              <td>8</td><td>8</td><td>1.0 MPix/s</td>
              <td>2.83×</td><td>1.05 s</td>
            </tr>
            <tr>
              <td>16</td><td>16</td><td>500 kPix/s</td>
              <td>4.00×</td><td>2.10 s</td>
            </tr>
            <tr>
              <td>32</td><td>32</td><td>250 kPix/s</td>
              <td>5.66×</td><td>4.19 s</td>
            </tr>
          </tbody>
        </table>
      </div>
    </HelpPopover>
  );
}
