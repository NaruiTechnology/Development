import { updateRaster } from "../store/scanSlice";
import { useAppDispatch, useAppSelector } from "../store";
import { useTranslation } from "../i18n";
import { DwellHelp } from "./DwellHelp";
import { ResolutionHelp } from "./ResolutionHelp";
import { PresetNumberField, type PresetNumberOption } from "./PresetNumberField";
import {
  estimateRevC3ScanTiming,
  formatDuration,
  formatNanoseconds,
  revC3DwellPresetOptions,
} from "../lib/scanTiming";

const RES_PRESETS: PresetNumberOption[] = [128, 256, 512, 1024, 2048].map((value) => ({ value }));

export function RasterScanExecutionSettings({ disabled }: { disabled: boolean }) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const raster = useAppSelector((state) => state.scan.raster);
  const halfPeriod = useAppSelector((state) => Number(state.status.defaults?.adc?.adcHalfPeriod ?? 3));
  const timing = estimateRevC3ScanTiming(raster.resolution, raster.dwell, halfPeriod);
  const dwellPresets = revC3DwellPresetOptions(undefined, halfPeriod);

  return (
    <div className="scan-execution-settings">
      <div className="field-row">
        <PresetNumberField
          label={<label>{t("raster.resolution")}<ResolutionHelp /></label>}
          value={raster.resolution}
          options={RES_PRESETS}
          min={1}
          max={2048}
          disabled={disabled}
          onChange={(value) => dispatch(updateRaster({ resolution: value }))}
        />
        <PresetNumberField
          label={<label>{t("scan.dwell.dynamic", {
            dwell: raster.dwell,
            period: formatNanoseconds(timing.samplePeriodNs),
            samples: timing.samplesPerPixel,
            pixel: formatNanoseconds(timing.pixelDwellNs),
            resolution: raster.resolution,
            frame: formatDuration(timing.frameSeconds),
          })}<DwellHelp /></label>}
          value={raster.dwell}
          options={dwellPresets}
          min={0}
          max={65535}
          disabled={disabled}
          onChange={(value) => dispatch(updateRaster({ dwell: value }))}
        />
      </div>
    </div>
  );
}
