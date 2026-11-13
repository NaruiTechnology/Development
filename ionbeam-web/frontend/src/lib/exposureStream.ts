import type { RasterRequest, VectorRequest } from "../types/api";
import { wsUrl } from "./backendUrl";
import { currentAdminSessionToken } from "./authIdentity";
import { estimateRevC3ScanTiming } from "./scanTiming";

type Request = RasterRequest | VectorRequest;
const STARTUP_MS = 60_000;
const HTTP_MS = 15_000;

/** Lattice runs can have long backend work gaps; let Stop and connection heartbeat govern them. */
export function exposureIdleTimeoutMs(request: Request, adcHalfPeriod = 3): number {
  if ("lattice" in request && request.lattice) return Number.POSITIVE_INFINITY;
  const dwell = request.dwell;
  const bufferedSamples = Math.max(65536, request.latency_bytes / 2);
  const pixelSeconds = estimateRevC3ScanTiming(1, dwell, adcHalfPeriod).frameSeconds;
  return Math.min(2_147_000_000, STARTUP_MS + Math.ceil(bufferedSamples * pixelSeconds * 1000 * 4));
}

/** Bound HTTP response bodies as well as connection establishment; Stop aborts both. */
export async function exposureJson(url: string, init: RequestInit = {}): Promise<any> {
  const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(HTTP_MS)]);
  try {
    const response = await fetch(url, {...init, signal});
    if (!response.ok) throw new Error(`Exposure preparation failed: HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (signal.aborted && !init.signal?.aborted)
      throw new Error("Exposure preparation timed out. Your sign-in was retained.");
    throw error;
  }
}

/** No reconnect or automatic retry: completion can be uncertain after a drop. */
export class ExposureStream {
  private socket: WebSocket | null = null;
  private pending: {resolve: () => void; reject: (error: Error) => void; samples: (data: ArrayBuffer) => void; progress: () => void} | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private failure: Error | null = null;
  private readonly token = currentAdminSessionToken();
  constructor(readonly persistent: boolean, private readonly onFailure?: () => void, private readonly adcHalfPeriod = 3) {}
  private fail(error: Error) {
    this.close(error);
    this.onFailure?.();
  }
  private alive() {
    if (!this.persistent) return;
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => this.fail(new Error("Exposure session lost its heartbeat. No segment was replayed.")), 35_000);
  }
  get isOpen() { return this.socket?.readyState === WebSocket.OPEN; }
  get hasPending() { return this.pending !== null; }
  get failed() { return this.failure !== null; }
  private finish(error?: Error) {
    clearTimeout(this.timer);
    const pending = this.pending;
    this.pending = null;
    if (error) pending?.reject(error); else pending?.resolve();
  }
  close(error = new Error("Exposure stopped")) {
    clearTimeout(this.heartbeatTimer);
    if (this.persistent) this.failure = error;
    this.finish(error);
    const socket = this.socket;
    this.socket = null;
    // Browsers accept only 1000 or application codes 3000–4999.
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "exposure-end");
  }
  run(request: Request, samples: (data: ArrayBuffer) => void): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error("Exposure request already in progress"));
    return new Promise((resolve, reject) => {
      const arm = () => {
        clearTimeout(this.timer);
        const timeoutMs = exposureIdleTimeoutMs(request, this.adcHalfPeriod);
        if (!Number.isFinite(timeoutMs)) return;
        this.timer = setTimeout(() => this.fail(new Error(
          `Exposure acquisition timed out after ${Math.ceil(timeoutMs / 1000)} seconds without progress. The segment was not replayed.`)), timeoutMs);
      };
      this.pending = {resolve, reject, samples, progress: arm};
      const send = () => {
        try {
          this.socket!.send(JSON.stringify(this.persistent
            ? {kind: "exposure_view" in request && request.exposure_view ? "raster" : "vector", request} : request));
          arm();
        } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
      };
      arm();
      if (!this.socket) {
        const path = this.persistent ? "/ws/exposure/session"
          : "exposure_view" in request && request.exposure_view ? "/ws/scan/raster/stream" : "/ws/scan/vector/stream";
        let ws: WebSocket;
        try { ws = new WebSocket(wsUrl(`${path}${this.token ? `?auth=${encodeURIComponent(this.token)}` : ""}`)); }
        catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); return; }
        this.socket = ws;
        ws.binaryType = "arraybuffer";
        ws.onopen = () => { if (this.socket === ws && this.pending) { this.alive(); send(); } };
        ws.onmessage = event => {
          if (this.socket !== ws) return;
          this.alive();
          if (typeof event.data !== "string") {
            if (!this.pending) { this.fail(new Error("Unexpected exposure samples")); return; }
            try {
              if (!(event.data instanceof ArrayBuffer) || event.data.byteLength % 2)
                throw new Error("Invalid exposure sample frame");
              this.pending.samples(event.data);
              if (event.data.byteLength) this.pending.progress();
            } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
            return;
          }
          try {
            const message = JSON.parse(event.data);
            if (message.event === "heartbeat") return;
            if (message.event === "error") {
              this.fail(new Error(String(message.detail ?? message.message ?? message.code ?? "Exposure stream failed")));
            } else if (message.event === "done") {
              this.finish();
              if (!this.persistent) this.close();
            }
          } catch { this.fail(new Error("Malformed exposure stream message")); }
        };
        ws.onerror = () => { if (this.socket === ws) this.fail(new Error("Exposure connection failed. Check the service connection; no segment was replayed.")); };
        ws.onclose = () => { if (this.socket === ws) this.fail(new Error("Exposure connection ended before completion. No segment was replayed.")); };
      } else if (this.socket.readyState === WebSocket.OPEN) send();
      else this.fail(new Error("Exposure connection is unavailable"));
    });
  }
}
