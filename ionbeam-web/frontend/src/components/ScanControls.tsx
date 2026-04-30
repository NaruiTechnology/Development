/**
 * Run / Pause / Stop button group, plus a "Run validated" button that
 * uses the blocking REST endpoint (returns a ScanResult with timing,
 * validation report, and CSV path).
 *
 * Live mode (Run) opens the WebSocket; the FastAPI service streams chunks
 * back and the canvas paints them as they arrive. Pause closes the WS
 * but preserves the partial frame; Stop closes and clears.
 *
 * "Run validated" disables the live buttons because the FastAPI service
 * is single-scan-at-a-time — concurrent calls return 409 (DeviceBusy).
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
  const stream = useScanStream();

  const running = phase === "running" || phase === "stopping";
  const paused = phase === "paused";
  const idle = phase === "idle" || phase === "completed" || phase === "error";

  function onRun() {
    if (kind === "raster") stream.startRaster(raster);
    else stream.startVector(vector);
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
    if (kind === "raster") dispatch(runRasterValidated(raster));
    else dispatch(runVectorValidated(vector));
  }

  function onClear() {
    dispatch(streamReset());
    if (kind === "raster") dispatch(resetRaster({ resolution: raster.resolution }));
    else dispatch(resetVector());
  }

  return (
    <div className="button-row">
      <button
        className="btn btn--primary"
        disabled={running}
        onClick={onRun}
        title="Open a WebSocket and stream chunks live"
      >
        {paused ? "▶ Resume" : "▶ Run"}
      </button>
      <button
        className="btn btn--warn"
        disabled={!running}
        onClick={onPause}
        title="Close the stream but keep the partial frame"
      >
        ❙❙ Pause
      </button>
      <button
        className="btn btn--danger"
        disabled={!(running || paused)}
        onClick={onStop}
        title="Close the stream and clear the frame"
      >
        ■ Stop
      </button>

      <span className="spacer" />

      <button
        className="btn"
        disabled={running}
        onClick={onRunValidated}
        title="POST /scan/{kind}/run — returns timing + validation report"
      >
        Run validated
      </button>
      <button className="btn btn--ghost" disabled={running} onClick={onClear}>
        Clear
      </button>
    </div>
  );
}
