import { useEffect, useRef } from "react";
import { useAppDispatch, useAppSelector, useAppStore, useAppWorkspace } from "../store";
import { claimWorkspaceRun } from "./useScanWorkspace";
import { useTranslation } from "../i18n";
import { apiUrl } from "../lib/backendUrl";
import { scanAuthHeaders } from "../lib/authIdentity";
import { ExposureStream, exposureJson } from "../lib/exposureStream";
import { prepareExposureSequence, exposureRounds, exposureSegments, totalExposureSpots, MAX_EXPOSURE_SPOTS } from "../lib/exposureSequence";
import { selectPattern } from "../store/processingSlice";
import { exposurePreparing, exposurePrepared, exposureStepStarted, exposureStepCompleted,
  exposureSamplesReceived, exposureStepSkipped, exposureStopping, exposureFinished, exposureViewChanged, exposureViewExpectedSamples,
  exposureViewSamplesReceived, exposurePaused, exposureResumed } from "../store/exposureSlice";
import type { RasterRequest, VectorRequest } from "../types/api";
import { decodeScanSamples } from "../lib/scanSamples";
import { rasterRequestWithBitmapSelection } from "../lib/bitmapVector";
import { prepareScanAssets } from "../lib/scanAssets";
import { scansUseHardware } from "../lib/takeoverTiming";
import { exposureViewScanRegions } from "../lib/processingScanRegions";
import { effectiveScanRegions } from "../lib/scanRegions";
import { appendExposureViewFrame, clearExposureViewFrames } from "../store/imageSlice";

const FULL_DAC_ROI = { x_start: 0, x_end: 16383, y_start: 0, y_end: 16383 };

/** Match Scan + ROI Parallel: one raster request carries each region in parallel_rois. */
function combineRasterRegions(requests: RasterRequest[]): RasterRequest {
  // The raster API requires at least two entries in parallel_rois. A single
  // pattern ROI uses the regular Scan + ROI request shape instead.
  if (requests.length === 1) return requests[0];
  const bitmaps = requests.map(request => request.simulation_bitmap);
  return {
    ...requests[0],
    roi: null,
    parallel_rois: requests.map(request => request.roi ?? FULL_DAC_ROI),
    simulation_bitmap: null,
    parallel_simulation_bitmaps: bitmaps.every(Boolean)
      ? bitmaps as NonNullable<RasterRequest["simulation_bitmap"]>[]
      : null,
  };
}

/** Exposure owns the beam session. View borrows it for one frame between passes. */
export function useExposureRun() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch(), store = useAppStore(), workspace = useAppWorkspace();
  const state = useAppSelector(s => s.exposure);
  const running = useRef(false), cancelled = useRef(false);
  const socket = useRef<ExposureStream | null>(null), auth = useRef<AbortController | null>(null);
  const viewSocket = useRef<ExposureStream | null>(null);
  const resumeAfterView = useRef(false);
  const handledViewRequestId = useRef(state.viewRequestId);
  const pendingStop = useRef<Promise<void> | null>(null), stopError = useRef<string | null>(null);

  const viewPending = useRef(false);
  const viewResumeLocked = useRef(false);
  const resumeWaiter = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (state.viewRequestId === handledViewRequestId.current) return;
    handledViewRequestId.current = state.viewRequestId;
    void view();
  }, [state.viewRequestId]);

  /** Hold the beam session between steps until Resume (or Stop) is pressed. */
  function waitForResume(stepId: string): Promise<void> {
    return new Promise(resolve => {
      if (cancelled.current) { resolve(); return; }
      resumeWaiter.current = () => { resumeWaiter.current = null; resolve(); };
      dispatch(exposurePaused(stepId));
    });
  }
  function resume() {
    if (viewResumeLocked.current || store.getState().exposure.phase !== "paused") return;
    dispatch(exposureResumed());
    resumeWaiter.current?.();
  }

  async function runRequest(request: VectorRequest | RasterRequest, viewFrames?: Array<{pixels: Uint16Array; cursor: number}>, exposureStepId?: string,
    stream?: ExposureStream, onViewChunk?: () => void): Promise<void> {
    if (cancelled.current) throw new Error("Exposure stopped");
    const activeSocket = stream ?? (socket.current ??= new ExposureStream(store.getState().status.defaults?.exposure_session_stream === true,
      () => resumeWaiter.current?.(), Number(store.getState().status.defaults?.adc?.adcHalfPeriod ?? 3)));
    let pendingSamples = 0;
    let sampleTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(sampleTimer); sampleTimer = undefined;
      if (pendingSamples && exposureStepId) dispatch(exposureSamplesReceived({id: exposureStepId, count: pendingSamples}));
      pendingSamples = 0;
    };
    try {
      await activeSocket.run(request, buffer => {
        if (viewFrames?.length) {
          const pixels = decodeScanSamples(buffer, request.output_mode);
          const regionCount = viewFrames.length;
          for (const pixel of pixels) {
            const regionIndex = viewFrames[viewFrames[0].cursor % regionCount];
            const localIndex = Math.floor(viewFrames[0].cursor / regionCount);
            if (!regionIndex || localIndex >= regionIndex.pixels.length)
              throw new Error("Invalid parallel View sample count");
            regionIndex.pixels[localIndex] = pixel;
            viewFrames[0].cursor++;
          }
          dispatch(exposureViewSamplesReceived(pixels.length));
          onViewChunk?.();
        } else {
          pendingSamples += buffer.byteLength / 2;
          sampleTimer ??= setTimeout(flush, 50);
        }
      });
      if (viewFrames?.length && viewFrames[0].cursor !== viewFrames[0].pixels.length * viewFrames.length)
        throw new Error("Parallel View ended with an incomplete frame");
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
      resumeAfterView.current = true;
      dispatch(exposureViewChanged({phase: "queued"}));
      return;
    }
    const release = claimWorkspaceRun(workspace, "exposure");
    if (!release) return;
    running.current = true; cancelled.current = false; pendingStop.current = null; stopError.current = null;
    viewPending.current = true; resumeAfterView.current = false;
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
      auth.current = null; running.current = false; viewPending.current = false; resumeAfterView.current = false; release();
    }
  }

  async function runQueuedView() {
    if (!viewPending.current || cancelled.current) return;
    viewPending.current = false;
    const pauseAfter = resumeAfterView.current;
    const exposurePhase = store.getState().exposure.phase;
    const alreadyPaused = exposurePhase === "paused";
    const holdResumeForView = pauseAfter || alreadyPaused ||
      (running.current && exposurePhase === "running");
    let viewCompleted = false;
    if (holdResumeForView) viewResumeLocked.current = true;
    try {
      const snapshot = store.getState();
      const activeNode = snapshot.exposure.progress.find(node => node.status === "current");
      if (pauseAfter && snapshot.exposure.phase === "running" && activeNode)
        dispatch(exposurePaused(activeNode.id));
      dispatch(exposureViewChanged({phase: "scanning"}));
      dispatch(clearExposureViewFrames());
      const settings = snapshot.scan.raster;
      const resolution = settings.resolution;
      const simulated = !scansUseHardware(snapshot.status.defaults?.is_production, snapshot.status.sessionSimulation);
      const regions = exposureViewScanRegions(snapshot.processing.specs, snapshot.processing.instances, snapshot.scan.roi);
      if (!regions.regions.length) throw new Error("Draw at least one enabled pattern ROI before requesting View.");
      const scanBounds = effectiveScanRegions(regions.regions, snapshot.scan.roi.scan_zoom, snapshot.scan.roi)
        .filter((bounds): bounds is NonNullable<typeof bounds> => bounds !== null);
      if (!scanBounds.length) throw new Error("The selected pattern ROIs do not intersect the zoomed scan field.");
      dispatch(exposureViewExpectedSamples(resolution * resolution * scanBounds.length));
      const request: RasterRequest = {
        resolution, dwell: settings.dwell,
        latency_bytes: simulated ? Math.max(settings.latency_bytes, 65536 * Math.max(1, settings.dwell)) : settings.latency_bytes,
        frame_blank: settings.frame_blank, cookie: settings.cookie,
        adc_valid: settings.adc_valid, do_validate: false, output_mode: "SixteenBit",
        continuous: false, roi: null, parallel_rois: null, preview: true, exposure_view: true,
        ...(snapshot.status.sessionSimulation ? {simulation: snapshot.status.sessionSimulation} : {}),
      };
      const regionRequests = await Promise.all(scanBounds.map(bounds => rasterRequestWithBitmapSelection(request,
        {...snapshot.scan.roi, selection: bounds, scan_zoom: 1},
        {isProduction: snapshot.status.defaults?.is_production !== false,
          allowBitmapSimulation: simulated})));
      if (cancelled.current) return;
      const parallelRequest = combineRasterRegions(regionRequests);
      const frames = scanBounds.map(() => ({pixels: new Uint16Array(resolution * resolution), cursor: 0}));
      // Production exposure sessions multiplex raster View frames on the
      // session that owns the beam. Standalone raster streams are used only
      // when the backend has no persistent exposure session.
      const exposureSession = socket.current?.persistent ? socket.current : null;
      const viewStream = exposureSession ?? new ExposureStream(false, undefined,
        Number(snapshot.status.defaults?.adc?.adcHalfPeriod ?? 3));
      if (!exposureSession) viewSocket.current = viewStream;
      try {
        const prepared = await prepareScanAssets(parallelRequest,
          {signal: auth.current?.signal, timeoutMs: 15_000});
        if (cancelled.current) return;
        await runRequest(prepared, frames, undefined, viewStream, () => {
          frames.forEach((frame, index) => dispatch(appendExposureViewFrame({
            key: regions.keys[index] ?? `roi-${index + 1}`,
            bounds: scanBounds[index], resolution, pixels: frame.pixels.slice(),
          })));
        });
      } finally {
        if (!exposureSession) {
          viewStream.close();
          if (viewSocket.current === viewStream) viewSocket.current = null;
        }
      }
      if (cancelled.current) return;
      frames.forEach((frame, index) => dispatch(appendExposureViewFrame({
        key: regions.keys[index] ?? `roi-${index + 1}`, bounds: scanBounds[index],
        resolution, pixels: frame.pixels,
      })));
      // Wait only after the raster stream has sent done and all View frames
      // have been committed. Keep the View phase active so Resume stays locked
      // and the exposure canvas cannot return before the full hold elapses.
      if (holdResumeForView && !cancelled.current)
        await new Promise<void>(resolve => window.setTimeout(
          resolve, store.getState().exposure.viewPauseSeconds * 1_000));
      viewCompleted = true;
    } catch (error) {
      if (!cancelled.current) dispatch(exposureViewChanged({phase: "error",
        error: error instanceof Error ? error.message : String(error)}));
      if (socket.current?.failed) throw error;
    } finally {
      if (pauseAfter) {
        resumeAfterView.current = false;
      }
      if (pauseAfter) {
        if (!cancelled.current && store.getState().exposure.phase === "paused") {
          dispatch(exposureResumed());
          resumeWaiter.current?.();
        }
      }
      viewResumeLocked.current = false;
      if (viewCompleted) dispatch(exposureViewChanged({phase: "completed"}));
    }
  }

  async function start() {
    if (running.current) return;
    const release = claimWorkspaceRun(workspace, "exposure");
    if (!release) return;
    running.current = true; cancelled.current = false; pendingStop.current = null; stopError.current = null;
    viewPending.current = false; resumeAfterView.current = false;
    dispatch(exposurePreparing());
    dispatch(clearExposureViewFrames());
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
      const plannedEntries = prepareExposureSequence(snapshot.processing, snapshot.scan.roi, snapshot.status.defaults?.is_production === false);
      const autoViewPerPass = plannedEntries.some(entry => (entry.request.lattice?.passes ?? 1) > 1);
      const totalSpots = totalExposureSpots(plannedEntries);
      if (totalSpots > MAX_EXPOSURE_SPOTS)
        throw new Error(t("processing.exposure.totalLimit", {count: totalSpots.toLocaleString(), limit: MAX_EXPOSURE_SPOTS.toLocaleString()}));
      if (snapshot.exposure.parallel && plannedEntries.some(e => e.node.exposure?.model === "CleaningLineModel"))
        throw new Error("Cleaning lines require serial exposure (Parallel off).");
      dispatch(exposurePrepared(plannedEntries.map(e => e.node)));
      // Yield so the pattern cards can render their calculated spot counts before the first lattice starts.
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      if (cancelled.current) return;
      const rounds = exposureRounds(plannedEntries, snapshot.exposure.parallel);
      let upcoming = rounds.next();
      while (!upcoming.done) {
        const round = upcoming.value;
        upcoming = rounds.next();
        if (cancelled.current) break;
        const queues = round.map(run => ({run, requests: (cellRanges
          ? exposureSegments({...run.request.lattice!, passes: 1})
          : [{...run.request.lattice!, passes: 1}])[Symbol.iterator]()}));
        const skipped = new Set<string>();
        // Parallel alternates scan-line requests across patterns on the single beam.
        let remaining = true;
        while (remaining && !cancelled.current) {
          remaining = false;
          for (const queue of queues) {
            if (!store.getState().processing.instances[queue.run.entry.key]?.enabled) {
              skipped.add(queue.run.entry.node.id);
              dispatch(exposureStepSkipped(queue.run.entry.node.id));
              continue;
            }
            const next = queue.requests.next();
            if (next.done) continue;
            remaining = true;
            if (!snapshot.exposure.parallel && store.getState().processing.activeKey !== queue.run.entry.key)
              dispatch(selectPattern(queue.run.entry.key));
            dispatch(exposureStepStarted(queue.run.entry.node.id));
            await runRequest({...queue.run.request, lattice: next.value, preview: true,
              ...(snapshot.status.sessionSimulation ? {simulation: snapshot.status.sessionSimulation} : {})},
              undefined, queue.run.entry.node.id);
            if (cancelled.current) break;
            if (viewPending.current) await runQueuedView();
          }
        }
        if (cancelled.current) break;
        const finished = queues.filter(({run}) => run.final && !skipped.has(run.entry.node.id)).map(({run}) => run.entry.node);
        for (const node of finished) dispatch(exposureStepCompleted(node.id));
        // A multi-pass run gets one View scan at each completed pass boundary.
        // Per-step "after" actions (Stair cut recipe) share the same scan so a
        // pass that also requests View is never scanned twice.
        const wantsView = finished.some(n => n.exposure?.after === "view" || n.exposure?.after === "viewPause");
        if ((autoViewPerPass || wantsView) && !viewPending.current) {
          viewPending.current = true;
          dispatch(exposureViewChanged({phase: "queued"}));
        }
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
      auth.current = null; running.current = false; viewPending.current = false; resumeAfterView.current = false; release();
    }
  }

  function stop(): Promise<void> {
    if (!running.current) return Promise.resolve();
    if (pendingStop.current) return pendingStop.current;
    cancelled.current = true; viewPending.current = false; resumeAfterView.current = false; auth.current?.abort();
    resumeWaiter.current?.();
    if (["preparing", "running", "paused", "stopping"].includes(store.getState().exposure.phase)) dispatch(exposureStopping());
    const ws = socket.current;
    viewSocket.current?.close(); viewSocket.current = null;
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
