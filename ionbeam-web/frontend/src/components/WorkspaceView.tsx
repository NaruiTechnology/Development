import { useRef, type ReactNode } from "react";
import { WorkspaceProvider } from "../store";
import type { ImageWorkspace } from "../store/scanSlice";

/** Keep drawings, wedge state and in-flight actions mounted in their own workspace. */
export function WorkspaceView({ workspace, active, children }: {
  workspace: ImageWorkspace; active: boolean; children: ReactNode;
}) {
  const retained = useRef<ReactNode>(null);
  if (active) retained.current = children;
  return <div hidden={!active} data-workspace={workspace}>
    <WorkspaceProvider workspace={workspace} active={active}>{retained.current}</WorkspaceProvider>
  </div>;
}
