import { useEffect, useRef } from "react";
import { useAppDispatch, useAppSelector, useAppStore, useAppWorkspace } from "../store";
import { claimWorkspaceRun } from "./useScanWorkspace";
import { apiUrl, wsUrl } from "../lib/backendUrl";
import { scanAuthHeaders, withScanAuthQuery } from "../lib/authIdentity";
import { prepareExposureSequence, exposureRuns } from "../lib/exposureSequence";
import { exposurePreparing, exposurePrepared, exposureStepStarted, exposureStepCompleted,
  exposureSamplesReceived, exposureStopping, exposureFinished } from "../store/exposureSlice";
import type { VectorRequest } from "../types/api";

/** Exposure owns its socket and queue. It never dispatches scan/image actions. */
export function useExposureRun() {
  const dispatch = useAppDispatch(), store = useAppStore(), workspace = useAppWorkspace();
  const state = useAppSelector(s => s.exposure);
  const running = useRef(false), cancelled = useRef(false);
  const socket = useRef<WebSocket | null>(null), auth = useRef<AbortController | null>(null);
  const pendingStop = useRef<Promise<void> | null>(null), stopError = useRef<string | null>(null);

  function runRequest(request: VectorRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      if (cancelled.current) { reject(new Error("Exposure stopped")); return; }
      const ws = new WebSocket(wsUrl(withScanAuthQuery("/ws/scan/vector/stream")));
      socket.current = ws; ws.binaryType = "arraybuffer";
      let done = false, error: string | null = null;
      ws.onopen = () => { if (!cancelled.current) ws.send(JSON.stringify(request)); else ws.close(1000, "exposure-stop"); };
      ws.onmessage = event => {
        if (cancelled.current) return;
        if (typeof event.data !== "string") {
          dispatch(exposureSamplesReceived(Math.floor((event.data as ArrayBuffer).byteLength / 2)));
          return;
        }
        try {
          const msg = JSON.parse(event.data);
          if (msg.event === "done") done = true;
          else if (msg.event === "error") {
            error = String(msg.detail ?? msg.message ?? msg.code ?? "Exposure stream error");
            ws.close(1000, "exposure-error");
          }
        } catch { error = "Malformed exposure stream message"; ws.close(1002, "invalid-control"); }
      };
      ws.onerror = () => { error ??= "Exposure connection failed"; };
      ws.onclose = () => {
        if (socket.current === ws) socket.current = null;
        if (!cancelled.current && done && !error) resolve();
        else reject(new Error(error ?? (cancelled.current ? "Exposure stopped" : "Exposure stream ended before completion")));
      };
    });
  }

  async function start() {
    if (running.current) return;
    const release = claimWorkspaceRun(workspace, "exposure");
    if (!release) return;
    running.current = true; cancelled.current = false; pendingStop.current = null; stopError.current = null;
    dispatch(exposurePreparing());
    let failure: string | null = null;
    try {
      auth.current = new AbortController();
      const response = await fetch(apiUrl("/api/admin/iobeam/auth/current-account"),
        {cache: "no-store", headers: scanAuthHeaders(), signal: auth.current.signal});
      const account = await response.json();
      if (!response.ok || !account?.ok || !account.registered || account.session_expired ||
        !account.user?.is_active || Number(account.user.role) < 1) throw new Error("Sign in with scan permission to start exposure.");
      if (cancelled.current) return;
      const snapshot = store.getState();
      if (!snapshot.status.defaults) throw new Error("Service defaults are unavailable.");
      const entries = prepareExposureSequence(snapshot.processing, snapshot.scan.roi, snapshot.status.defaults?.is_production === false);
      if (snapshot.exposure.parallel && entries.some(e => e.node.exposure?.model === "CleaningLineModel"))
        throw new Error("Cleaning lines require serial exposure (Parallel off).");
      dispatch(exposurePrepared(entries.map(e => e.node)));
      for (const run of exposureRuns(entries, snapshot.exposure.parallel)) {
        if (cancelled.current) break;
        dispatch(exposureStepStarted(run.entry.node.id));
        await runRequest({...run.request,
          ...(snapshot.status.sessionSimulation ? {simulation: snapshot.status.sessionSimulation} : {})});
        if (cancelled.current) break;
        if (run.final) dispatch(exposureStepCompleted(run.entry.node.id));
      }
    } catch (e) { if (!cancelled.current) failure = e instanceof Error ? e.message : String(e); }
    finally {
      await pendingStop.current;
      failure ??= stopError.current;
      dispatch(exposureFinished({phase: failure ? "error" : cancelled.current ? "stopped" : "completed", error: failure ?? undefined}));
      auth.current = null; running.current = false; release();
    }
  }

  function stop(): Promise<void> {
    if (!running.current) return Promise.resolve();
    if (pendingStop.current) return pendingStop.current;
    cancelled.current = true; auth.current?.abort(); dispatch(exposureStopping());
    const ws = socket.current;
    pendingStop.current = (async () => {
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          const response = await fetch(apiUrl("/api/scan/abort"), {method: "POST", headers: scanAuthHeaders()});
          if (!response.ok && response.status !== 409 && response.status !== 501)
            throw new Error(`Exposure abort failed: HTTP ${response.status}`);
        }
      } catch (e) { stopError.current = e instanceof Error ? e.message : String(e); }
      finally { if (ws && ws.readyState < WebSocket.CLOSING) ws.close(1000, "exposure-stop"); }
    })();
    return pendingStop.current;
  }
  const stopRef = useRef(stop); stopRef.current = stop;
  useEffect(() => () => { void stopRef.current(); }, []);
  return {state, start, stop};
}
