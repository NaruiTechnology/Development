/**
 * Run / Pause / Stop button group, plus a "Run validated" button that
 * uses the blocking REST endpoint (returns a ScanResult with timing,
 * validation report, and CSV path).
 *
 * Pause vs. Stop semantics
 * ------------------------
 * The FPGA pipeline is one-shot — once a scan starts, it runs until the
 * point list is exhausted; there is no real mid-frame pause. So Pause
 * and Stop both close the WS (which calls gen.aclose() server-side and
 * cancels the scan), and the only difference is whether the partial
 * frame on the canvas is preserved.
 *
 *   Run    : start a fresh scan
 *   Pause  : end the scan, keep the partial image (operator wants to
 *            inspect what was captured before continuing)
 *   Stop   : end the scan, clear the image
 *
 * After Pause, pressing Run starts a new scan from sample 0 and clears
 * the kept image. We don't label that "Resume" because the previous
 * implementation's "Resume" pretended the partial frame would continue
 * from where it left off — which was never true. The button stays
 * labeled "Run" so the operator knows what it actually does.
 */
import { useAppDispatch, useAppSelector } from "../store";
import {
  runRasterValidated,
  runVectorValidated,
  streamReset,
  type ScanKind,
} from "../store/scanSlice";
import { resetRaster, resetVector } from "../store/imageSlice";
import { useScanStream } from "../hooks/useScanStream";

export function ScanControls({ kind }: { kind: ScanKind }) {
  const dispatch = useAppDispatch();
  const phase = useAppSelector((s) => s.scan.phase);
  const raster = useAppSelector((s) => s.scan.raster);
  const vector = useAppSelector((s) => s.scan.vector);
  const roi = useAppSelector((s) => s.scan.roi.selection);
  const stream = useScanStream();

  // Phase taxonomy:
  //   idle/completed/error  → no active stream; safe to start a new one
  //   running               → WS open, chunks arriving
  //   stopping              → close requested, awaiting onclose handshake
  //   paused                → close completed, image preserved
  const streaming = phase === "running";
  const closing = phase === "stopping";
  const paused = phase === "paused";

  function onRun() {
    if (kind === "roi") return;
    if (kind === "raster") stream.startRaster({ ...raster, roi });
    else stream.startVector({ ...vector, roi });
  }

  function onPause() {
    stream.pause();
  }

  function onStop() {
    stream.stop();
    if (kind === "raster") dispatch(resetRaster({ resolution: raster.resolution }));
    else dispatch(resetVector());
  }

  function onRunValidated() {
    if (kind === "roi") return;
    if (kind === "raster") dispatch(runRasterValidated({ ...raster, roi }));
    else dispatch(runVectorValidated({ ...vector, roi }));
  }

  function onClear() {
    dispatch(streamReset());
    if (kind === "raster") dispatch(resetRaster({ resolution: raster.resolution }));
    else dispatch(resetVector());
  }

  // Run is enabled when not actively streaming or closing. Includes
  // paused so the operator can start a fresh scan after inspecting a
  // captured partial frame.
  const runDisabled = streaming || closing;

  // Pause only makes sense while a stream is actively delivering chunks.
  // Disable during the close handshake (so a double-click doesn't queue
  // another close) and once already paused.
  const pauseDisabled = !streaming;

  // Stop is enabled while there's anything to stop or anything on the
  // canvas. Disabled during the close handshake — a second close
  // attempt would race the first.
  const stopDisabled = !(streaming || paused);

  return (
    <div className="button-row">
      <button
        className="btn btn--primary"
        disabled={runDisabled || kind === "roi"}
        onClick={onRun}
        title={
          paused
            ? "Start a fresh scan (the kept image will be replaced)"
            : "Open a WebSocket and stream chunks live"
        }
      >
        ▶ Run
      </button>
      <button
        className="btn btn--warn"
        disabled={pauseDisabled}
        onClick={onPause}
        title="End the scan but keep the partial image on the canvas"
      >
        {closing ? "❙❙ Pausing…" : "❙❙ Pause"}
      </button>
      <button
        className="btn btn--danger"
        disabled={stopDisabled}
        onClick={onStop}
        title="End the scan and clear the canvas"
      >
        ■ Stop
      </button>

      <span className="spacer" />

      <button
        className="btn"
        disabled={runDisabled || kind === "roi"}
        onClick={onRunValidated}
        title="POST /scan/{kind}/run — returns timing + validation report"
      >
        Run validated
      </button>
      <button className="btn btn--ghost" disabled={runDisabled} onClick={onClear}>
        Clear
      </button>
    </div>
  );
}
