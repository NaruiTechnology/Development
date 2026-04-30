/**
 * Renders the ScanResult returned by the blocking REST endpoints.
 *
 * Shape comes from glasgow_service.models.ScanResult — the same model
 * Swagger documents at /docs. We display: kind, chunks, bytes, expected
 * chunks (raster), pixels per chunk (raster), send time, process time
 * (vector pre-process), CSV path, and the validation checks list.
 */
import { useAppSelector } from "../store";

export function ValidationPanel() {
  const result = useAppSelector((s) => s.scan.lastResult);
  const error = useAppSelector((s) => s.scan.errorMessage);

  if (error) {
    return (
      <div className="card__body">
        <div style={{ color: "var(--c-danger)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          {error}
        </div>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="card__body muted" style={{ fontSize: 12 }}>
        No validated run yet. Press <b>Run validated</b> to invoke
        <code> POST /scan/{`{kind}`}/run</code> and see timing + checks here.
      </div>
    );
  }

  const v = result.validation;

  return (
    <div className="card__body">
      <div className="canvas-meta" style={{ marginTop: 0, flexWrap: "wrap" }}>
        <span>
          kind <b>{result.kind}</b>
        </span>
        <span>
          chunks <b>{result.chunks.toLocaleString()}</b>
          {result.expected_chunks != null && (
            <span className="muted"> / {result.expected_chunks.toLocaleString()}</span>
          )}
        </span>
        <span>
          bytes <b>{result.bytes.toLocaleString()}</b>
        </span>
        {result.pixels_per_chunk != null && (
          <span>
            pixels/chunk <b>{result.pixels_per_chunk.toLocaleString()}</b>
          </span>
        )}
        {result.send_time_s != null && (
          <span>
            send <b>{fmtSec(result.send_time_s)}</b>
          </span>
        )}
        {result.process_time_s != null && (
          <span>
            process <b>{fmtSec(result.process_time_s)}</b>
          </span>
        )}
      </div>

      {result.csv_path && (
        <p style={{ fontSize: 12, marginTop: 10 }}>
          CSV written to <code className="mono">{result.csv_path}</code>
        </p>
      )}

      {v && (
        <>
          <div className="divider" />
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="card__title">Validation</span>
            <span className="spacer" />
            <span
              className="status-pill"
              data-state={v.passed ? "idle" : "error"}
            >
              {v.passed ? "All checks passed" : "Failures"}
            </span>
          </div>
          <ul className="validation-list">
            {v.checks.map((c) => (
              <li key={c.name}>
                <span className={c.passed ? "pass" : "fail"}>
                  {c.passed ? "PASS" : "FAIL"}
                </span>
                <span>{c.name}</span>
                <span className="muted">{c.detail}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function fmtSec(s: number): string {
  if (s < 1e-3) return `${(s * 1e6).toFixed(0)} µs`;
  if (s < 1) return `${(s * 1e3).toFixed(1)} ms`;
  return `${s.toFixed(3)} s`;
}
