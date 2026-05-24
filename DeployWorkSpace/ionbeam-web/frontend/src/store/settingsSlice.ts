/**
 * settingsSlice — owns the streamData.json edit-buffer, dialog visibility,
 * and the thunks that hit the new /api/admin/config endpoints.
 *
 * Design notes
 * ------------
 *  - The slice carries TWO copies of the JSON:
 *      `source`  — last value loaded from the server (or saved to it),
 *                  treated as the canonical baseline for diffing.
 *      `draft`   — currently displayed in the dialog tabs, mutated as
 *                  the operator types. `isDirty` is `draft !== source`
 *                  by reference, with deep-equal as a finer check.
 *    Two copies sound wasteful but the file is small (single-digit
 *    KB) and keeping the original lets us implement "discard changes"
 *    without a refetch round-trip.
 *
 *  - The JSON shape is intentionally loose (`unknown` everywhere) on
 *    purpose: the canonical schema lives in the python Pydantic models,
 *    and re-declaring it here in TS would create a maintenance bind
 *    the first time the python schema grows a new field. The dialog
 *    reads fields via the path-based accessors below which apply
 *    defensive `??` chains.
 *
 *  - `dialogOpen` lives here rather than in component state because
 *    opening the dialog must coordinate with the scan WS (stop the
 *    stream first). The orchestration is performed by the gear button
 *    handler in Header.tsx, which closes the active scan stream via
 *    the shared scanActionRegistry before dispatching openDialog().
 */
import {
  createAsyncThunk,
  createSlice,
  type PayloadAction,
} from "@reduxjs/toolkit";

export interface SettingsConfigInfo {
  path: string;
  backup_path: string;
  data: unknown;
  has_backup: boolean;
  /** True only on the call that created the backup as a side effect. */
  backup_created?: boolean;
}

export interface RestartResult {
  ok: boolean;
  command: string;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface BackendRestartResult {
  ok: boolean;
  scheduled: boolean;
  mode: "disabled" | "exit" | "command";
  command?: string;
  error?: string;
}

export interface SaveResponse {
  ok: boolean;
  restart: RestartResult;
  backend_restart?: BackendRestartResult;
}

interface SettingsState {
  dialogOpen: boolean;
  /** Active tab inside the dialog. */
  activeTab: SettingsTab;

  loading: boolean;
  saving: boolean;
  restoring: boolean;

  /** Last known canonical data (server-side state at the most recent
   *  successful GET/POST). */
  source: unknown | null;
  /** Editable copy bound to the dialog inputs. */
  draft: unknown | null;

  configPath: string | null;
  backupPath: string | null;
  hasBackup: boolean;

  /** Last error from any of the config thunks. */
  error: string | null;
  /** Last restart-command result, surfaced under the buttons after a save. */
  lastRestart: RestartResult | null;
  /** "Backup created on first read" notice; consumed by the dialog once. */
  backupNotice: boolean;
}

export type SettingsTab = "general" | "raster" | "vector" | "pins" | "simulation";

const initialState: SettingsState = {
  dialogOpen: false,
  activeTab: "general",
  loading: false,
  saving: false,
  restoring: false,
  source: null,
  draft: null,
  configPath: null,
  backupPath: null,
  hasBackup: false,
  error: null,
  lastRestart: null,
  backupNotice: false,
};

/* -------- async thunks ------------------------------------------------- */

export const fetchSettingsConfig = createAsyncThunk<SettingsConfigInfo>(
  "settings/fetch",
  async () => {
    const r = await fetch("/api/admin/config");
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`fetch config: HTTP ${r.status} ${text}`);
    }
    return (await r.json()) as SettingsConfigInfo;
  }
);

export const saveSettingsConfig = createAsyncThunk<
  SaveResponse,
  unknown
>("settings/save", async (data) => {
  const r = await fetch("/api/admin/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`save config: HTTP ${r.status} ${text}`);
  }
  return (await r.json()) as SaveResponse;
});

export const restoreSettingsConfig = createAsyncThunk<SaveResponse>(
  "settings/restore",
  async () => {
    const r = await fetch("/api/admin/config/restore", { method: "POST" });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`restore config: HTTP ${r.status} ${text}`);
    }
    return (await r.json()) as SaveResponse;
  }
);

export const restartSettingsServices = createAsyncThunk<SaveResponse>(
  "settings/restartServices",
  async () => {
    const r = await fetch("/api/admin/restart-services", { method: "POST" });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`restart services: HTTP ${r.status} ${text}`);
    }
    return (await r.json()) as SaveResponse;
  }
);

/* -------- slice -------------------------------------------------------- */

const slice = createSlice({
  name: "settings",
  initialState,
  reducers: {
    openDialog(s) {
      s.dialogOpen = true;
      s.error = null;
      // Lazy load is triggered by the component on mount; we don't pre-
      // clear source/draft here so a quick re-open within the same
      // session can render instantly with stale data while a fresh
      // fetch runs in the background.
    },
    closeDialog(s) {
      s.dialogOpen = false;
      s.draft = s.source; // discard unsaved edits on close
      s.error = null;
      s.backupNotice = false;
      s.lastRestart = null;
    },
    setActiveTab(s, a: PayloadAction<SettingsTab>) {
      s.activeTab = a.payload;
    },
    /**
     * Replace the draft with a new JSON tree. Used by the tab editors
     * when an input changes. We accept the whole tree (not a per-tab
     * diff) so the editor can be the source of truth for the
     * post-edit shape — simpler than trying to compose patches on the
     * way out.
     */
    setDraft(s, a: PayloadAction<unknown>) {
      s.draft = a.payload;
    },
    /** Reset the draft to the last loaded source — "Discard changes". */
    resetDraft(s) {
      s.draft = s.source;
    },
    clearError(s) {
      s.error = null;
    },
    setError(s, a: PayloadAction<string>) {
      s.error = a.payload;
    },
    consumeBackupNotice(s) {
      s.backupNotice = false;
    },
    clearLastRestart(s) {
      s.lastRestart = null;
    },
  },
  extraReducers: (b) => {
    /* fetch ------------------------------------------------------------ */
    b.addCase(fetchSettingsConfig.pending, (s) => {
      s.loading = true;
      s.error = null;
    });
    b.addCase(fetchSettingsConfig.fulfilled, (s, a) => {
      s.loading = false;
      s.source = a.payload.data;
      s.draft = a.payload.data;
      s.configPath = a.payload.path;
      s.backupPath = a.payload.backup_path;
      s.hasBackup = a.payload.has_backup;
      if (a.payload.backup_created) {
        s.backupNotice = true;
      }
    });
    b.addCase(fetchSettingsConfig.rejected, (s, a) => {
      s.loading = false;
      s.error = a.error.message ?? "failed to load config";
    });

    /* save ------------------------------------------------------------- */
    b.addCase(saveSettingsConfig.pending, (s) => {
      s.saving = true;
      s.error = null;
      s.lastRestart = null;
    });
    b.addCase(saveSettingsConfig.fulfilled, (s, a) => {
      s.saving = false;
      s.lastRestart = a.payload.restart;
      // The save endpoint doesn't echo the saved JSON back (saves a
      // round-trip on a multi-KB blob); promote the draft to source
      // ourselves so the next "discard changes" / dirty check works.
      s.source = s.draft;
    });
    b.addCase(saveSettingsConfig.rejected, (s, a) => {
      s.saving = false;
      s.error = a.error.message ?? "failed to save config";
    });

    /* restore ---------------------------------------------------------- */
    b.addCase(restoreSettingsConfig.pending, (s) => {
      s.restoring = true;
      s.error = null;
      s.lastRestart = null;
    });
    b.addCase(restoreSettingsConfig.fulfilled, (s, a) => {
      s.restoring = false;
      s.lastRestart = a.payload.restart;
      // The server overwrote the live file with the backup. The
      // component dispatches fetchSettingsConfig() right after the
      // restore thunk resolves, so source/draft reload to the
      // restored values.
    });
    b.addCase(restoreSettingsConfig.rejected, (s, a) => {
      s.restoring = false;
      s.error = a.error.message ?? "failed to restore config";
    });

    /* restart services ------------------------------------------------- */
    b.addCase(restartSettingsServices.pending, (s) => {
      s.saving = true;
      s.error = null;
      s.lastRestart = null;
    });
    b.addCase(restartSettingsServices.fulfilled, (s, a) => {
      s.saving = false;
      s.lastRestart = a.payload.restart;
    });
    b.addCase(restartSettingsServices.rejected, (s, a) => {
      s.saving = false;
      s.error = a.error.message ?? "failed to restart services";
    });
  },
});

export const {
  openDialog,
  closeDialog,
  setActiveTab,
  setDraft,
  resetDraft,
  clearError,
  setError,
  consumeBackupNotice,
  clearLastRestart,
} = slice.actions;

export default slice.reducer;

/* -------- path helpers --------------------------------------------------
 *
 * Defensive accessors for the loosely-typed JSON. The tab editors read
 * subtrees via readPath() and write back with writePath(), which
 * produces a new tree with the relevant ancestor chain shallow-cloned
 * so React keyed renders only invalidate the changed branch.
 * --------------------------------------------------------------------- */

/** Read a path like ["Actions", 0, "streamData"] safely. */
export function readPath(root: unknown, path: ReadonlyArray<string | number>): unknown {
  let cur: any = root;
  for (const k of path) {
    if (cur == null) return undefined;
    cur = cur[k as any];
  }
  return cur;
}

/**
 * Immutably replace `root` at `path` with `value`, returning a fresh
 * tree. Each ancestor along the path is shallow-cloned so the
 * unrelated branches keep their object identity.
 */
export function writePath(
  root: unknown,
  path: ReadonlyArray<string | number>,
  value: unknown
): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  const cur: any =
    root && typeof root === "object"
      ? root
      : typeof head === "number"
      ? []
      : {};
  const clone: any = Array.isArray(cur) ? [...cur] : { ...cur };
  clone[head as any] = writePath(cur[head as any], rest, value);
  return clone;
}

/**
 * Conventional locations of each tab's editable subtree within
 * streamData.json. Defined here once so the dialog and the slice
 * agree on what "General"/"Raster"/"Vector" actually map to.
 *
 * The default schema looks like:
 *
 *   {
 *     "Glasgow": {...},
 *     "Actions": [
 *       { "streamData": {
 *           "actionData": {
 *             "voltage": 2.5, "frequency": 1000, ... ,
 *             "rasterScan": {...},
 *             "vectorScan": {...},
 *             "pins": {...}, "simulation": {...}
 *           },
 *           "timeout": 60.0
 *         }
 *       },
 *       { "launchUI": {...} }
 *     ],
 *     "LogName": "...", "Verbose": true, "IsProduction": false, ...
 *   }
 *
 * General edits the top-level scalar flags + the basic actionData
 * fields (voltage, frequency, etc) that aren't raster- or
 * vector-specific. The Raster and Vector tabs edit their
 * respective subtrees verbatim.
 */
export const ACTION_DATA_PATH: ReadonlyArray<string | number> = [
  "Actions",
  0,
  "streamData",
  "actionData",
];

export const RASTER_PATH: ReadonlyArray<string | number> = [
  ...ACTION_DATA_PATH,
  "rasterScan",
];

export const VECTOR_PATH: ReadonlyArray<string | number> = [
  ...ACTION_DATA_PATH,
  "vectorScan",
];

export const PINS_PATH: ReadonlyArray<string | number> = [
  ...ACTION_DATA_PATH,
  "pins",
];

export const SIMULATION_PATH: ReadonlyArray<string | number> = [
  ...ACTION_DATA_PATH,
  "simulation",
];
