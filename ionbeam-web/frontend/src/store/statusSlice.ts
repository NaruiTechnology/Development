import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { readJsonResponse } from "../lib/readJsonResponse";
import { apiUrl } from "../lib/backendUrl";
import type { ServiceStatus, ServerDefaults } from "../types/api";

const DEFAULTS_CACHE_KEY = "ionbeam:last-good-defaults";

function loadCachedDefaults(): ServerDefaults | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(DEFAULTS_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ServerDefaults;
  } catch {
    return null;
  }
}

function saveCachedDefaults(defaults: ServerDefaults) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DEFAULTS_CACHE_KEY, JSON.stringify(defaults));
  } catch {
    // Ignore storage quota or privacy-mode failures.
  }
}

interface StatusState {
  service: ServiceStatus | null;
  defaults: ServerDefaults | null;
  fetching: boolean;
  lastError: string | null;
}

const initialState: StatusState = {
  service: null,
  defaults: loadCachedDefaults(),
  fetching: false,
  lastError: null,
};

export const fetchStatus = createAsyncThunk<ServiceStatus>(
  "status/fetch",
  async () => {
    const r = await fetch(apiUrl("/api/status"));
    if (!r.ok) throw new Error(`status: HTTP ${r.status}`);
    return await readJsonResponse<ServiceStatus>(r, "status");
  }
);

export const fetchDefaults = createAsyncThunk<ServerDefaults>(
  "status/defaults",
  async () => {
    let lastError = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const r = await fetch(apiUrl("/api/defaults"));
        if (r.ok) return await readJsonResponse<ServerDefaults>(r, "defaults");
        lastError = `defaults: HTTP ${r.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await delay(500);
    }
    throw new Error(lastError || "defaults fetch failed");
  }
);

export const fetchDefaultsMetadata = createAsyncThunk<
  Pick<ServerDefaults, "is_production" | "simulation" | "version">
>(
  "status/defaultsMetadata",
  async () => {
    const r = await fetch(apiUrl("/api/defaults"), { cache: "no-store" });
    if (!r.ok) throw new Error(`defaults metadata: HTTP ${r.status}`);
    const defaults = await readJsonResponse<ServerDefaults>(r, "defaults metadata");
    return {
      is_production: defaults.is_production,
      simulation: defaults.simulation,
      version: defaults.version,
    };
  }
);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

const slice = createSlice({
  name: "status",
  initialState,
  reducers: {
    previewConfigDefaults(
      s,
      a: PayloadAction<{
        simulation?: Record<string, unknown>;
        is_production?: boolean;
        version?: string;
      }>
    ) {
      s.defaults = {
        ...(s.defaults ?? { raster: {}, vector: {} }),
        simulation: a.payload.simulation ?? s.defaults?.simulation,
        is_production: a.payload.is_production ?? s.defaults?.is_production,
        version: a.payload.version ?? s.defaults?.version,
      };
      saveCachedDefaults(s.defaults);
      s.lastError = null;
    },
  },
  extraReducers: (b) => {
    b.addCase(fetchStatus.pending, (s) => {
      s.fetching = true;
    });
    b.addCase(fetchStatus.fulfilled, (s, a) => {
      s.fetching = false;
      s.service = a.payload;
      s.lastError = null;
    });
    b.addCase(fetchStatus.rejected, (s, a) => {
      s.fetching = false;
      s.lastError = a.error.message ?? "status fetch failed";
    });
    b.addCase(fetchDefaults.fulfilled, (s, a) => {
      s.defaults = a.payload;
      saveCachedDefaults(a.payload);
      s.lastError = null;
    });
    b.addCase(fetchDefaults.rejected, (s, a) => {
      if (!s.defaults) {
        s.lastError = a.error.message ?? "defaults fetch failed";
      }
    });
    b.addCase(fetchDefaultsMetadata.fulfilled, (s, a) => {
      s.defaults = {
        ...(s.defaults ?? { raster: {}, vector: {} }),
        simulation: a.payload.simulation ?? s.defaults?.simulation,
        is_production: a.payload.is_production ?? s.defaults?.is_production,
        version: a.payload.version ?? s.defaults?.version,
      };
      saveCachedDefaults(s.defaults);
      s.lastError = null;
    });
    b.addCase(fetchDefaultsMetadata.rejected, (s, a) => {
      if (!s.defaults) {
        s.lastError = a.error.message ?? "defaults metadata fetch failed";
      }
    });
  },
});

export const { previewConfigDefaults } = slice.actions;

export default slice.reducer;
