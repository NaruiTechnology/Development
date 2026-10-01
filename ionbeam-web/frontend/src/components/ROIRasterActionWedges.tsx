import { ROIActionWedges } from "./ROIActionWedges";

export function ROIRasterActionWedges({ disabled }: { disabled: boolean }) {
  return <ROIActionWedges mode="raster" disabled={disabled} />;
}
