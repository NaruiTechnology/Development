import { useEffect, useRef } from "react";
import { useAppDispatch, useAppSelector, useAppStore, useAppWorkspace } from "../store";
import { claimWorkspaceRun } from "./useScanWorkspace";
import { useTranslation } from "../i18n";
import { apiUrl } from "../lib/backendUrl";
import { scanAuthHeaders } from "../lib/authIdentity";
import { ExposureStream, exposureJson } from "../lib/exposureStream";
import { prepareExposureSequence, exposureRounds, exposureSegments } from "../lib/exposureSequence";
import { selectPattern } from "../store/processingSlice";
import { exposurePreparing, exposurePrepared, exposureStepStarted, exposureStepCompleted,
  exposureSamplesReceived, exposureStepSkipped, exposureStopping, exposureFinished, exposureViewChanged, exposurePaused, exposureResumed } from "../store/exposureSlice";
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
  const socket = useRef<ExposureStream | null>(null), auth = useRef<AbortController | null>(null);
  const pendingStop = useRef<Promise<void> | null>(null), stopError = useRef<string | null>(null);

  const viewPending = useRef(false);
  const resumeWaiter = useRef<(() => void) | null>(null);

  /** Hold the beam session between steps until Resume (or Stop) is pressed. */
  function waitForResume(stepId: string): Promise<void> {
    return new Promise(resolve => {
      if (cancelled.current) { resolve(); return; }
      resumeWaiter.current = () => { resumeWaiter.current = null; resolve(); };
      dispatch(exposurePaused(stepId));
    });
  }
  function resume() {
    if (store.getState().exposure.phase !== "paused") return;
    dispatch(exposureResumed());
    resumeWaiter.current?.();
  }

  async function runRequest(request: VectorRequest | RasterRequest, viewFrame?: {pixels: Uint16Array; cursor: number}, exposureStepId?: string): Promise<void> {
    if (cancelled.current) throw new Error("Exposure stopped");
    socket.current ??= new ExposureStream(store.getState().status.defaults?.exposure_session_stream === true,
      () => resumeWaiter.current?.(), Number(store.getState().status.defaults?.adc?.adcHalfPeriod ?? 3));
    let pendingSamples = 0;
    let sampleTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(sampleTimer); sampleTimer = undefined;
      if (pendingSamples && exposureStepId) dispatch(exposureSamplesReceived({id: exposureStepId, count: pendingSamples}));
      pendingSamples = 0;
    };
    try {
      await socket.current.run(request, buffer => {
        if (viewFrame) {
          const pixels = decodeScanSamples(buffer, request.output_mode);
          if (viewFrame.cursor + pixels.length > viewFrame.pixels.length)
            throw new Error("Invalid full-field View sample count");
          viewFrame.pixels.set(pixels, viewFrame.cursor);
          viewFrame.cursor += pixels.length;
        } else {
          pendingSamples += buffer.byteLength / 2;
          sampleTimer ??= setTimeout(flush, 50);
        }
      });
      if (viewFrame && viewFrame.cursor !== viewFrame.pixels.length)
        throw new Error("Full-field View ended with an incomplete frame");
    } finally { flush(); }
  }

  async function checkAccount() {
    auth.current = new AbortController();
    const account = await exposureJson(apiUrl("/api/admin/iobeam/auth/current-account"),
      {cache: "no-store", headers: scanAuthHeaders(), signal: auth.current.signal});
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
      if (current.phase === "paused") {
        // The loop is waiting for Resume, so the beam is free for one frame.
        viewPending.current = true;
        dispatch(exposureViewChanged({phase: "queued"}));
        try { await runQueuedView(); }
        catch { resumeWaiter.current?.(); }
        return;
      }
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
      socket.current?.close(); socket.current = null;
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
      const prepared = await prepareScanAssets(withBitmap, {signal: auth.current?.signal, timeoutMs: 15_000});
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
      if (socket.current?.failed) throw error;
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
        const capabilities = await exposureJson(apiUrl("/api/defaults"), {cache: "no-store",
          headers: scanAuthHeaders(), signal: auth.current?.signal});
        cellRanges = capabilities.exposure_cell_ranges === true;
      }
      if (cancelled.current) return;
      const entries = prepareExposureSequence(snapshot.processing, snapshot.scan.roi, snapshot.status.defaults?.is_production === false);
      if (snapshot.exposure.parallel && entries.some(e => e.node.exposure?.model === "CleaningLineModel"))
        throw new Error("Cleaning lines require serial exposure (Parallel off).");
      dispatch(exposurePrepared(entries.map(e => e.node)));
      // Yield so the pattern cards can render their calculated spot counts before the first lattice starts.
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      if (cancelled.current) return;
      const rounds = exposureRounds(entries, snapshot.exposure.parallel);
      let upcoming = rounds.next();
      while (!upcoming.done) {
        const round = upcoming.value;
        upcoming = rounds.next();
        if (cancelled.current) break;
        const queues = round.map(run => {
          const lattice = {...run.request.lattice!, passes: 1};
          const segments = cellRanges ? exposureSegments(lattice) : [lattice];
          return {run, segments: segments[Symbol.iterator]()};
        });
        const skipped = new Set<string>();
        // Parallel alternates bounded segments across patterns on the single
        // beam, so both ROIs make progress during the same exposure round.
        let remaining = true;
        while (remaining && !cancelled.current) {
          remaining = false;
          for (const queue of queues) {
            if (!store.getState().processing.instances[queue.run.entry.key]?.enabled) {
              skipped.add(queue.run.entry.node.id);
              dispatch(exposureStepSkipped(queue.run.entry.node.id));
              continue;
            }
            const next = queue.segments.next();
            if (next.done) continue;
            remaining = true;
            if (!snapshot.exposure.parallel && store.getState().processing.activeKey !== queue.run.entry.key)
              dispatch(selectPattern(queue.run.entry.key));
            dispatch(exposureStepStarted(queue.run.entry.node.id));
            await runRequest({...queue.run.request, lattice: next.value, preview: true,
              ...(snapshot.status.sessionSimulation ? {simulation: snapshot.status.sessionSimulation} : {})},
              undefined, queue.run.entry.node.id);
            if (cancelled.current) break;
          }
        }
        if (cancelled.current) break;
        const finished = queues.filter(({run}) => run.final && !skipped.has(run.entry.node.id)).map(({run}) => run.entry.node);
        for (const node of finished) dispatch(exposureStepCompleted(node.id));
        // Per-step "after" actions (Stair cut recipe): View, or View then wait for Resume.
        const wantsView = finished.some(n => n.exposure?.after === "view" || n.exposure?.after === "viewPause");
        if (wantsView && !viewPending.current) { viewPending.current = true; dispatch(exposureViewChanged({phase: "queued"})); }
        // A requested raster can use the instrument only between rounds.
        await runQueuedView();
        const pauseNode = finished.find(n => n.exposure?.after === "viewPause");
        // Nothing left to expose: pausing after the last step would only delay completion.
        if (pauseNode && !upcoming.done && !cancelled.current) await waitForResume(pauseNode.id);
      }
    } catch (e) { if (!cancelled.current) failure = e instanceof Error ? e.message : String(e); }
    finally {
      await pendingStop.current;
      failure ??= stopError.current;
      dispatch(exposureFinished({phase: failure ? "error" : cancelled.current ? "stopped" : "completed", error: failure ?? undefined}));
      socket.current?.close(); socket.current = null;
      auth.current = null; running.current = false; viewPending.current = false; release();
    }
  }

  function stop(): Promise<void> {
    if (!running.current) return Promise.resolve();
    if (pendingStop.current) return pendingStop.current;
    cancelled.current = true; viewPending.current = false; auth.current?.abort();
    resumeWaiter.current?.();
    if (["preparing", "running", "paused", "stopping"].includes(store.getState().exposure.phase)) dispatch(exposureStopping());
    const ws = socket.current;
    pendingStop.current = (async () => {
      try {
        if (ws?.persistent) {
          // Closing this channel cancels only its upstream stream. A global
          // abort could stop another operator's scan while our recipe is paused.
          ws.close();
        } else if (ws?.isOpen && ws.hasPending) {
          const response = await fetch(apiUrl("/api/scan/abort"), {method: "POST", headers: scanAuthHeaders(), signal: AbortSignal.timeout(5000)});
          if (!response.ok && response.status !== 409 && response.status !== 501)
            throw new Error(`Exposure abort failed: HTTP ${response.status}`);
        }
      } catch (e) { stopError.current = e instanceof Error ? e.message : String(e); }
      finally { ws?.close(); }
    })();
    return pendingStop.current;
  }
  const stopRef = useRef(stop); stopRef.current = stop;
  useEffect(() => () => { void stopRef.current(); }, []);
  return {state, start, stop, view, resume};
}
