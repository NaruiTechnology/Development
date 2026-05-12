/**
 * Help for the Cookie field. Used by both raster and vector forms.
 *
 * The cookie is a synchronization tag attached to the
 * SynchronizeCommand at the start of every scan. The FPGA echoes it
 * back as the first 4 bytes of the response stream so the host can
 * verify it's reading data from the scan it just issued, not stale
 * bytes left over in a buffer from a previous scan.
 */
import { HelpPopover } from "./HelpPopover";

export function CookieHelp() {
  return (
    <HelpPopover
      title="Cookie — synchronization tag"
      ariaLabel="What does the cookie field do?"
    >
      <p>
        A 16-bit tag (0..65535) that the macro embeds in the{" "}
        <code>SynchronizeCommand</code> at the start of every scan.
        The FPGA echoes it back as the first 4 bytes of the response
        stream: <code>0xFFFF</code> followed by the cookie. The host
        reads and discards those 4 bytes before consuming pixel data.
      </p>

      <div className="dwell-help__rule">
        <strong>Stream hygiene, not security.</strong> The cookie has
        nothing to do with auth or session state. It exists so the
        host can detect &ldquo;I&apos;m reading data from the wrong
        scan&rdquo; — for example after an aborted scan left bytes in
        the FX2 IN FIFO that didn&apos;t get fully drained before the
        next scan started.
      </div>

      <p>
        Practical guidance:
      </p>

      <ul className="dwell-help__list">
        <li>
          <strong>123 is the convention.</strong> The codebase has used
          it historically; nothing breaks if you leave it.
        </li>
        <li>
          <strong>Change it</strong> when you suspect stale-data
          contamination between scans, or when you want to fingerprint
          different scan types in a multi-tool workflow (e.g.
          calibration scans at 0xCA11 vs production scans at 0xFAB0)
          so your post-processing can route them on the echoed cookie.
        </li>
        <li>
          <strong>Per-request override.</strong> If both the JSON
          default and the UI form set a cookie, the UI value wins —{" "}
          see <code>RasterParams.override(…)</code> in the service.
        </li>
      </ul>

      <p>
        If a scan returns garbage and the very first chunk doesn&apos;t
        start with <code>0xFFFF &lt;cookie&gt;</code>, you&apos;re
        reading bytes that came from somewhere else — either the
        previous scan didn&apos;t finish draining, or a USB reset
        happened mid-transfer. Both call for a reconnect rather than
        a retry with the same connection.
      </p>
    </HelpPopover>
  );
}
