import { useAppDispatch, useAppSelector } from "../store";
import { updateVector } from "../store/scanSlice";
import { useTranslation } from "../i18n";
import { estimateRevC3ScanTiming, formatDuration, formatNanoseconds, revC3DwellPresetOptions } from "../lib/scanTiming";
import { DwellHelp } from "./DwellHelp";
import { PresetNumberField, type PresetNumberOption } from "./PresetNumberField";
import { VectorResolutionHelp } from "./VectorResolutionHelp";
import { VectorScanPathField } from "./VectorScanPathField";

const RESOLUTIONS = [2048, 1024, 512, 256, 128] as const;

function validateResolution(value: number, t: (key: "vector.resolution.validation.powerOfTwo" | "vector.resolution.validation.min128") => string) {
  const integer = Math.trunc(value);
  if (integer < 128) return t("vector.resolution.validation.min128");
  if (!Number.isInteger(integer) || (integer & (integer - 1)) !== 0) {
    return t("vector.resolution.validation.powerOfTwo");
  }
  return null;
}

export function VectorScanExecutionSettings({ disabled, grayLevelFilterActive = false }: {
  disabled: boolean;
  grayLevelFilterActive?: boolean;
}) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const vector = useAppSelector((state) => state.scan.vector);
  const halfPeriod = useAppSelector((state) => Number(state.status.defaults?.adc?.adcHalfPeriod ?? 3));
  const timing = estimateRevC3ScanTiming(vector.vector_resolution, vector.dwell, halfPeriod);
  const dwellOptions = revC3DwellPresetOptions(undefined, halfPeriod);
  const resolutionOptions: PresetNumberOption[] = RESOLUTIONS.map((value) => ({
    value,
    label: t(`vector.resolution.option.${value}` as const),
  }));
  const resolutionTitle = vector.vector_resolution === 2048
    ? t("vector.resolution.title.native")
    : 2048 % vector.vector_resolution === 0
      ? t("vector.resolution.title.stride", { stride: 2048 / vector.vector_resolution })
      : t("vector.resolution.title.custom", { resolution: vector.vector_resolution });

  if (vector.pattern !== "default") return null;

  return (
    <div className="vector-scan-execution-settings">
      <VectorScanPathField disabled={disabled} />
      <div className="field-row">
        <PresetNumberField
          label={<label>{t("vector.resolution")}<VectorResolutionHelp /></label>}
          value={vector.vector_resolution}
          options={resolutionOptions}
          min={grayLevelFilterActive ? 128 : 1}
          max={2048}
          disabled={disabled}
          title={resolutionTitle}
          customValidate={(value) => validateResolution(value, t)}
          normalizeValue={(value) => grayLevelFilterActive ? Math.max(128, value) : value}
          onChange={(value) => dispatch(updateVector({ vector_resolution: value }))}
        />
        <PresetNumberField
          label={<label>{t("scan.dwell.dynamic", {
            dwell: vector.dwell,
            period: formatNanoseconds(timing.samplePeriodNs),
            samples: timing.samplesPerPixel,
            pixel: formatNanoseconds(timing.pixelDwellNs),
            resolution: vector.vector_resolution,
            frame: formatDuration(timing.frameSeconds),
          })}<DwellHelp /></label>}
          value={vector.dwell}
          options={dwellOptions}
          min={grayLevelFilterActive ? 2 : 0}
          max={65535}
          disabled={disabled}
          normalizeValue={(value) => grayLevelFilterActive ? Math.max(2, value) : value}
          onChange={(value) => dispatch(updateVector({ dwell: value }))}
        />
      </div>
    </div>
  );
}
