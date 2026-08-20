import { useAppDispatch, useAppSelector } from "../store";
import { updateRaster } from "../store/scanSlice";
import { useTranslation } from "../i18n";
import { DwellHelp } from "./DwellHelp";
import { PresetNumberField, type PresetNumberOption } from "./PresetNumberField";
import { ResolutionHelp } from "./ResolutionHelp";

const RESOLUTION_OPTIONS: PresetNumberOption[] = [128, 256, 512, 1024, 2048].map((value) => ({ value }));
const DWELL_OPTIONS: PresetNumberOption[] = [1, 2, 4, 8, 16, 32, 64].map((value) => ({ value }));

export function ROIRasterActionWedges({ disabled }: { disabled: boolean }) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const raster = useAppSelector((s) => s.scan.raster);

  return (
    <div className="roi-action-vector-wedges">
      <div className="card__title" style={{ marginBottom: 6 }}>
        {t("tabs.roi")} {t("tabs.raster")}
      </div>
      <div className="field-row">
        <PresetNumberField
          label={
            <label>
              {t("raster.resolution")}
              <ResolutionHelp />
            </label>
          }
          value={raster.resolution}
          options={RESOLUTION_OPTIONS}
          min={1}
          max={2048}
          disabled={disabled}
          onChange={(value) => dispatch(updateRaster({ resolution: value }))}
        />
        <PresetNumberField
          label={
            <label>
              {t("raster.dwell")}
              <DwellHelp />
            </label>
          }
          value={raster.dwell}
          options={DWELL_OPTIONS}
          min={1}
          max={65535}
          disabled={disabled}
          onChange={(value) => dispatch(updateRaster({ dwell: value }))}
        />
      </div>
    </div>
  );
}
