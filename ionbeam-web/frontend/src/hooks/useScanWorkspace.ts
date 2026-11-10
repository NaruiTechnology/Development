import { useSyncExternalStore } from "react";
import { getWorkspaceStore, useAppWorkspace } from "../store";
import { exposureBusy } from "../store/exposureSlice";
import type { ImageWorkspace } from "../store/scanSlice";

const pending = new Map<symbol, {workspace: ImageWorkspace; purpose: "scan" | "exposure"}>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

/** Both workspaces use one physical instrument, without taking over its owner. */
export function otherWorkspaceBusy(workspace: ImageWorkspace): boolean {
  const other = workspace === "scan" ? "processing" : "scan";
  const state = getWorkspaceStore(other).getState();
  const scan = state.scan;
  return exposureBusy(state.exposure.phase) || scan.phase === "running" || scan.phase === "stopping" || scan.streamRestarting ||
    scan.infiniteActive || scan.roiTargetGrayRun.status === "running" ||
    [...pending.values()].some(owner => owner.workspace === other);
}

export function claimWorkspaceRun(workspace: ImageWorkspace, purpose: "scan" | "exposure" = "scan"): (() => void) | null {
  if (otherWorkspaceBusy(workspace)) return null;
  const {scan, exposure} = getWorkspaceStore(workspace).getState();
  if (exposureBusy(exposure.phase) || [...pending.values()].some(owner => owner.workspace === workspace && owner.purpose !== purpose)) return null;
  if (purpose === "exposure" && (scan.phase === "running" || scan.phase === "stopping" || scan.streamRestarting || scan.infiniteActive || scan.roiTargetGrayRun.status === "running")) return null;
  const token = Symbol(workspace);
  pending.set(token, {workspace, purpose}); notify();
  return () => { pending.delete(token); notify(); };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const unsubscribe = ["scan", "processing"].map(workspace =>
    getWorkspaceStore(workspace as ImageWorkspace).subscribe(listener));
  return () => { listeners.delete(listener); unsubscribe.forEach(stop => stop()); };
}

export function useOtherWorkspaceBusy(): boolean {
  const workspace = useAppWorkspace();
  return useSyncExternalStore(subscribe, () => otherWorkspaceBusy(workspace));
}
