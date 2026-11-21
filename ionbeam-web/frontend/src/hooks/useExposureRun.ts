import { MillingSpotChanges } from "../lib/millingChange";
import { millingHistoryStorage } from "../lib/millingHistoryStore";
import { millingSpotPositions, millingPreviewResolution, millingPixelIndex, millingPreviewGeometry } from "../lib/millingLiveView";
import { patternBounds } from "../lib/processingPatterns";
import { transform } from "../lib/scanGeometry";
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
import { millingRequestWithSourceImage, rasterRequestWithBitmapSelection } from "../lib/bitmapVector";
import { prepareScanAssets } from "../lib/scanAssets";
import { scansUseHardware } from "../lib/takeoverTiming";
import { exposureViewScanRegions, squareExposureViewRegions } from "../lib/processingScanRegions";
import { effectiveScanRegions } from "../lib/scanRegions";
import { appendExposureViewFrame, clearExposureViewFrames, resetMillingFrame, appendMillingSamples, beginMillingPass, completeMillingPass, restoreMillingHistory, markMillingHistorySaved } from "../store/imageSlice";

/** A persisted reference is comparable only with the same pattern lattice and world mapping. */
function millingReference(key:string,request:VectorRequest,field:unknown):string {
  const l=request.lattice;
  return JSON.stringify(["milling-preview-v2",key,l?.shape,l?.pitch_x,l?.pitch_y,l?.axis,l?.dwell,field]);
}
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
  const historyLoad=useRef<Promise<void>|null>(null);
  function hydrateHistory():Promise<void> {
    return historyLoad.current??=(async()=>{
      const saved=await millingHistoryStorage(workspace);if(saved)dispatch(restoreMillingHistory(saved));
    })();
  }
  useEffect(()=>{void hydrateHistory();},[workspace]);
  const spotChanges = useRef(new MillingSpotChanges());
  const diagnosticRun = useRef({id: "", segment: 0});
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
    const snapshot = store.getState();
    const liveNode = snapshot.exposure.progress.find(n => n.id === exposureStepId);
    const liveKey = snapshot.exposure.mode === "milling" && liveNode?.exposure ? exposureStepId! : null;
    const liveBounds = snapshot.image.millingFrame?.key === liveKey ? snapshot.image.millingFrame.bounds
      : liveNode?.exposure ? patternBounds(liveNode.exposure.shape) : null;
    const liveResolution = snapshot.image.millingFrame?.resolution ?? millingPreviewResolution(snapshot.scan);
    const positions = liveKey && "lattice" in request && request.lattice ? millingSpotPositions(request.lattice) : null;
    if (liveKey) spotChanges.current.beginPass(liveKey, snapshot.image.millingFrame?.pass ?? 1);
    let pendingChanges: number[] = [];
    let pendingPixels: number[] = [];
    let pendingSamples = 0;
    let sampleTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(sampleTimer); sampleTimer = undefined;
      if (pendingSamples && exposureStepId) dispatch(exposureSamplesReceived({id: exposureStepId, count: pendingSamples}));
      if (liveKey && pendingPixels.length) dispatch(appendMillingSamples({key:liveKey, samples:pendingPixels, changes:pendingChanges}));
      pendingPixels = []; pendingChanges = [];
      pendingSamples = 0;
    };
    try {
      const streamedRequest = liveKey ? {...request,
        ...(!scansUseHardware(snapshot.status.defaults?.is_production, snapshot.status.sessionSimulation) ? {
          simulation: {...request.simulation, enabled: true, mode: "image",
            milling_pass_index: snapshot.image.millingFrame?.pass ?? 1, milling_gray_delta_adc: 1},
        } : {}),
        diagnostic_context: {
        run_id: diagnosticRun.current.id, step_id: liveKey,
        pass_index: snapshot.image.millingFrame?.pass ?? 0,
        segment_index: ++diagnosticRun.current.segment,
      }} : request;
      await activeSocket.run(streamedRequest, buffer => {
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
          if (positions && liveBounds) {
            const geometry = snapshot.scan.roi.scanGeometry;
            const field = snapshot.scan.roi;
            for (const value of decodeScanSamples(buffer, request.output_mode)) {
              const next = positions.next();
              if (next.done) throw new Error("Exposure feedback exceeds its lattice positions");
              const [dx,dy] = next.value;
              pendingChanges.push(spotChanges.current.observe(dx,dy,value));
              const [x,y] = geometry?.enabled ? transform(geometry.forward,[dx,dy]) : [
                Math.min(field.x_origin,field.x_end)+dx/16383*Math.abs(field.x_end-field.x_origin),
                Math.min(field.y_origin,field.y_end)+dy/16383*Math.abs(field.y_end-field.y_origin)];
              pendingPixels.push(millingPixelIndex(x, y, liveBounds, liveResolution), value);
            }
          }
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
    spotChanges.current.reset();
    diagnosticRun.current = {id: `milling-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, segment: 0};
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

  async function runQueuedView(pauseForReview = false, reviewStepId?: string) {
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
      // Display a square window sized from the pattern ROI and zoom. Scan its
      // centered zoom crop, then enlarge those samples across the display window.
      const displayBounds = squareExposureViewRegions(regions.regions,
        snapshot.exposure.viewZoom, snapshot.scan.roi);
      const scanBounds = effectiveScanRegions(displayBounds, snapshot.exposure.viewZoom, snapshot.scan.roi)
        .filter((bounds): bounds is NonNullable<typeof bounds> => bounds !== null);
      if (!scanBounds.length) throw new Error("The selected pattern ROIs do not intersect the scan field.");
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
            bounds: displayBounds[index], resolution, pixels: frame.pixels.slice(),
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
        key: regions.keys[index] ?? `roi-${index + 1}`, bounds: displayBounds[index],
        resolution, pixels: frame.pixels,
      })));
      // Wait only after the raster stream has sent done and all View frames
      // have been committed. Keep the View phase active so Resume stays locked
      // and the exposure canvas cannot return before the full hold elapses.
      if (!pauseForReview && holdResumeForView && store.getState().exposure.viewPauseSeconds > 0 && !cancelled.current)
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
    if (pauseForReview && viewCompleted && !cancelled.current)
      await waitForResume(reviewStepId ?? "view");
  }

  async function start() {
    if (running.current) return;
    const recoverLiveView = store.getState().exposure.phase === "error";
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
      await hydrateHistory();
      const snapshot = store.getState();
      if (!snapshot.status.defaults) throw new Error("Service defaults are unavailable.");
      let cellRanges = snapshot.status.defaults.exposure_cell_ranges;
      if (cellRanges === undefined) {
        const capabilities = await exposureJson(apiUrl("/api/defaults"), {cache: "no-store",
          headers: scanAuthHeaders(), signal: auth.current?.signal});
        cellRanges = capabilities.exposure_cell_ranges === true;
      }
      if (cancelled.current) return;
      const milling = snapshot.exposure.mode === "milling";
      const selected = snapshot.processing.activeKey;
      const patterns = milling ? {...snapshot.processing, instances: Object.fromEntries(Object.entries(snapshot.processing.instances).map(([key,instance]) => [key,{...instance,enabled:key===selected && instance.enabled && instance.roi!==null}]))} : snapshot.processing;
      const plannedEntries = prepareExposureSequence(patterns, snapshot.scan.roi, snapshot.status.defaults?.is_production === false);
      const millingConfig = new Map<string, {geometry: ReturnType<typeof millingPreviewGeometry>; referenceKey:string; aggregate:boolean}>();
      if (milling) {
        const field={x:snapshot.scan.roi.x_origin,xEnd:snapshot.scan.roi.x_end,y:snapshot.scan.roi.y_origin,yEnd:snapshot.scan.roi.y_end,
          geometry:snapshot.scan.roi.scanGeometry,simulation:!scansUseHardware(snapshot.status.defaults?.is_production,snapshot.status.sessionSimulation),
          adc:snapshot.status.defaults?.adc,equipment:snapshot.processing.recipeEquipmentId,resolution:millingPreviewResolution(snapshot.scan)};
        for(const entry of plannedEntries) {
          if(!entry.node.exposure||!entry.request.lattice)continue;
          const siblings=plannedEntries.filter(candidate=>candidate.key===entry.key&&candidate.node.exposure?.model==="StairCutModel");
          const aggregate=entry.node.exposure.model==="StairCutModel";
          const ownGeometry=millingPreviewGeometry(entry.request.lattice,snapshot.scan.roi);
          let geometry=ownGeometry;
          let referenceKey=millingReference(entry.key,entry.request,field);
          if(aggregate) {
            const allGeometries=siblings.map(candidate=>millingPreviewGeometry(candidate.request.lattice!,snapshot.scan.roi));
            const bounds={x_start:Math.min(...allGeometries.map(item=>item.bounds.x_start)),x_end:Math.max(...allGeometries.map(item=>item.bounds.x_end)),
              y_start:Math.min(...allGeometries.map(item=>item.bounds.y_start)),y_end:Math.max(...allGeometries.map(item=>item.bounds.y_end))};
            geometry={...ownGeometry,bounds};
            referenceKey=JSON.stringify(["milling-stair-preview-v1",entry.key,siblings.map(candidate=>{
              const lattice=candidate.request.lattice!;return [lattice.shape,lattice.pitch_x,lattice.pitch_y,lattice.axis,lattice.dwell];
            }),field]);
          }
          millingConfig.set(entry.node.id,{geometry,referenceKey,aggregate});
        }
      }
      const resetMillingForEntry=(entry:typeof plannedEntries[number],preserveDisplay:boolean)=>{
        const config=millingConfig.get(entry.node.id);if(!config||!entry.request.lattice)return;
        dispatch(resetMillingFrame({resolution:millingPreviewResolution(snapshot.scan),key:entry.node.id,...config.geometry,
          referenceKey:config.referenceKey,aggregate:config.aggregate,preserveDisplay,restoreDisplay:config.aggregate}));
      };
      if (milling && plannedEntries[0]?.node.exposure) resetMillingForEntry(plannedEntries[0],recoverLiveView);
      const totalSpots = totalExposureSpots(plannedEntries);
      if (totalSpots > MAX_EXPOSURE_SPOTS)
        throw new Error(t("processing.exposure.totalLimit", {count: totalSpots.toLocaleString(), limit: MAX_EXPOSURE_SPOTS.toLocaleString()}));
      if (!milling && snapshot.exposure.parallel && plannedEntries.some(e => e.node.exposure?.model === "CleaningLineModel"))
        throw new Error("Cleaning lines require serial exposure (Parallel off).");
      dispatch(exposurePrepared(plannedEntries.map(e => e.node)));
      // Yield so the pattern cards can render their calculated spot counts before the first lattice starts.
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      if (cancelled.current) return;
      const millingSources = new Map<string, VectorRequest>();
      const rounds = exposureRounds(plannedEntries, milling ? false : snapshot.exposure.parallel);
      let upcoming = rounds.next();
      while (!upcoming.done) {
        const round = upcoming.value;
        upcoming = rounds.next();
        if (cancelled.current) break;
        const queues = round.map(run => ({run, requests: (cellRanges
          ? exposureSegments({...run.request.lattice!, passes: 1})
          : [{...run.request.lattice!, passes: 1}])[Symbol.iterator]()}));
        if (milling) for(const {run} of queues) {
          if(store.getState().image.millingFrame?.key!==run.entry.node.id && run.entry.node.exposure)
            resetMillingForEntry(run.entry,true);
          dispatch(beginMillingPass(run.entry.node.id));
        }
        const skipped = new Set<string>();
        // Parallel alternates scan-line requests across patterns on the single beam.
        const exposeSegment = async (queue: typeof queues[number]) => {
          const next = queue.requests.next();
          if (next.done) return false;
          if (snapshot.exposure.mode === "milling" && store.getState().image.millingFrame?.key !== queue.run.entry.node.id && queue.run.entry.node.exposure)
            resetMillingForEntry(queue.run.entry,true);
          dispatch(exposureStepStarted(queue.run.entry.node.id));
          let sourceRequest: VectorRequest = {...queue.run.request,
            ...(snapshot.status.sessionSimulation ? {simulation:snapshot.status.sessionSimulation} : {})};
          if (milling) {
            let prepared = millingSources.get(queue.run.entry.node.id);
            if (!prepared) {
              prepared = await millingRequestWithSourceImage(sourceRequest, snapshot.scan.roi,
                !scansUseHardware(snapshot.status.defaults?.is_production, snapshot.status.sessionSimulation));
              prepared = await prepareScanAssets(prepared, {signal: auth.current?.signal});
              millingSources.set(queue.run.entry.node.id, prepared);
            }
            sourceRequest = prepared;
          }
          await runRequest({...sourceRequest, lattice: next.value, preview: true}, undefined, queue.run.entry.node.id);
          if (viewPending.current) await runQueuedView();
          return true;
        };
        if (snapshot.exposure.parallel) {
          let remaining = true;
          while (remaining && !cancelled.current) {
            remaining = false;
            for (const queue of queues) {
              if (!store.getState().processing.instances[queue.run.entry.key]?.enabled) {
                skipped.add(queue.run.entry.node.id);
                dispatch(exposureStepSkipped(queue.run.entry.node.id));
                continue;
              }
              if (await exposeSegment(queue)) remaining = true;
              if (cancelled.current) break;
            }
          }
        } else {
          for (const queue of queues) {
            if (!store.getState().processing.instances[queue.run.entry.key]?.enabled) {
              skipped.add(queue.run.entry.node.id);
              dispatch(exposureStepSkipped(queue.run.entry.node.id));
              continue;
            }
            if (store.getState().processing.activeKey !== queue.run.entry.key)
              dispatch(selectPattern(queue.run.entry.key));
            while (!cancelled.current && await exposeSegment(queue)) { /* finish this pattern before the next */ }
            if (cancelled.current) break;
          }
        }
        if (cancelled.current) break;
        if(milling) for(const {run} of queues) if(!skipped.has(run.entry.node.id)) {
          spotChanges.current.completePass(run.entry.node.id, store.getState().image.millingFrame?.pass ?? 1);
          dispatch(completeMillingPass(run.entry.node.id));
          const history=store.getState().image.millingHistory;
          if(history)void millingHistoryStorage(workspace,history).then(saved=>dispatch(markMillingHistorySaved({referenceKey:history.referenceKey,saved:Boolean(saved)})));
        }
        const finished = queues.filter(({run}) => run.final && !skipped.has(run.entry.node.id)).map(({run}) => run.entry.node);
        for (const node of finished) dispatch(exposureStepCompleted(node.id));
        // Automatic View runs once after each completed exposure pass/round.
        // Parallel patterns share the View at their common round boundary.
        const automaticViewEnabled = !milling && store.getState().exposure.viewPauseSeconds > 0;
        const exposedRound = queues.some(({run}) => !skipped.has(run.entry.node.id));
        let pauseForReview = false;
        if (automaticViewEnabled && exposedRound && !viewPending.current) {
          viewPending.current = true;
          pauseForReview = store.getState().exposure.pauseAfterView && !upcoming.done;
          dispatch(exposureViewChanged({phase: "queued"}));
        }
        await runQueuedView(pauseForReview, queues[queues.length - 1]?.run.entry.node.id);
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
      spotChanges.current.reset();
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
