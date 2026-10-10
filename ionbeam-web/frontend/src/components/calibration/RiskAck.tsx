/**
 * Risk acknowledgement used wherever a calibration write touches vendor-undocumented, fixed or low-confidence
 * parameters (save bar, History restore, vendor-file import): a yellow warning box that turns green once ticked.
 */
import type { ReactNode } from "react";

import { Icon } from "../Icon";

export function RiskAck({ checked, onChange, children, className }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode; className?: string }) {
  return (
    <label className={className ? `calib-ack ${className}` : "calib-ack"} data-checked={checked ? "true" : "false"}>
      <input type="checkbox" className="calib-ack__box" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <Icon name={checked ? "check" : "alertTriangle"} tone={checked ? "success" : "warn"} />
      <span className="calib-ack__text">{children}</span>
    </label>
  );
}
