import { useAppSelector } from "../store";
import { useTranslation } from "../i18n";
import { ROIEditor } from "./ROIEditor";
import { useScansUseHardware } from "./TakeoverEstimate";

/**
 * Image source card for the RASTER and VECTOR tabs: the SELECT / Clear image /
 * Clear region actions from the ROI tab plus the current simulation-mode state,
 * so the simulated bitmap can be changed without leaving the scan tab.
 * Hidden when IsProduction is true.
 */
export function SimulationImageCard({
  disabled,
  allowClearRegionWhileDisabled = false,
  lastScanImageUrl = null,
  onLoadLastScan,
}: {
  disabled: boolean;
  allowClearRegionWhileDisabled?: boolean;
  lastScanImageUrl?: string | null;
  onLoadLastScan?: () => void;
}) {
  const { t } = useTranslation();
  const usesHardware = useScansUseHardware();
  // Same rule as ScanControls: anything but an explicit IsProduction=false
  // (including defaults not loaded yet) counts as production.
  const isProduction = useAppSelector((s) => s.status.defaults?.is_production !== false);

  if (isProduction) return null;

  return (
    <div className="card simulation-image-card">
      <div className="card__header">
        <span className="card__title">{t("card.simulationImage")}</span>
        <span
          className={`simulation-image-card__mode simulation-image-card__mode--${usesHardware ? "hardware" : "simulation"}`}
        >
          {t(usesHardware ? "simulation.mode.hardware" : "simulation.mode.simulation")}
        </span>
      </div>
      <div className="card__body">
        <ROIEditor
          disabled={disabled}
          variant="actions"
          allowClearRegionWhileDisabled={allowClearRegionWhileDisabled}
          lastScanImageUrl={lastScanImageUrl}
          onLoadLastScan={onLoadLastScan}
        />
        <p className="muted simulation-image-card__hint">
          {t(usesHardware ? "simulation.image.hintHardware" : "simulation.image.hintSimulation")}
        </p>
      </div>
    </div>
  );
}
