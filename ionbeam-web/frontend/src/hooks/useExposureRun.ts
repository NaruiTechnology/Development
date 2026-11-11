import { useEffect, useRef } from "react";
import { useAppDispatch, useAppSelector, useAppStore, useAppWorkspace } from "../store";
import { claimWorkspaceRun } from "./useScanWorkspace";
import { useTranslation } from "../i18n";
import { apiUrl, wsUrl } from "../lib/backendUrl";
import { scanAuthHeaders, withScanAuthQuery } from "../lib/authIdentity";
import { prepareExposureSequence, exposureRounds, exposureSegments } from "../lib/exposureSequence";
import { exposurePreparing, exposurePrepared, exposureStepStarted, exposureStepCompleted,
  exposureSamplesReceived, exposureStopping, exposureFinished, exposureViewChanged } from "../store/exposureSlice";
import type { RasterRequest, VectorRequest } from "../types/api";
import { decodeScanSamples } from "../lib/scanSamples";
import { rasterRequestWithBitmapSelection } from "../lib/bitmapVector";
import { prepareScanAssets } from "../lib/scanAssets";
import { scansUseHardware } from "../lib/takeoverTiming";
import { resetRaster, setupVector } from "../store/imageSlice";

/** Exposure owns the beam session. View borrows it for one frame between passes. */
export function useExposureRun() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch(), store = useAppStore(), workspace = useAppWorkspace();
  const state = useAppSelector(s => s.exposure);
  const running = useRef(false), cancelled = useRef(false);
  const socket = useRef<WebSocket | null>(null), auth = useRef<AbortController | null>(null);
  const pendingStop = useRef<Promise<void> | null>(null), stopError = useRef<string | null>(null);

  const viewPending = useRef(false);

  function runRequest(request: VectorRequest | RasterRequest, viewFrame?: {pixels: Uint16Array; cursor: number}, exposureStepId?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (cancelled.current) { reject(new Error("Exposure stopped")); return; }
      const path = viewFrame ? "/ws/scan/raster/stream" : "/ws/scan/vector/stream";
      const ws = new WebSocket(wsUrl(withScanAuthQuery(path)));
      socket.current = ws; ws.binaryType = "arraybuffer";
      let done = false, error: string | null = null;
      let pendingSamples = 0;
      let sampleTimer: ReturnType<typeof setTimeout> | undefined;
      const flushSamples = () => {
        clearTimeout(sampleTimer);
        sampleTimer = undefined;
        if (pendingSamples > 0) {
          if (exposureStepId) dispatch(exposureSamplesReceived({id: exposureStepId, count: pendingSamples}));
          pendingSamples = 0;
        }
      };
      ws.onopen = () => { if (!cancelled.current) ws.send(JSON.stringify(request)); else ws.close(1000, "exposure-stop"); };
      ws.onmessage = event => {
        if (cancelled.current) return;
        if (typeof event.data !== "string") {
          const buffer = event.data as ArrayBuffer;
          if (viewFrame) {
            const pixels = decodeScanSamples(buffer, request.output_mode);
            if (buffer.byteLength % 2 || viewFrame.cursor + pixels.length > viewFrame.pixels.length) {
              error = "Invalid full-field View sample count";
              ws.close(1002, "invalid-view-frame");
              return;
            }
            viewFrame.pixels.set(pixels, viewFrame.cursor);
            viewFrame.cursor += pixels.length;
            return;
          }
          pendingSamples += Math.floor(buffer.byteLength / 2);
          // Redraw the trace at most 20 times per second, even when samples arrive in bursts.
          sampleTimer ??= setTimeout(flushSamples, 50);
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
        flushSamples();
        if (socket.current === ws) socket.current = null;
        if (done && viewFrame && viewFrame.cursor !== viewFrame.pixels.length)
          error ??= "Full-field View ended with an incomplete frame";
        if (!cancelled.current && done && !error) resolve();
        else reject(new Error(error ?? (cancelled.current ? "Exposure stopped" : "Exposure stream ended before completion")));
      };
    });
  }

  async function checkAccount() {
    auth.current = new AbortController();
    const response = await fetch(apiUrl("/api/admin/iobeam/auth/current-account"),
      {cache: "no-store", headers: scanAuthHeaders(), signal: auth.current.signal});
    if (!response.ok) throw new Error(`Account check failed: HTTP ${response.status}`);
    const account = await response.json();
    if (!account?.ok) throw new Error(account?.error ?? "Account check failed.");
    if (account.session_expired) throw new Error(t("auth.sessionExpired"));
    if (!account.registered || !account.user?.is_active)
      throw new Error("Sign in with an active scan account to start exposure.");
    const role = Number(account.user.role);
    if (!Number.isFinite(role) || role < 1)
      throw new Error("Your account does not have permission to expose pattern lattices.");
  }

  async function view() {
    const current = store.getState().exposure;
    if ((cancelled.current && running.current) || viewPending.current || current.viewPhase === "scanning") return;
    if (running.current) {
      if (current.phase !== "running") return;
      viewPending.current = true;
      dispatch(exposureViewChanged({phase: "queued"}));
      return;
    }
    const release = claimWorkspaceRun(workspace, "exposure");
    if (!release) return;
    running.current = true; cancelled.current = false; pendingStop.current = null; stopError.current = null;
    viewPending.current = true;
    dispatch(exposureViewChanged({phase: "queued"}));
    try {
      await checkAccount();
      await runQueuedView();
    } catch (error) {
      if (!cancelled.current) dispatch(exposureViewChanged({phase: "error",
        error: error instanceof Error ? error.message : String(error)}));
    } finally {
      await pendingStop.current;
      if (cancelled.current) dispatch(exposureViewChanged({phase: stopError.current ? "error" : "stopped",
        error: stopError.current ?? undefined}));
      auth.current = null; running.current = false; viewPending.current = false; release();
    }
  }

  async function runQueuedView() {
    if (!viewPending.current || cancelled.current) return;
    viewPending.current = false;
    dispatch(exposureViewChanged({phase: "scanning"}));
    try {
      const snapshot = store.getState();
      const settings = snapshot.scan.raster;
      const resolution = settings.resolution;
      const simulated = !scansUseHardware(snapshot.status.defaults?.is_production, snapshot.status.sessionSimulation);
      const frame = {pixels: new Uint16Array(resolution * resolution), cursor: 0};
      const request: RasterRequest = {
        resolution, dwell: settings.dwell,
        latency_bytes: simulated ? Math.max(settings.latency_bytes, 65536 * Math.max(1, settings.dwell)) : settings.latency_bytes,
        frame_blank: settings.frame_blank, cookie: settings.cookie,
        adc_valid: settings.adc_valid, do_validate: false, output_mode: "SixteenBit",
        continuous: false, roi: null, parallel_rois: null, preview: true, exposure_view: true,
        ...(snapshot.status.sessionSimulation ? {simulation: snapshot.status.sessionSimulation} : {}),
      };
      const withBitmap = await rasterRequestWithBitmapSelection(request,
        {...snapshot.scan.roi, selection: null, scan_zoom: 1},
        {isProduction: snapshot.status.defaults?.is_production !== false,
          allowBitmapSimulation: simulated});
      const prepared = await prepareScanAssets(withBitmap);
      if (cancelled.current) return;
      await runRequest(prepared, frame);
      if (cancelled.current) return;
      // Both Processing scan modes show this full-field frame without changing their settings.
      dispatch(resetRaster({resolution, initialFrame: frame.pixels}));
      dispatch(setupVector({pattern: "default", edge: resolution, scanPath: "horizontal_sawtooth", initialImage: frame.pixels}));
      dispatch(exposureViewChanged({phase: "completed"}));
    } catch (error) {
      if (!cancelled.current) dispatch(exposureViewChanged({phase: "error",
        error: error instanceof Error ? error.message : String(error)}));
    }
  }

  async function start() {
    if (running.current) return;
    const release = claimWorkspaceRun(workspace, "exposure");
    if (!release) return;
    running.current = true; cancelled.current = false; pendingStop.current = null; stopError.current = null; viewPending.current = false;
    dispatch(exposurePreparing());
    let failure: string | null = null;
    try {
      await checkAccount();
      if (cancelled.current) return;
      const snapshot = store.getState();
      if (!snapshot.status.defaults) throw new Error("Service defaults are unavailable.");
      let cellRanges = snapshot.status.defaults.exposure_cell_ranges;
      if (cellRanges === undefined) {
        const response = await fetch(apiUrl("/api/defaults"), {cache: "no-store",
          headers: scanAuthHeaders(), signal: auth.current?.signal});
        if (!response.ok) throw new Error(`Service capability check failed: HTTP ${response.status}`);
        cellRanges = (await response.json()).exposure_cell_ranges === true;
      }
      if (cancelled.current) return;
      const entries = prepareExposureSequence(snapshot.processing, snapshot.scan.roi, snapshot.status.defaults?.is_production === false);
      if (snapshot.exposure.parallel && entries.some(e => e.node.exposure?.model === "CleaningLineModel"))
        throw new Error("Cleaning lines require serial exposure (Parallel off).");
      dispatch(exposurePrepared(entries.map(e => e.node)));
      for (const round of exposureRounds(entries, snapshot.exposure.parallel)) {
        if (cancelled.current) break;
        const queues = round.map(run => {
          const lattice = {...run.request.lattice!, passes: 1};
          const segments = cellRanges ? exposureSegments(lattice) : [lattice];
          return {run, segments: segments[Symbol.iterator]()};
        });
        // Parallel alternates bounded segments across patterns on the single
        // beam, so both ROIs make progress during the same exposure round.
        let remaining = true;
        while (remaining && !cancelled.current) {
          remaining = false;
          for (const queue of queues) {
            const next = queue.segments.next();
            if (next.done) continue;
            remaining = true;
            dispatch(exposureStepStarted(queue.run.entry.node.id));
            await runRequest({...queue.run.request, lattice: next.value, preview: true,
              ...(snapshot.status.sessionSimulation ? {simulation: snapshot.status.sessionSimulation} : {})},
              undefined, queue.run.entry.node.id);
            if (cancelled.current) break;
          }
        }
        if (cancelled.current) break;
        for (const {run} of queues) if (run.final) dispatch(exposureStepCompleted(run.entry.node.id));
        // A requested raster can use the instrument only between rounds.
        await runQueuedView();
      }
    } catch (e) { if (!cancelled.current) failure = e instanceof Error ? e.message : String(e); }
    finally {
      await pendingStop.current;
      failure ??= stopError.current;
      dispatch(exposureFinished({phase: failure ? "error" : cancelled.current ? "stopped" : "completed", error: failure ?? undefined}));
      auth.current = null; running.current = false; viewPending.current = false; release();
    }
  }

  function stop(): Promise<void> {
    if (!running.current) return Promise.resolve();
    if (pendingStop.current) return pendingStop.current;
    cancelled.current = true; viewPending.current = false; auth.current?.abort();
    if (["preparing", "running", "stopping"].includes(store.getState().exposure.phase)) dispatch(exposureStopping());
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
  return {state, start, stop, view};
}
