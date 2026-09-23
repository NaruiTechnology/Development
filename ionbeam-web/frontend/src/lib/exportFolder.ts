/**
 * A folder on the operator's computer that exports are written into (CONFIGURATION > Admin > Calibration > Export CSV).
 *
 * Uses the File System Access API (window.showDirectoryPicker): Chrome / Edge, over HTTPS or on localhost. The chosen
 * folder handle is remembered per browser in IndexedDB, so it survives reloads; the browser asks once per session to
 * allow writing into it again. Where the API is missing (Firefox, Safari, plain HTTP) callers fall back to a normal
 * download into the browser's download folder.
 *
 * The folder is on the machine running the browser, not on the ionbeam-web server.
 */

// ---- minimal typings: showDirectoryPicker / permissions are not in TypeScript's lib.dom yet ----------------------------------
type PermissionMode = { mode: "read" | "readwrite" };
interface WritableFileStream {
  write(data: Blob | BufferSource | string): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}
interface FileHandleLike {
  createWritable(): Promise<WritableFileStream>;
}
export interface ExportFolderHandle {
  readonly kind: "directory";
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  queryPermission?(descriptor: PermissionMode): Promise<PermissionState>;
  requestPermission?(descriptor: PermissionMode): Promise<PermissionState>;
}
type DirectoryPicker = (options?: { id?: string; mode?: "read" | "readwrite"; startIn?: string | ExportFolderHandle }) => Promise<ExportFolderHandle>;

const DB_NAME = "ionbeam-web";
const STORE = "exportFolders";
export const CALIBRATION_EXPORT_FOLDER = "calibration-csv";

/** True when this browser can write into a chosen folder. */
export function folderPickerSupported(): boolean {
  if (typeof window === "undefined" || !window.isSecureContext) return false;
  if (typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker !== "function") return false;
  try {
    return window.self === window.top; // the picker is blocked in cross-origin frames
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? req.error ?? new Error("IndexedDB error"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  } finally {
    db.close();
  }
}

/** The remembered folder for `purpose`, or null (none chosen, unsupported browser, storage blocked). */
export async function loadExportFolder(purpose: string): Promise<ExportFolderHandle | null> {
  if (!folderPickerSupported()) return null;
  try {
    const handle = await withStore<unknown>("readonly", (s) => s.get(purpose));
    return handle && typeof handle === "object" && (handle as ExportFolderHandle).kind === "directory" ? (handle as ExportFolderHandle) : null;
  } catch {
    return null;
  }
}

/** Forget the folder: exports go to the browser's download folder again. */
export async function clearExportFolder(purpose: string): Promise<void> {
  try {
    await withStore("readwrite", (s) => s.delete(purpose));
  } catch {
    /* nothing stored */
  }
}

/**
 * Let the operator choose a folder (must run from a click) and remember it. Returns null when the dialog is cancelled.
 * Throws when the browser refuses (unsupported, blocked, system folder).
 */
export async function chooseExportFolder(purpose: string, current?: ExportFolderHandle | null): Promise<ExportFolderHandle | null> {
  const picker = (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  if (!picker || !folderPickerSupported()) throw new Error("this browser cannot choose a folder (use Chrome or Edge over HTTPS or localhost)");
  let handle: ExportFolderHandle;
  try {
    handle = await picker({ id: `ionbeam-${purpose}`, mode: "readwrite", ...(current ? { startIn: current } : { startIn: "documents" }) });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return null;
    throw err;
  }
  try {
    await withStore("readwrite", (s) => s.put(handle, purpose));
  } catch {
    /* still usable for this session even if it cannot be remembered */
  }
  return handle;
}

/**
 * Make sure the page may write into `handle`, asking the operator if needed. Call it at the start of a click handler,
 * before any slow await, because the browser only shows the permission prompt during a user gesture.
 */
export async function ensureFolderWritable(handle: ExportFolderHandle): Promise<boolean> {
  const mode: PermissionMode = { mode: "readwrite" };
  try {
    if ((await handle.queryPermission?.(mode)) === "granted") return true;
    return (await handle.requestPermission?.(mode)) === "granted";
  } catch {
    return false;
  }
}

/** Write (or overwrite) `fileName` in the folder. */
export async function writeFileToFolder(handle: ExportFolderHandle, fileName: string, data: Blob): Promise<void> {
  const safeName = fileName.replace(/[\\/:*?"<>|]/g, "_");
  const file = await handle.getFileHandle(safeName, { create: true });
  const stream = await file.createWritable();
  try {
    await stream.write(data);
    await stream.close();
  } catch (err) {
    await stream.abort?.().catch(() => undefined);
    throw err;
  }
}

/** The ordinary download fallback. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
