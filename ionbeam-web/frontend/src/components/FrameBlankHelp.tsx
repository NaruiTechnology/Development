/**
 * Help for the Frame blank checkbox on raster scans. Controls
 * whether a `BlankCommand(enable=True)` is appended after the last
 * pixel of every frame, plus inserted after an aborted frame, to
 * leave the beam blanked between scans.
 */
import { HelpPopover } from "./HelpPopover";

export function FrameBlankHelp() {
  return (
    <HelpPopover
      title="Frame blank — beam state between frames"
      ariaLabel="What does the frame blank field do?"
    >
      <p>
        Controls what the electron / ion beam does in the dead time
        between the end of one frame and the start of the next.
      </p>

      <ul className="dwell-help__list">
        <li>
          <strong>Unchecked (false, default)</strong> — beam stays
          unblanked between frames. Lowest restart latency: the next
          frame can begin immediately. Choose this for live focus /
          imaging where you&apos;re scanning continuously and visually
          tracking the result.
        </li>
        <li>
          <strong>Checked (true)</strong> — the macro appends a{" "}
          <code>BlankCommand(enable=True)</code> after the last pixel
          of the frame, blanking the beam during retrace and any idle
          period before the next scan. Also blanks the beam when a
          scan is aborted mid-frame. Choose this for beam-sensitive
          samples (radiation-sensitive specimens, resists during
          lithography) or anywhere you don&apos;t want continuous
          exposure between captures.
        </li>
      </ul>

      <div className="dwell-help__rule">
        <strong>Doesn&apos;t affect in-frame blanking.</strong> Pixels
        within a frame are always unblanked; this checkbox only
        controls the boundary state. If you need per-pixel or
        per-region blanking inside a scan, build a vector pattern
        and embed <code>BlankCommand</code>s in the point list.
      </div>

      <p>
        Subtle behavior on abort: if you click <strong>Stop</strong>{" "}
        mid-frame and frame blank is{" "}
        <strong>off</strong>, the beam stays positioned at the last
        completed pixel until you start the next scan. With frame
        blank <strong>on</strong>, the macro injects the
        BlankCommand at the next chunk boundary, blanking the beam
        within tens of milliseconds of the abort.
      </p>
    </HelpPopover>
  );
}
