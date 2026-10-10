import { ROIActionWedges } from "./ROIActionWedges";

export function ROIGrayActionVectorWedges({ active, disabled }: { active: boolean; disabled: boolean }) {
  return <ROIActionWedges mode="vector" active={active} disabled={disabled} />;
}
