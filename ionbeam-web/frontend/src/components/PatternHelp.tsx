/**
 * Help for the vector Pattern field. Selects between the built-in
 * full-DAC-range sweep and a user-supplied list of (x, y, dwell)
 * points.
 */
import { HelpPopover } from "./HelpPopover";

export function PatternHelp() {
  return (
    <HelpPopover
      title="Pattern — default sweep vs custom points"
      ariaLabel="What does the pattern field do?"
    >
      <p>
        Vector mode lets the host send an explicit list of points to
        the FPGA — one <code>(x, y, dwell)</code> triple per pixel —
        rather than letting the gateware generate a raster sweep
        internally. This field picks where that list comes from.
      </p>

      <ul className="dwell-help__list">
        <li>
          <strong>Default sweep</strong> — the macro generates a
          row-by-row sweep across the full DAC range at the density
          set by <strong>Resolution</strong>. Equivalent to a raster
          scan, but goes through the vector command path. Useful when
          you want to A/B-compare raster vs vector for the same
          coverage, or when raster mode is unavailable for some
          gateware reason.
        </li>
        <li>
          <strong>Custom points</strong> — you supply the point list
          in the textarea that appears below. Visit order is exactly
          the order you write. Every kind of non-raster scan goes
          through this: ROI-only scans, sparse imaging, lithography
          paths, calibration spots, anything with a tailored visit
          order.
        </li>
      </ul>

      <div className="dwell-help__rule">
        <strong>Vector is slower per-pixel than raster.</strong> Every
        vector pixel carries an explicit (x, y, dwell) triple — 6
        bytes on the OUT path — whereas raster pixels are
        run-length-encoded (RasterPixelRunCommand) at ~5 bytes per
        entire row. Default-pattern vector at 2048² will be roughly
        an order of magnitude slower to send than a raster of the
        same coverage. Use vector when you need its flexibility, not
        when raster would work.
      </div>

      <p>
        Both modes go through the same SynchronizeCommand cookie
        handshake, the same SixteenBit/EightBit output path, and the
        same drain-padding tail at the end of the scan. Switching
        between them mid-session is free; nothing on the FPGA needs
        reconfiguration.
      </p>
    </HelpPopover>
  );
}
