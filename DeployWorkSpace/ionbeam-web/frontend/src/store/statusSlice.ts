import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { ServiceStatus, ServerDefaults } from "../types/api";

interface StatusState {
  service: ServiceStatus | null;
  defaults: ServerDefaults | null;
  fetching: boolean;
  lastError: string | null;
}

const initialState: StatusState = {
  service: null,
  defaults: null,
  fetching: false,
  lastError: null,
};

export const fetchStatus = createAsyncThunk<ServiceStatus>(
  "status/fetch",
  async () => {
    const r = await fetch("/api/status");
    if (!r.ok) throw new Error(`status: HTTP ${r.status}`);
    return (await r.json()) as ServiceStatus;
  }
);

export const fetchDefaults = createAsyncThunk<ServerDefaults>(
  "status/defaults",
  async () => {
    let lastError = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const r = await fetch("/api/defaults");
        if (r.ok) return (await r.json()) as ServerDefaults;
        lastError = `defaults: HTTP ${r.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await delay(500);
    }
    throw new Error(lastError || "defaults fetch failed");
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
      }>
    ) {
      s.defaults = {
        ...(s.defaults ?? { raster: {}, vector: {} }),
        simulation: a.payload.simulation ?? s.defaults?.simulation,
        is_production: a.payload.is_production ?? s.defaults?.is_production,
      };
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
      s.lastError = null;
    });
    b.addCase(fetchDefaults.rejected, (s, a) => {
      s.lastError = a.error.message ?? "defaults fetch failed";
    });
  },
});

export const { previewConfigDefaults } = slice.actions;

export default slice.reducer;
