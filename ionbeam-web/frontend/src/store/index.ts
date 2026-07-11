import { configureStore } from "@reduxjs/toolkit";
import { useDispatch, useSelector, type TypedUseSelectorHook } from "react-redux";

import statusReducer from "./statusSlice";
import scanReducer from "./scanSlice";
import imageReducer from "./imageSlice";
import themeReducer from "./themeSlice";
import localeReducer from "./localeSlice";
import settingsReducer from "./settingsSlice";
import magCalibrationReducer from "./magCalibrationSlice";

export const store = configureStore({
  reducer: {
    status: statusReducer,
    scan: scanReducer,
    image: imageReducer,
    theme: themeReducer,
    locale: localeReducer,
    settings: settingsReducer,
    magCalibration: magCalibrationReducer,
  },
  // The image slice carries large typed arrays (Uint16Array up to 8 MB for
  // the 2048x2048 vector render target) plus an ArrayBuffer of points for
  // custom vector mode. Redux's serializability check would deep-walk
  // these on every dispatch and DevTools would try to clone them — both
  // are pointlessly expensive. Whitelist the action types and state paths
  // that touch these buffers.
  middleware: (getDefault) =>
    getDefault({
      immutableCheck: {
        // Image reducers intentionally manage multi-megabyte typed arrays.
        // Avoid deep-walking those buffers after every streamed chunk while
        // retaining mutation checks for the rest of the application state.
        ignoredPaths: ["image"],
      },
      serializableCheck: {
        ignoredPaths: [
          "image.frame",
          "image.vectorImage",
          "image.vectorCustomPoints",
          "image.vectorCustomRenderPoints",
          "image.vectorCustomBlankMask",
          "image.vectorCustomSpotMask",
        ],
        ignoredActions: [
          "image/resetRaster",
          "image/appendRaster",
          "image/setupVector",
          "image/appendVectorSamples",
          "image/resetVector",
        ],
      },
    }),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch: () => AppDispatch = useDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
