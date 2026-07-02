/**
 * English help body content. Each entry is a render function returning
 * the JSX body that previously lived inline in the corresponding
 * HelpXxx.tsx file. Pulling them out means:
 *
 *   - The help components themselves become tiny shells that just
 *     pick title / aria from the t() table and body from this map.
 *   - Per-locale variants live next to each other (en.tsx / zh-CN.tsx
 *     / zh-TW.tsx) so a translator can diff them in one window.
 *   - Tree-shaking still works because the helpBodies object is a
 *     plain const export — bundlers can elide unused topic keys if
 *     dead-code elimination is enabled in the future.
 *
 * Numbers and units inside these bodies stay as-is — they're
 * technical constants (DAC depth, sample rate, USB chunk sizes) that
 * don't change with locale. Only the prose around them changes.
 */
import type { ReactNode } from "react";

export type HelpKey =
  | "dwell"
  | "resolution"
  | "latency"
  | "cookie"
  | "outputMode"
  | "frameBlank"
  | "validation"
  | "runValidated"
  | "pattern"
  | "vectorResolution"
  | "customPoints"
  | "preProcess"
  | "canvasView"
  | "grayScale"
  | "scanModes"
  | "magCalibration";

export const helpBodies: Record<HelpKey, () => ReactNode> = {
  dwell: () => (
    <>
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
        <li><code>"dwell": 1</code> → supersampler does nothing, fastest scan, full 8 MSPS pixel rate</li>
        <li><code>"dwell": 2</code> → 2× averaging, half the pixel rate (4 Mpix/s), √2 SNR gain</li>
        <li><code>"dwell": 4</code> → 4× averaging (2 Mpix/s), 2× SNR gain</li>
        <li><code>"dwell": 8</code> → 8× averaging (1 Mpix/s), ~2.8× SNR gain</li>
        <li><code>"dwell": 16</code> → 16× averaging (500 kpix/s), 4× SNR gain</li>
        <li>… up to <code>dwell = 65535</code> (≈ 8.19 ms per pixel)</li>
      </ul>

      <div className="dwell-help__table-wrap">
        <table className="dwell-help__table">
          <thead>
            <tr>
              <th>dwell</th><th>Samples / pixel</th><th>Pixel rate</th>
              <th>SNR gain<br /><span className="muted">(vs dwell=1)</span></th>
              <th>1024² frame time</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>1</td><td>1</td><td>8.0 MPix/s</td><td>1.00×</td><td>131 ms</td></tr>
            <tr><td>2</td><td>2</td><td>4.0 MPix/s</td><td>1.41×</td><td>262 ms</td></tr>
            <tr><td>4</td><td>4</td><td>2.0 MPix/s</td><td>2.00×</td><td>524 ms</td></tr>
            <tr><td>8</td><td>8</td><td>1.0 MPix/s</td><td>2.83×</td><td>1.05 s</td></tr>
            <tr><td>16</td><td>16</td><td>500 kPix/s</td><td>4.00×</td><td>2.10 s</td></tr>
            <tr><td>32</td><td>32</td><td>250 kPix/s</td><td>5.66×</td><td>4.19 s</td></tr>
          </tbody>
        </table>
      </div>
    </>
  ),

  resolution: () => (
    <>
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

      <p>Resolution drives three quantities you usually care about:</p>

      <ul className="dwell-help__list">
        <li><strong>Frame time</strong> — scales as <code>N² × dwell × 125 ns</code>. Doubling the resolution quadruples the time.</li>
        <li><strong>Pixel count for the CSV / figure</strong> — <code>N²</code> values. A 2048² 16-bit raster is 8 MB on the wire and ~32 MB once expanded to a CSV.</li>
        <li><strong>Spatial sampling rate</strong> — finer grid resolves smaller features but with the same total dwell budget, higher resolution means proportionally less time per pixel unless you also raise dwell.</li>
      </ul>

      <div className="dwell-help__table-wrap">
        <table className="dwell-help__table">
          <thead>
            <tr>
              <th>Resolution</th><th>DAC stride</th><th>Total pixels</th>
              <th>Frame time<br /><span className="muted">(dwell = 16)</span></th>
              <th>16-bit output</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>256</td><td>64</td><td>65 536</td><td>16 ms</td><td>128 KB</td></tr>
            <tr><td>512</td><td>32</td><td>262 144</td><td>66 ms</td><td>512 KB</td></tr>
            <tr><td>1024</td><td>16</td><td>1 048 576</td><td>262 ms</td><td>2 MB</td></tr>
            <tr><td>2048</td><td>8</td><td>4 194 304</td><td>1.05 s</td><td>8 MB</td></tr>
          </tbody>
        </table>
      </div>

      <p>
        Frame times above assume continuous streaming at the
        supersampler&apos;s 8 MSPS sample rate. Real-world numbers
        are slightly longer due to per-chunk USB overhead and the
        pipeline-drain padding at the tail of each scan.
      </p>
    </>
  ),

  latency: () => (
    <>
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
        Pixels per chunk = <code>latency_bytes / sample_size</code>{" "}
        where <code>sample_size</code> is 2 for SixteenBit, 1 for
        EightBit. At default 16 384 bytes and 16-bit output, each
        chunk is 8 192 pixels.
      </p>

      <p>The tradeoffs:</p>

      <ul className="dwell-help__list">
        <li><strong>Smaller latency (e.g. 4 096)</strong> — more chunks, more USB round-trips per scan, lower throughput. Aborts and mid-scan UI updates land sooner, since the receiver checks the abort flag between chunks.</li>
        <li><strong>Larger latency (e.g. 32 768)</strong> — fewer chunks, better throughput, slightly higher peak host memory in flight. Mid-scan aborts can take up to one chunk longer to land.</li>
        <li><strong>Sender pipeline</strong> — up to <code>max_pipeline</code> (32 for raster, 4 for vector) chunks can be in flight on the OUT endpoint at once. At large latency × large max_pipeline the in-flight window can exceed the FX2 OUT FIFO and stall — the macros pre-tune for this, so you don&apos;t normally need to touch max_pipeline.</li>
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
            <tr><td>4 096</td><td>2 048</td><td>512</td><td>Fastest abort response</td></tr>
            <tr><td>8 192</td><td>4 096</td><td>256</td><td>Vector default-ish</td></tr>
            <tr><td>16 384</td><td>8 192</td><td>128</td><td>Raster default</td></tr>
            <tr><td>32 768</td><td>16 384</td><td>64</td><td>Highest throughput</td></tr>
          </tbody>
        </table>
      </div>
    </>
  ),

  cookie: () => (
    <>
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

      <p>Practical guidance:</p>

      <ul className="dwell-help__list">
        <li><strong>123 is the convention.</strong> The codebase has used it historically; nothing breaks if you leave it.</li>
        <li><strong>Change it</strong> when you suspect stale-data contamination between scans, or when you want to fingerprint different scan types in a multi-tool workflow (e.g. calibration scans at 0xCA11 vs production scans at 0xFAB0) so your post-processing can route them on the echoed cookie.</li>
        <li><strong>Per-request override.</strong> If both the JSON default and the UI form set a cookie, the UI value wins — see <code>RasterParams.override(…)</code> in the service.</li>
      </ul>

      <p>
        If a scan returns garbage and the very first chunk doesn&apos;t
        start with <code>0xFFFF &lt;cookie&gt;</code>, you&apos;re
        reading bytes that came from somewhere else — either the
        previous scan didn&apos;t finish draining, or a USB reset
        happened mid-transfer. Both call for a reconnect rather than
        a retry with the same connection.
      </p>
    </>
  ),

  outputMode: () => (
    <>
      <p>
        Selects how each ADC sample is serialized on the USB IN path
        from the FPGA back to the host. Both modes always use the
        full 14-bit ADC; the difference is only in how those bits are
        packed on the wire.
      </p>

      <ul className="dwell-help__list">
        <li><strong>SixteenBit</strong> — 2 bytes per pixel. The raw 14-bit ADC reading is zero-extended into a uint16, little-endian. This is the only mode where you can recover the full ADC dynamic range in post-processing.</li>
        <li><strong>EightBit</strong> — 1 byte per pixel. The FPGA discards the bottom 6 bits and sends only the top 8. Halves the USB bandwidth, but you lose 6 bits of dynamic range — you can&apos;t recover faint features that needed those low bits.</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>Bandwidth and chunk math change with this field.</strong>{" "}
        At <code>latency_bytes = 16 384</code>, SixteenBit gives 8 192
        pixels per chunk; EightBit gives 16 384 pixels per chunk —
        twice as many. Validation checks that compare
        &ldquo;expected chunks&rdquo; to &ldquo;received chunks&rdquo;
        already account for this, but if you&apos;re doing your own
        bookkeeping, divide the byte count by 1 for EightBit, 2 for
        SixteenBit.
      </div>

      <p>Picking between them:</p>

      <ul className="dwell-help__list">
        <li><strong>SixteenBit, default</strong> — when you care about image quality at all. Quantitative SEM, EBIC, anything where you&apos;ll do contrast adjustment or noise analysis in post.</li>
        <li><strong>EightBit</strong> — when USB bandwidth is the bottleneck and you only need a preview. Large vector scans (millions of points) at high dwell rates where the scan would otherwise outrun the 480 Mbps USB 2.0 link. The on-screen image still looks fine; you just can&apos;t quantitatively recover faint signal.</li>
      </ul>

      <div className="dwell-help__table-wrap">
        <table className="dwell-help__table">
          <thead>
            <tr><th>Mode</th><th>Bytes / pixel</th><th>1024² frame size</th><th>Dynamic range</th></tr>
          </thead>
          <tbody>
            <tr><td>SixteenBit</td><td>2</td><td>2 MB</td><td>14-bit (16 384 levels)</td></tr>
            <tr><td>EightBit</td><td>1</td><td>1 MB</td><td>8-bit (256 levels)</td></tr>
          </tbody>
        </table>
      </div>
    </>
  ),

  frameBlank: () => (
    <>
      <p>
        Controls what the electron / ion beam does in the dead time
        between the end of one frame and the start of the next.
      </p>

      <ul className="dwell-help__list">
        <li><strong>Unchecked (false, default)</strong> — beam stays unblanked between frames. Lowest restart latency: the next frame can begin immediately. Choose this for live focus / imaging where you&apos;re scanning continuously and visually tracking the result.</li>
        <li><strong>Checked (true)</strong> — the macro appends a <code>BlankCommand(enable=True)</code> after the last pixel of the frame, blanking the beam during retrace and any idle period before the next scan. Also blanks the beam when a scan is aborted mid-frame. Choose this for beam-sensitive samples (radiation-sensitive specimens, resists during lithography) or anywhere you don&apos;t want continuous exposure between captures.</li>
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
        mid-frame and frame blank is <strong>off</strong>, the beam
        stays positioned at the last completed pixel until you start
        the next scan. With frame blank <strong>on</strong>, the
        macro injects the BlankCommand at the next chunk boundary,
        blanking the beam within tens of milliseconds of the abort.
      </p>
    </>
  ),

  validation: () => (
    <>
      <p>
        When enabled, the service runs a battery of cheap checks on
        the captured byte stream after the scan completes, before
        returning the result. They run in &lt; 100 ms for typical
        scans and don&apos;t touch the device — they just inspect the
        in-memory chunk list.
      </p>

      <p>Raster checks:</p>

      <ul className="dwell-help__list">
        <li><strong>chunk count</strong> — the receiver got the number of chunks predicted by <code>ceil(resolution² / pixels_per_chunk)</code>. A mismatch means the FPGA hit a back-pressure stall or the scan was interrupted.</li>
        <li><strong>chunk size</strong> — every chunk except the last is exactly <code>latency_bytes / sample_size</code> samples long. Truncated chunks usually mean an output_mode / latency_bytes alignment mismatch.</li>
      </ul>

      <p>Vector checks:</p>

      <ul className="dwell-help__list">
        <li><strong>non-empty</strong> — every chunk contains at least one sample. An all-empty stream is a sign the scan never actually triggered (e.g. the FPGA didn&apos;t see the SynchronizeCommand).</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>The validation report drives the result panel.</strong>{" "}
        When disabled, you still get the chunk count and timing in the
        run report, but the per-check pass/fail list is omitted and
        the Run pane shows just &ldquo;validation: off&rdquo;.
      </div>

      <p>When to turn off:</p>

      <ul className="dwell-help__list">
        <li><strong>High-rate repeated scans</strong> where you&apos;ve already confirmed the setup is healthy and you don&apos;t need the report for every run.</li>
        <li><strong>Maximum-throughput streaming</strong> — although the checks are cheap (&lt; 100 ms), they do hold the result in RAM long enough to scan it. Disabling skips that hold.</li>
      </ul>

      <p>
        For first-time setup, debugging a flaky USB cable, or
        validating a new bitstream, keep this on. The checks are
        designed to catch exactly the &ldquo;scan completed but the
        data is silently wrong&rdquo; failure modes that are
        otherwise expensive to notice.
      </p>
    </>
  ),

  runValidated: () => (
    <>
      <p>
        Use <strong>Run validated</strong> when you want the blocking
        scan endpoint instead of the live stream. It works in both
        raster and vector mode, waits for the scan to finish, and
        returns the timing data plus the validation report in one
        response.
      </p>

      <div className="dwell-help__rule">
        <strong>Use this when you need the report.</strong> The
        regular <code>Run</code> button streams chunks live and does
        not wait for the validation payload. <code>Run validated</code>{" "}
        is the path that produces the post-scan checks shown in the
        Run report panel.
      </div>

      <p>
        The validation checkbox in the raster or vector parameter form
        still controls whether the per-check pass/fail list is included
        in the result. This button just chooses the blocking endpoint
        that returns the scan result object.
      </p>
    </>
  ),

  pattern: () => (
    <>
      <p>
        Vector mode lets the host send an explicit list of points to
        the FPGA — one <code>(x, y, dwell)</code> triple per pixel —
        rather than letting the gateware generate a raster sweep
        internally. This field picks where that list comes from.
      </p>

      <ul className="dwell-help__list">
        <li><strong>Default sweep</strong> — the macro generates a row-by-row sweep across the full DAC range at the density set by <strong>Resolution</strong>. Equivalent to a raster scan, but goes through the vector command path. Useful when you want to A/B-compare raster vs vector for the same coverage, or when raster mode is unavailable for some gateware reason.</li>
        <li><strong>Custom points</strong> — you supply the point list in the textarea that appears below. Visit order is exactly the order you write. Every kind of non-raster scan goes through this: ROI-only scans, sparse imaging, lithography paths, calibration spots, anything with a tailored visit order.</li>
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
    </>
  ),

  vectorResolution: () => (
    <>
      <p>
        When <strong>Pattern</strong> is <code>default</code>, this
        sets how densely the built-in sweep samples the DAC range.
        Coverage is <em>always</em> the full DAC range — smaller
        resolution just sub-samples.
      </p>

      <ul className="dwell-help__list">
        <li><strong>2048 — native (stride 1)</strong>: every DAC code is visited. Equivalent to a 2048-resolution raster but through the vector path.</li>
        <li><strong>1024 — stride 2</strong>: every 2nd DAC code. ¼ the points, ¼ the scan time.</li>
        <li><strong>512 — stride 4</strong>: every 4th DAC code. 1/16th the points and time.</li>
        <li><strong>256 — stride 8</strong>: every 8th DAC code. 1/64th the points; useful for fast preview scans.</li>
        <li><strong>Custom values 1..2048</strong>: still cover the full DAC range, but the sample spacing is distributed as evenly as possible instead of matching an exact integer stride.</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>Allowed values are 1..2048.</strong> The preset powers
        of two keep the mapping exact on the 2048 x 2048 DAC preview
        grid, while custom values trade that neat stride relationship
        for finer control over total point count.
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
            <tr><th>Resolution</th><th>Stride</th><th>Total points</th><th>Approx scan time<br /><span className="muted">(dwell=1)</span></th></tr>
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
    </>
  ),

  customPoints: () => (
    <>
      <p>
        One <code>(x, y, dwell)</code> triple per line. Values can be
        separated by commas or whitespace; both work. Empty lines are
        ignored.
      </p>

      <pre style={{
        padding: "8px 10px", margin: "8px 0",
        background: "var(--c-bg-input)",
        border: "1px solid var(--c-border-soft)",
        borderRadius: "var(--r-md)",
        fontFamily: "var(--font-mono)", fontSize: 12,
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
        <li><strong><code>x</code>, <code>y</code></strong> — DAC code, inclusive 0..16383. Values outside the range get clamped on the device but won&apos;t produce useful output.</li>
        <li><strong><code>dwell</code></strong> — same units as raster dwell: number of 125 ns sample periods. 1 is the fastest (no supersampling), 2/4/8/16/… are the practical values for SNR averaging. Up to 65535 (≈ 8.19 ms per pixel).</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>Hard cap: 1 000 000 points.</strong> Matches the
        Pydantic <code>max_length</code> on the API request. The
        backend rejects oversized lists with a 422 before ever
        touching the device.
      </div>

      <p>Performance tips for large lists:</p>

      <ul className="dwell-help__list">
        <li>Enable <strong>Pre-process chunks</strong> below — for lists over ~100k points, this can cut total scan time by 50 % or more.</li>
        <li>Sort points to minimize beam travel between consecutive pixels — large DAC jumps cost settling time on the analog path. Boustrophedon (zig-zag) ordering is a good default if you don&apos;t have a more specific plan.</li>
        <li>Visit order is preserved exactly. The macro doesn&apos;t reorder, deduplicate, or optimize. If two consecutive points have the same <code>(x, y)</code>, the beam dwells there for the sum of the two dwells.</li>
      </ul>

      <p>
        For programmatic generation, paste from any source that emits
        CSV: a spreadsheet, a Python script, a Jupyter notebook. The
        textarea takes ~50 MB of text before the browser starts to
        feel sluggish, comfortably above the 1M-point cap.
      </p>
    </>
  ),

  preProcess: () => (
    <>
      <p>
        Every vector pixel ships as a 6-byte command on the OUT path:
        <code>x</code> (2 B) + <code>y</code> (2 B) + <code>dwell</code>{" "}
        (2 B), big-endian. The macro batches those into chunks sized
        by <strong>Latency</strong>. <em>When</em> that batching
        happens is what this checkbox controls.
      </p>

      <ul className="dwell-help__list">
        <li><strong>Unchecked (lazy, default for streaming)</strong> — chunks are encoded on demand inside the sender coroutine as the transfer consumes them. Lowest memory: only the in-flight window of chunks (max_pipeline × latency_bytes) lives in RAM at once. But the host CPU now has to keep up with USB; if the iterator producing the points is slow, the device can stall waiting for the next chunk.</li>
        <li><strong>Checked (pre-process)</strong> — the macro&apos;s <code>_pre_process_chunks()</code> runs once at scan start, materializing every chunk into a memoryview held by the command object. Transfer is then bound only by USB throughput, not by host-side encoding speed. Cost: peak RAM equal to roughly <code>6 × total_pixels</code> bytes (so 6 MB for a million-point scan).</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>The wet-run pre-process time is reported separately.</strong>{" "}
        <code>process_time_s</code> in the run report shows how long
        the pre-processing took; <code>send_time_s</code> shows USB
        transfer time alone. The two used to be conflated in older
        UIs.
      </div>

      <p>When to enable:</p>

      <ul className="dwell-help__list">
        <li><strong>Yes:</strong> any custom point list with more than ~100k points, especially if the point iterator does non-trivial work (computed paths, image-based rastering).</li>
        <li><strong>Yes:</strong> the default sweep at high resolution (1024+) when total throughput matters.</li>
        <li><strong>No:</strong> very long scans where peak RAM matters more than total time (≥ 10M points and you&apos;re running on a memory-constrained host).</li>
        <li><strong>No:</strong> small scans under ~10k points — pre-processing overhead is comparable to the savings.</li>
      </ul>
    </>
  ),

  canvasView: () => (
    <>
      <p>
        This control only changes how the current vector buffer is
        drawn on the canvas. It does not change the scan itself.
      </p>

      <ul className="dwell-help__list">
        <li>
          <strong>Decimated</strong> — shows the live vector image at
          the sampled grid size. Each pixel corresponds to a sample
          index in the vector buffer.
        </li>
        <li>
          <strong>Native</strong> — expands the vector image to the
          DAC grid. When the selected vector resolution is below 2048,
          each sampled cell is block-filled to the full DAC stride so
          you can inspect coverage on the native coordinate grid.
        </li>
      </ul>

      <div className="dwell-help__rule">
        <strong>Stride 1 means both views are identical.</strong>
        When vector resolution is 2048, there is no decimation, so
        switching the view only changes the label.
      </div>

      <p>
        Use <strong>Decimated</strong> when you want to reason about
        sample order and image sparsity. Use <strong>Native</strong>
        when you want to inspect the DAC-space footprint of a reduced
        vector grid.
      </p>
    </>
  ),

  grayScale: () => (
    <>
      <p>
        The gray-scale spectrum shows the gray values currently present
        in the rendered live image or loaded bitmap. Each box is one
        sampled gray level, and the step spinner controls how many
        boxes are shown across the available range.
      </p>

      <div className="dwell-help__rule">
        <strong>Selecting a box does not change the image by itself.</strong>{" "}
        It only marks the gray-level interval that the next scan action
        will use when you confirm the choice.
      </div>

      <ul className="dwell-help__list">
        <li><strong>Skip</strong> sends explicit blanked vector points for the highlighted gray levels inside the selected ROI sub-area, so those pixels are skipped during the next scan.</li>
        <li><strong>Spot</strong> sends explicit unblanked vector points for the highlighted gray levels and blanks the other pixels inside the selected ROI sub-area.</li>
        <li><strong>Clear</strong> resets the current gray-level selection back to normal scan behavior.</li>
        <li>The selection applies only to the defined ROI sub-area; pixels outside that area keep their normal scan handling.</li>
      </ul>

      <p>
        Use <strong>Select</strong> to confirm the pending mode and
        persist it into the scan store for the next scan step.
      </p>
    </>
  ),

  scanModes: () => (
    <>
      <p>
        <strong>Raster</strong> scans a fixed rectangular grid in
        row/column order. The beam follows the full frame or ROI
        bounds, which makes it the natural choice for regular imaging,
        full-frame coverage, and simple repeatable acquisition.
      </p>

      <p>
        <strong>Vector</strong> scans an explicit list of points. The
        beam visits only the coordinates you send, so it is better for
        sparse patterns, irregular shapes, annotation-style work, and
        selective beam control such as gray-level skip/spot.
      </p>

      <ul className="dwell-help__list">
        <li><strong>Use Raster</strong> when you want a conventional image, predictable grid spacing, or a full ROI sweep without custom point scripting.</li>
        <li><strong>Use Vector</strong> when you need to skip or emphasize selected pixels, draw non-rectangular patterns, or target only a subset of the ROI with finer beam control.</li>
        <li>Both modes can render the same live image on screen, but the host command they send to the hardware is different.</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>Practical rule of thumb:</strong> Raster is for
        coverage, vector is for selectivity.
      </div>
    </>
  ),

  magCalibration: () => (
    <>
      <p>
        Magnification calibration maps a microscope magnification value
        to the full horizontal field of view (HFOV) in meters for the
        selected beam.
      </p>

      <div className="dwell-help__rule">
        <strong>HFOV formula.</strong>{" "}
        <code>HFOV_m = measured_length_m × (image_resolution_px / measured_line_px)</code>.
        The measured length is the real-world distance represented by
        the line you measured, and measured pixels is that line&apos;s
        pixel length in the image.
      </div>

      <ul className="dwell-help__list">
        <li><strong>Magnification</strong> is the microscope mag setting for the current point.</li>
        <li><strong>Image resolution</strong> should match the full image axis used for calibration, usually <code>max(width_px, height_px)</code>.</li>
        <li><strong>Update curve</strong> stores the computed HFOV at the current magnification.</li>
        <li><strong>Save</strong> persists the per-beam map under <code>magCalibration.beams[beam].m_per_fov</code>.</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>X/Y relationship.</strong> Magnification calibration
        stores HFOV only. The ROI X/Y calibration owns the viewport-to-DUT
        coordinate mapping. If pixels are square, VFOV is derived from
        HFOV by the image aspect ratio; otherwise X and Y require separate
        ROI calibration.
      </div>

      <p>
        <strong>Import CSV</strong> expects a magnification-calibration
        CSV exported from this panel: <code>Magnification,FOV (m)</code>.
        It is not the normal scan output CSV. Scan result CSV files contain
        sampled image data and are intentionally not parsed as mag-cal
        curves.
      </p>

      <p>
        Saved results are written into the stream configuration and served
        back through <code>/api/admin/mag-calibration</code>. Other scan
        logic can consume that per-beam map from defaults/config; the
        import button itself only replaces the current mag-cal point table.
      </p>

      <p>
        The chart is drawn on log-log axes because FOV normally changes
        approximately inversely with magnification. CSV import/export
        uses two data columns: magnification and FOV meters.
      </p>
    </>
  ),
};
