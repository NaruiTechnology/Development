import { useEffect, useState } from "react";
import { useAppSelector } from "../store";
import { useTranslation } from "../i18n";
import { ROIEditor } from "./ROIEditor";
import { useScansUseHardware } from "./TakeoverEstimate";
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
  onImageChange,
}: {
  disabled: boolean;
  lastScanImageUrl?: string | null;
  onLoadLastScan?: () => void;
  onImageChange?: (imageUrl: string | null) => void;
}) {
  const { t } = useTranslation();
  const usesHardware = useScansUseHardware();
  // Same rule as ScanControls: anything but an explicit IsProduction=false
  // (including defaults not loaded yet) counts as production.
  const isProduction = useAppSelector((s) => s.status.defaults?.is_production !== false);
  const [collapsed, setCollapsed] = useState(isProduction);
  useEffect(() => setCollapsed(isProduction), [isProduction]);

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
          onImageChange={onImageChange}
        />
        <p className="muted simulation-image-card__hint">
          {t(usesHardware ? "simulation.image.hintHardware" : "simulation.image.hintSimulation")}
        </p>
      </div>
    </div>
  );
}
