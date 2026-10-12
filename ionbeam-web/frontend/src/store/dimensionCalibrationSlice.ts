import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

import {
  loadDimensionCalibration,
  type DimensionCalibrationValues,
} from "../lib/dimensionCalibrationPersistence";

const defaults: DimensionCalibrationValues = {
  x_origin: 0,
  x_end: 7000,
  y_origin: 0,
  y_end: 5000,
  // Inset 494 × 255 starting rectangle matching the canvas reference (640 px).
  viewport_x_start: 64,
  viewport_x_end: 558,
  viewport_y_start: 196,
  viewport_y_end: 451,
  scale_unit: "um",
};

export interface DimensionCalibrationState {
  values: DimensionCalibrationValues;
  persisted: boolean;
}

const loaded = loadDimensionCalibration();
const initialState: DimensionCalibrationState = {
  values: loaded ?? defaults,
  persisted: loaded !== null,
};

const slice = createSlice({
  name: "dimensionCalibration",
  initialState,
  reducers: {
    saveDimensionCalibration(state, action: PayloadAction<DimensionCalibrationValues>) {
      state.values = action.payload;
      state.persisted = true;
    },
  },
});

export const { saveDimensionCalibration } = slice.actions;
export default slice.reducer;
