import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";

import { apiUrl } from "../lib/backendUrl";
import { readJsonResponse } from "../lib/readJsonResponse";
import { scanAuthHeaders } from "../lib/authIdentity";

export interface MagCalibrationBeam {
  path: string;
  m_per_fov: Record<string, number>;
}

interface MagCalibrationResponse {
  ok: boolean;
  selected_beam?: string;
  beams?: Record<string, MagCalibrationBeam>;
  error?: string;
}

interface MagCalibrationState {
  loading: boolean;
  saving: boolean;
  error: string | null;
  selectedBeam: string;
  beams: Record<string, MagCalibrationBeam>;
  mag: number;
  measuredLengthM: number;
  measuredPixels: number;
  resolution: number;
}

const initialState: MagCalibrationState = {
  loading: false,
  saving: false,
  error: null,
  selectedBeam: "ion",
  beams: {
    ion: { path: "", m_per_fov: {} },
    ebeam: { path: "", m_per_fov: {} },
  },
  mag: 1000,
  measuredLengthM: 1e-6,
  measuredPixels: 100,
  resolution: 1024,
};

export const fetchMagCalibration = createAsyncThunk<MagCalibrationResponse>(
  "magCalibration/fetch",
  async () => {
    const response = await fetch(apiUrl("/api/admin/mag-calibration"), {
      headers: scanAuthHeaders(),
    });
    if (!response.ok) {
      throw new Error(`mag calibration: HTTP ${response.status} ${await response.text()}`);
    }
    return await readJsonResponse<MagCalibrationResponse>(response, "mag calibration");
  }
);

export const saveMagCalibration = createAsyncThunk<
  MagCalibrationResponse,
  { beam: string; points: Record<string, number>; path?: string }
>("magCalibration/save", async ({ beam, points, path }) => {
  const response = await fetch(apiUrl("/api/admin/mag-calibration"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...scanAuthHeaders() },
    body: JSON.stringify({ beam, m_per_fov: points, path: path ?? "" }),
  });
  if (!response.ok) {
    throw new Error(`save mag calibration: HTTP ${response.status} ${await response.text()}`);
  }
  return await readJsonResponse<MagCalibrationResponse>(response, "save mag calibration");
});

const slice = createSlice({
  name: "magCalibration",
  initialState,
  reducers: {
    setSelectedBeam(s, a: PayloadAction<string>) {
      s.selectedBeam = normalizeBeam(a.payload);
      if (!s.beams[s.selectedBeam]) {
        s.beams[s.selectedBeam] = { path: "", m_per_fov: {} };
      }
    },
    setMag(s, a: PayloadAction<number>) {
      s.mag = clampInteger(a.payload, 1, 10_000_000, s.mag);
    },
    setMeasuredLengthM(s, a: PayloadAction<number>) {
      s.measuredLengthM = clampNumber(a.payload, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER, s.measuredLengthM);
    },
    setMeasuredPixels(s, a: PayloadAction<number>) {
      s.measuredPixels = clampNumber(a.payload, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER, s.measuredPixels);
    },
    setResolution(s, a: PayloadAction<number>) {
      s.resolution = clampInteger(a.payload, 1, 1_000_000, s.resolution);
    },
    addCurrentPoint(s) {
      const fov = computedFov(s);
      if (!Number.isFinite(fov) || fov <= 0) return;
      const beam = ensureBeam(s);
      beam.m_per_fov = sortPoints({
        ...beam.m_per_fov,
        [String(s.mag)]: fov,
      });
    },
    setCurrentPoints(s, a: PayloadAction<Record<string, number>>) {
      ensureBeam(s).m_per_fov = sortPoints(a.payload);
    },
    setCurrentPath(s, a: PayloadAction<string>) {
      ensureBeam(s).path = a.payload;
    },
    clearError(s) {
      s.error = null;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(fetchMagCalibration.pending, (s) => {
      s.loading = true;
      s.error = null;
    });
    builder.addCase(fetchMagCalibration.fulfilled, (s, a) => {
      s.loading = false;
      applyResponse(s, a.payload);
    });
    builder.addCase(fetchMagCalibration.rejected, (s, a) => {
      s.loading = false;
      s.error = a.error.message ?? "failed to load mag calibration";
    });
    builder.addCase(saveMagCalibration.pending, (s) => {
      s.saving = true;
      s.error = null;
    });
    builder.addCase(saveMagCalibration.fulfilled, (s, a) => {
      s.saving = false;
      applyResponse(s, a.payload);
    });
    builder.addCase(saveMagCalibration.rejected, (s, a) => {
      s.saving = false;
      s.error = a.error.message ?? "failed to save mag calibration";
    });
  },
});

function applyResponse(s: MagCalibrationState, response: MagCalibrationResponse) {
  s.selectedBeam = normalizeBeam(response.selected_beam ?? s.selectedBeam);
  s.beams = {
    ...s.beams,
    ...(response.beams ?? {}),
  };
  if (!s.beams[s.selectedBeam]) {
    s.beams[s.selectedBeam] = { path: "", m_per_fov: {} };
  }
  s.error = response.ok ? null : response.error ?? "mag calibration failed";
}

function ensureBeam(s: MagCalibrationState): MagCalibrationBeam {
  if (!s.beams[s.selectedBeam]) {
    s.beams[s.selectedBeam] = { path: "", m_per_fov: {} };
  }
  return s.beams[s.selectedBeam];
}

function computedFov(s: MagCalibrationState): number {
  if (s.measuredPixels <= 0 || s.resolution <= 0) return 0;
  return s.measuredLengthM * (s.resolution / s.measuredPixels);
}

function normalizeBeam(value: string): string {
  const text = value.trim().toLowerCase();
  if (text === "electron" || text === "e-beam") return "ebeam";
  if (text === "ibeam" || text === "i-beam") return "ion";
  return text || "ion";
}

function sortPoints(points: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(points)
      .map(([mag, fov]) => [String(Math.trunc(Number(mag))), Number(fov)] as const)
      .filter(([mag, fov]) => Number(mag) >= 1 && Number.isFinite(fov) && fov > 0)
      .sort(([a], [b]) => Number(a) - Number(b))
  );
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export const {
  addCurrentPoint,
  clearError,
  setCurrentPath,
  setCurrentPoints,
  setMag,
  setMeasuredLengthM,
  setMeasuredPixels,
  setResolution,
  setSelectedBeam,
} = slice.actions;

export default slice.reducer;
