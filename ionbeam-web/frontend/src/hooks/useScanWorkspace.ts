import { useSyncExternalStore } from "react";
import { getWorkspaceStore, useAppWorkspace } from "../store";
import type { ImageWorkspace } from "../store/scanSlice";

const pending = new Map<symbol, ImageWorkspace>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

/** Both workspaces use one physical instrument, without taking over its owner. */
export function otherWorkspaceBusy(workspace: ImageWorkspace): boolean {
  const other = workspace === "scan" ? "processing" : "scan";
  const scan = getWorkspaceStore(other).getState().scan;
  return scan.phase === "running" || scan.phase === "stopping" || scan.streamRestarting ||
    scan.infiniteActive || scan.roiTargetGrayRun.status === "running" ||
    [...pending.values()].some(owner => owner === other);
}

export function claimWorkspaceRun(workspace: ImageWorkspace): (() => void) | null {
  if (otherWorkspaceBusy(workspace)) return null;
  const token = Symbol(workspace);
  pending.set(token, workspace); notify();
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
