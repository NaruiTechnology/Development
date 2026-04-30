import { configureStore } from "@reduxjs/toolkit";
import { useDispatch, useSelector, type TypedUseSelectorHook } from "react-redux";

import statusReducer from "./statusSlice";
import scanReducer from "./scanSlice";
import imageReducer from "./imageSlice";

export const store = configureStore({
  reducer: {
    status: statusReducer,
    scan: scanReducer,
    image: imageReducer,
  },
  // Pixel buffers are big Uint8ClampedArrays — Redux's serializability check
  // chokes on them, and serialising them through the devtools is a
  // performance killer anyway. We keep the rest of state plain JSON and
  // just exempt the canvas image data slice.
  middleware: (getDefault) =>
    getDefault({
      serializableCheck: {
        ignoredPaths: ["image.frame"],
        ignoredActions: ["image/setFrame"],
      },
    }),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch: () => AppDispatch = useDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
