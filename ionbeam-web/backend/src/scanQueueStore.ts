/** Durable finite ROI queues. A queue never replays automatically after a crash. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type QueueEntry = {
  kind: "raster" | "vector";
  req: Record<string, unknown>;
  displayROI?: unknown;
  displayROIs?: unknown;
  scanType?: number;
};
export type QueueStatus = "queued" | "running" | "interrupted" | "completed";
export type ScanQueue = {
  id: string;
  owner: string;
  created_at: string;
  updated_at: string;
  status: QueueStatus;
  next_index: number;
  entries: QueueEntry[];
};

const ROOT = process.env.IONBEAM_SCAN_QUEUE_DIR ??
  path.join(os.homedir(), ".local", "share", "ionbeam-web", "scan-queues");
const MAX_ENTRIES = 2000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

function queuePath(id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("invalid queue ID");
  return path.join(ROOT, `${id}.json`);
}

function write(queue: ScanQueue): void {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const target = queuePath(queue.id);
  const temporary = `${target}.${process.pid}.tmp`;
  const text = JSON.stringify(queue);
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error("scan queue exceeds 16 MiB; use smaller batches");
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

export function createScanQueue(owner: string, entries: QueueEntry[]): ScanQueue {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_ENTRIES ||
      entries.some((entry) => !["raster", "vector"].includes(entry?.kind) || !entry.req || typeof entry.req !== "object")) {
    throw new Error(`scan queue must contain 1..${MAX_ENTRIES} valid entries`);
  }
  const now = new Date().toISOString();
  const queue: ScanQueue = {
    id: crypto.randomUUID(), owner, created_at: now, updated_at: now,
    status: "queued", next_index: 0, entries,
  };
  write(queue);
  return queue;
}

export function readScanQueue(id: string, owner: string): ScanQueue {
  const queue = JSON.parse(fs.readFileSync(queuePath(id), "utf8")) as ScanQueue;
  if (queue.owner !== owner) throw new Error("scan queue not found");
  return queue;
}

export function latestScanQueue(owner: string): ScanQueue | null {
  if (!fs.existsSync(ROOT)) return null;
  const queues = fs.readdirSync(ROOT)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      try { return readScanQueue(name.slice(0, -5), owner); } catch { return null; }
    })
    .filter((queue): queue is ScanQueue => queue !== null && queue.status !== "completed")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return queues[0] ?? null;
}

export function queuePage(id: string, owner: string, page: number, pageSize: number) {
  const queue = readScanQueue(id, owner);
  const start = page * pageSize;
  return {
    id: queue.id, status: queue.status, next_index: queue.next_index,
    total: queue.entries.length, page, page_size: pageSize,
    entries: queue.entries.slice(start, start + pageSize),
  };
}

export function setScanQueueStep(id: string, index: number, status: "running" | "interrupted" | "completed", owner: string): void {
  const queue = readScanQueue(id, owner);
  if (index !== queue.next_index) throw new Error("scan queue entry is no longer current");
  if (status === "running") {
    if (queue.status !== "queued" && queue.status !== "interrupted") {
      throw new Error("scan queue is already running or completed");
    }
    queue.status = "running";
  } else {
    if (queue.status !== "running") throw new Error("scan queue entry is not running");
  }
  if (status === "completed") {
    queue.next_index += 1;
    queue.status = queue.next_index >= queue.entries.length ? "completed" : "queued";
  } else if (status === "interrupted") {
    queue.status = "interrupted";
  }
  queue.updated_at = new Date().toISOString();
  write(queue);
}

/** Backend restart closes its WebSockets; no running job may be replayed silently. */
export function recoverInterruptedScanQueues(): void {
  if (!fs.existsSync(ROOT)) return;
  for (const name of fs.readdirSync(ROOT).filter((item) => item.endsWith(".json"))) {
    try {
      const queue = JSON.parse(fs.readFileSync(path.join(ROOT, name), "utf8")) as ScanQueue;
      if (queue.status === "running") {
        queue.status = "interrupted";
        queue.updated_at = new Date().toISOString();
        write(queue);
      }
    } catch { /* Ignore unreadable files; they are never replayed. */ }
  }
}
