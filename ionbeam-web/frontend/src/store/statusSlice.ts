import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
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
    const r = await fetch("/api/defaults");
    if (!r.ok) throw new Error(`defaults: HTTP ${r.status}`);
    return (await r.json()) as ServerDefaults;
  }
);

export const reconnectDevice = createAsyncThunk<ServiceStatus>(
  "status/reconnect",
  async () => {
    const r = await fetch("/api/admin/reconnect", { method: "POST" });
    if (!r.ok) throw new Error(`reconnect: HTTP ${r.status}`);
    return (await r.json()) as ServiceStatus;
  }
);

const slice = createSlice({
  name: "status",
  initialState,
  reducers: {},
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
    });
    b.addCase(reconnectDevice.fulfilled, (s, a) => {
      s.service = a.payload;
    });
    b.addCase(reconnectDevice.rejected, (s, a) => {
      s.lastError = a.error.message ?? "reconnect failed";
    });
  },
});

export default slice.reducer;
