import { useEffect } from "react";

import { fetchStatus, reconnectDevice } from "../store/statusSlice";
import { useAppDispatch, useAppSelector } from "../store";

const STATE_LABELS: Record<string, string> = {
  idle: "Idle",
  busy: "Scanning",
  connecting: "Connecting",
  error: "Error",
  disconnected: "Disconnected",
};

export function Header() {
  const dispatch = useAppDispatch();
  const status = useAppSelector((s) => s.status.service);

  // Refresh status while idle/error so the pill stays current. We pause it
  // during 'busy' to avoid hammering the FastAPI service mid-scan; the WS
  // 'done' event already updates the UI when a stream completes.
  useEffect(() => {
    dispatch(fetchStatus());
    const t = setInterval(() => {
      const s = status?.state;
      if (s === "busy" || s === "connecting") return;
      dispatch(fetchStatus());
    }, 4000);
    return () => clearInterval(t);
  }, [dispatch, status?.state]);

  const state = status?.state ?? "disconnected";

  return (
    <header className="app-header">
      <div className="app-header__logo">
        <svg viewBox="0 0 64 64" aria-hidden>
          <defs>
            <radialGradient id="hg" cx="50%" cy="40%" r="60%">
              <stop offset="0%" stopColor="#88d3ff" />
              <stop offset="60%" stopColor="#1a6fb0" />
              <stop offset="100%" stopColor="#0b1d2e" />
            </radialGradient>
          </defs>
          <circle cx="32" cy="28" r="14" fill="url(#hg)" />
          <path d="M32 14 L32 50" stroke="#5fb8ff" strokeWidth="2.4" strokeLinecap="round" />
          <path d="M22 50 L42 50" stroke="#5fb8ff" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
        <div className="app-header__title">
          <b>Ion Beam Technology</b>
          <small>Beam Control Console</small>
        </div>
      </div>

      <div className="app-header__spacer" />

      <span className="status-pill" data-state={state}>
        {STATE_LABELS[state] ?? state}
      </span>
      <span className="muted mono" style={{ fontSize: 12 }}>
        scans: {status?.scans_completed ?? 0}
      </span>
      <button
        className="btn btn--ghost"
        onClick={() => dispatch(reconnectDevice())}
        title="Drop and re-establish the USB connection (POST /admin/reconnect)"
      >
        Reconnect
      </button>
    </header>
  );
}
