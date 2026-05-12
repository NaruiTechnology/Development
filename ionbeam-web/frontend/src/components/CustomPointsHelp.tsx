/**
 * Help for the Custom points textarea. Explains the input format,
 * coordinate ranges, dwell units, and the cap.
 */
import { HelpPopover } from "./HelpPopover";

export function CustomPointsHelp() {
  return (
    <HelpPopover
      title="Custom points — input format"
      ariaLabel="What format do custom points use?"
    >
      <p>
        One <code>(x, y, dwell)</code> triple per line. Values can be
        separated by commas or whitespace; both work. Empty lines are
        ignored.
      </p>

      <pre style={{
        padding: "8px 10px",
        margin: "8px 0",
        background: "var(--c-bg-input)",
        border: "1px solid var(--c-border-soft)",
        borderRadius: "var(--r-md)",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        whiteSpace: "pre",
      }}>
{`# valid:
0,0,2
100,100,2
200 100 2
8192,8192,8

# invalid (rejected at submit):
1.5,2.0,2      # decimals get truncated to ints
0,0            # missing dwell`}
      </pre>

      <ul className="dwell-help__list">
        <li>
          <strong><code>x</code>, <code>y</code></strong> — DAC code,
          inclusive 0..16383. Values outside the range get clamped
          on the device but won&apos;t produce useful output.
        </li>
        <li>
          <strong><code>dwell</code></strong> — same units as raster
          dwell: number of 125 ns sample periods. 1 is the fastest
          (no supersampling), 2/4/8/16/… are the practical values for
          SNR averaging. Up to 65535 (≈ 8.19 ms per pixel).
        </li>
      </ul>

      <div className="dwell-help__rule">
        <strong>Hard cap: 1 000 000 points.</strong> Matches the
        Pydantic <code>max_length</code> on the API request. The
        backend rejects oversized lists with a 422 before ever
        touching the device.
      </div>

      <p>
        Performance tips for large lists:
      </p>

      <ul className="dwell-help__list">
        <li>
          Enable <strong>Pre-process chunks</strong> below — for
          lists over ~100k points, this can cut total scan time by
          50 % or more.
        </li>
        <li>
          Sort points to minimize beam travel between consecutive
          pixels — large DAC jumps cost settling time on the
          analog path. Boustrophedon (zig-zag) ordering is a good
          default if you don&apos;t have a more specific plan.
        </li>
        <li>
          Visit order is preserved exactly. The macro doesn&apos;t
          reorder, deduplicate, or optimize. If two consecutive
          points have the same <code>(x, y)</code>, the beam dwells
          there for the sum of the two dwells.
        </li>
      </ul>

      <p>
        For programmatic generation, paste from any source that emits
        CSV: a spreadsheet, a Python script, a Jupyter notebook. The
        textarea takes ~50 MB of text before the browser starts to
        feel sluggish, comfortably above the 1M-point cap.
      </p>
    </HelpPopover>
  );
}
