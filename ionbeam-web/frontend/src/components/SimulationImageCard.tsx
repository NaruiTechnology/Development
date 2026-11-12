import { useEffect, useState } from "react";
import { useAppSelector } from "../store";
import { useTranslation } from "../i18n";
import { ROIEditor } from "./ROIEditor";
import { Icon } from "./Icon";

/**
 * Image source card for the RASTER and VECTOR tabs: the SELECT / Clear image /
 * Clear region actions from the ROI tab plus the current simulation-mode hint,
 * so the simulated bitmap can be changed without leaving the scan tab.
 * Collapsed by default when IsProduction is true.
 */
export function SimulationImageCard({
  disabled,
  lastScanImageUrl = null,
  onLoadLastScan,
  autoLoadLastScan,
  onAutoLoadLastScanChange,
  onImageChange,
  calibration = false,
  defaultCollapsed,
}: {
  disabled: boolean;
  calibration?: boolean;
  /** Override the initial state for tabs such as Processing. */
  defaultCollapsed?: boolean;
  lastScanImageUrl?: string | null;
  onLoadLastScan?: (imageUrl?: string | null) => void;
  autoLoadLastScan?: boolean;
  onAutoLoadLastScanChange?: (enabled: boolean) => void;
  onImageChange?: (imageUrl: string | null) => void;
}) {
  const { t } = useTranslation();
  // Same rule as ScanControls: anything but an explicit IsProduction=false
  // (including defaults not loaded yet) counts as production.
  const isProduction = useAppSelector((s) => s.status.defaults?.is_production !== false);
  const initialCollapsed = defaultCollapsed ?? (calibration ? false : isProduction);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  useEffect(() => setCollapsed(initialCollapsed), [initialCollapsed]);

  return (
    <div className="card simulation-image-card">
      <div className="card__header">
        <span className="card__title">{t("card.simulationImage")}</span>
        <button
          type="button"
          className="card__collapse-btn"
          aria-expanded={!collapsed}
          aria-label={`${t("card.simulationImage")}: ${t(collapsed ? "controls.expand" : "controls.collapse")}`}
          onClick={() => setCollapsed((value) => !value)}
        >
          <Icon name="chevronDown" />
        </button>
      </div>
      <div className="card__body" hidden={collapsed}>
        <ROIEditor
          disabled={disabled}
          variant="actions"
          lastScanImageUrl={lastScanImageUrl}
          onLoadLastScan={onLoadLastScan}
          autoLoadLastScan={autoLoadLastScan}
          onAutoLoadLastScanChange={onAutoLoadLastScanChange}
          onImageChange={onImageChange}
        />
      </div>
    </div>
  );
}
