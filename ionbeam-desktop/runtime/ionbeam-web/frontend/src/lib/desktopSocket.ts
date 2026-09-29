/** Socket-shaped controls adapter. Acquisition uses native Unix/Electron IPC. */
declare global {
  interface Window { ionbeamScanner: {
    subscribe(id: string, callback: (packet: any) => void): void;
    unsubscribe(id: string): void;
    start(command: unknown): Promise<void>;
    stop(id: string): Promise<void>;
    ack(id: string): void;
    onModeChange(callback: (mode: string) => void): () => void;
  }; }
}
export class DesktopSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = DesktopSocket.CONNECTING;
  binaryType = "arraybuffer";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  private id = crypto.randomUUID();
  private kind: string;
  private token: string;
  private sent = false;
  constructor(url: string) {
    const target = new URL(url, window.location.href);
    const match = target.pathname.match(/^\/ws\/(?:scan\/(raster|vector|dac_ramp)|(?<adc>adc))\/stream$/);
    if (!match) throw new Error("Unknown native scan kind");
    this.kind = match[1] || "adc";
    this.token = target.searchParams.get("auth") || "";
    const bridge = window.ionbeamScanner;
    if (!bridge) throw new Error("Open scanning in the installed desktop app");
    bridge.subscribe(this.id, packet => {
      if (packet.type === "close") { this.finish(packet.code, ""); return; }
      if (this.readyState !== DesktopSocket.OPEN) { bridge.ack(this.id); return; }
      if (packet.type === "error") { this.fail(packet.message); return; }
      try {
        this.onmessage?.(new MessageEvent("message", { data: packet.payload }));
      } finally { bridge.ack(this.id); }
    });
    queueMicrotask(() => {
      if (this.readyState !== DesktopSocket.CONNECTING) return;
      this.readyState = DesktopSocket.OPEN;
      this.onopen?.(new Event("open"));
    });
  }
  send(body: string) {
    if (this.readyState !== DesktopSocket.OPEN || this.sent) throw new Error("Scan accepts one request");
    this.sent = true;
    void window.ionbeamScanner.start({ id: this.id, kind: this.kind, request: JSON.parse(body), token: this.token })
      .catch(error => this.fail(String(error)));
  }
  close(code = 1000, reason = "") {
    if (this.readyState >= DesktopSocket.CLOSING) return;
    if (!this.sent) { this.finish(code, reason); return; }
    this.readyState = DesktopSocket.CLOSING;
    void window.ionbeamScanner.stop(this.id).catch(() => this.finish(1011, "Unable to stop native scan"));
  }
  private fail(message: string) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ event: "error", message }) }));
    this.onerror?.(new Event("error"));
    void window.ionbeamScanner.stop(this.id);
    this.finish(1011, message);
  }
  private finish(code: number, reason: string) {
    if (this.readyState === DesktopSocket.CLOSED) return;
    this.readyState = DesktopSocket.CLOSED;
    window.ionbeamScanner.unsubscribe(this.id);
    queueMicrotask(() => this.onclose?.(new CloseEvent("close", { code, reason, wasClean: code === 1000 })));
  }
}
