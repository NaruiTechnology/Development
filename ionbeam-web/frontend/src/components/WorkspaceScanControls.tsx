import { useRef, type ComponentProps } from "react";
import { WorkspaceProvider, useAppSelector } from "../store";
import type { ImageWorkspace } from "../store/scanSlice";
import { ScanControls } from "./ScanControls";

type Props = ComponentProps<typeof ScanControls> & { workspace: ImageWorkspace; active: boolean };

/** Each controller stays mounted under its own store, including while hidden. */
export function WorkspaceScanControls({ workspace, ...props }: Props) {
  return <WorkspaceProvider workspace={workspace} active={props.active}>
    <RetainedScanControls {...props} />
  </WorkspaceProvider>;
}

function RetainedScanControls({ active, ...props }: Omit<Props, "workspace">) {
  const retained = useRef<ComponentProps<typeof ScanControls>>({ ...props, vectorGrayScaleSelection: null, vectorGrayScaleSkipped: null });
  if (active) retained.current = props;
  const phase = useAppSelector(s => s.scan.phase);
  const restarting = useAppSelector(s => s.scan.streamRestarting);
  const running = phase === "running" || phase === "stopping" || restarting;
  return <ScanControls {...retained.current} scanActive={running}
    disabled={active ? props.disabled : running} />;
}
