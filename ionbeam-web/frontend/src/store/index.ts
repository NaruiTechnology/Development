import { combineReducers, configureStore, createListenerMiddleware, isAction, type Middleware } from "@reduxjs/toolkit";
import { createContext, createElement, useContext, type ReactNode } from "react";
import { Provider, useDispatch, useSelector, useStore, type TypedUseSelectorHook } from "react-redux";

import statusReducer, { fetchDefaults } from "./statusSlice";
import scanReducer, { setImageWorkspace, setKind, type ImageWorkspace } from "./scanSlice";
import imageReducer from "./imageSlice";
import themeReducer from "./themeSlice";
import localeReducer from "./localeSlice";
import settingsReducer from "./settingsSlice";
import magCalibrationReducer from "./magCalibrationSlice";
import processingReducer from "./processingSlice";
import dimensionCalibrationReducer, { saveDimensionCalibration } from "./dimensionCalibrationSlice";
import { persistDimensionCalibration } from "../lib/dimensionCalibrationPersistence";

const reducers = {
    status: statusReducer,
    scan: scanReducer,
    image: imageReducer,
    theme: themeReducer,
    locale: localeReducer,
    settings: settingsReducer,
    magCalibration: magCalibrationReducer,
    processing: processingReducer,
    dimensionCalibration: dimensionCalibrationReducer,
};

const calibrationPersistence = createListenerMiddleware();

export const store = configureStore({
  // Streaming actions carry large pixel/point buffers. Retaining an action
  // history duplicates those buffers throughout a continuous scan.
  devTools: false,
  reducer: reducers,
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
          "image",
          "image.frame",
          "image.vectorImage",
          "image.vectorCustomPoints",
          "image.vectorCustomRenderPoints",
          "image.vectorCustomBlankMask",
          "image.vectorCustomSpotMask",
        ],
        ignoredActions: [
          "image/queueLiveScanDisplay",
          "image/seedVectorRegions",
          "image/setLiveVectorCustomPoints",
          "image/resetRaster",
          "image/appendRaster",
          "image/setupVector",
          "image/appendVectorSamples",
          "image/resetVector",
        ],
      },
    }).prepend(calibrationPersistence.middleware),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// Acquisition data and thunks stay in their owning store. Only application
// configuration (locale, auth/settings and service status) is synchronized.
const sharedKeys = ["status", "theme", "locale", "settings", "dimensionCalibration"] as const;
const reduceWorkspace = combineReducers(reducers);
const forwardSharedActions: Middleware = () => next => action => {
  if (isAction(action) && !/^(scan|image|processing|magCalibration|workspace)\//.test(action.type)) {
    return store.dispatch(action);
  }
  return next(action);
};
const processingStore = configureStore({
  devTools: false,
  preloadedState: structuredClone(store.getState()),
  reducer: (state: RootState | undefined, action: Parameters<typeof reduceWorkspace>[1]): RootState => {
    const next = reduceWorkspace(state, action);
    if (action.type !== "workspace/shared") return next;
    const shared = (action as unknown as { payload: RootState }).payload;
    const scan = !next.status.defaults && shared.status.defaults
      ? scanReducer(next.scan, fetchDefaults.fulfilled(shared.status.defaults, "workspace-initial-defaults"))
      : next.scan;
    return { ...next, scan, ...Object.fromEntries(sharedKeys.map(key => [key, shared[key]])) } as RootState;
  },
  middleware: getDefault => getDefault({
    immutableCheck: { ignoredPaths: ["image"] },
    serializableCheck: { ignoredPaths: ["image"], ignoredActionPaths: ["payload", "meta.arg"] },
  }).concat(forwardSharedActions),
});
let sharedState = store.getState();
processingStore.dispatch({ type: "workspace/shared", payload: sharedState });
processingStore.dispatch(setImageWorkspace("processing"));
processingStore.dispatch(setKind("roi"));
store.subscribe(() => {
  const next = store.getState();
  if (sharedKeys.some(key => next[key] !== sharedState[key])) {
    sharedState = next;
    processingStore.dispatch({ type: "workspace/shared", payload: next });
  }
});

export function getWorkspaceStore(workspace: ImageWorkspace): typeof store {
  return (workspace === "processing" ? processingStore : store) as typeof store;
}

const WorkspaceActivity = createContext(true);

export function WorkspaceProvider({ workspace, active = true, children }: {
  workspace: ImageWorkspace; active?: boolean; children: ReactNode;
}) {
  return createElement(Provider, { store: getWorkspaceStore(workspace),
    children: createElement(WorkspaceActivity.Provider, { value: active, children }) });
}

export const useWorkspaceActive = () => useContext(WorkspaceActivity);

export function useAppWorkspace(): ImageWorkspace {
  return useStore() === processingStore ? "processing" : "scan";
}

export const useAppStore = () => useStore() as typeof store;


calibrationPersistence.startListening({
  actionCreator: saveDimensionCalibration,
  effect: (action) => {
    persistDimensionCalibration(action.payload);
  },
});

export const useAppDispatch: () => AppDispatch = useDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
