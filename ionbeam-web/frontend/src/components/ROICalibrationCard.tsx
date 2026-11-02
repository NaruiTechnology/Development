import { measuredFieldSpan } from "../lib/dimensionMeasurement";
import { useEffect, useState } from "react";

import { useAppDispatch, useAppSelector } from "../store";
import { applyPersistedDimensionCalibration, setScanGeometry, updateROI } from "../store/scanSlice";
import { saveDimensionCalibration } from "../store/dimensionCalibrationSlice";
import { shortTimestamp, type DimensionCalibrationSource } from "../lib/dimensionCalibrationPersistence";
import { saveDimensionCalibrationRemote } from "../lib/dimensionCalibrationApi";
import { selectedEquipmentId } from "../lib/adminActivity";
import { clearBitmapSelectionCache } from "../lib/bitmapVector";
import { viewportBounds } from "../lib/roiGeometry";
import { useTranslation, type TranslationKey } from "../i18n";
import { Icon } from "./Icon";
import { NumberStepperInput } from "./NumberStepperField";

const UNITS: Record<string, string> = {
  um: "μm",
  mm: "mm",
  cm: "cm",
  nm: "nm",
};

export function ROICalibrationCard({
  disabled,
  lastScanImageUrl = null,
  onLoadLastScan,
}: {
  disabled: boolean;
  lastScanImageUrl?: string | null;
  onLoadLastScan?: () => void;
}) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const roi = useAppSelector((s) => s.scan.roi);
  const currentSource = useAppSelector((s) => s.dimensionCalibration.values.source);
  const bounds = viewportBounds(roi, "draft");

  const [xSpan, setXSpan] = useState((roi.x_end - roi.x_origin) * bounds.width / 640);
  const [ySpan, setYSpan] = useState((roi.y_end - roi.y_origin) * bounds.height / 640);
  useEffect(() => {
    setXSpan((roi.x_end - roi.x_origin) * bounds.width / 640);
    setYSpan((roi.y_end - roi.y_origin) * bounds.height / 640);
  }, [roi.x_origin, roi.x_end, roi.y_origin, roi.y_end, bounds.width, bounds.height]);
  const unit = UNITS[roi.scale_unit] ?? roi.scale_unit;
  const validation = !Number.isFinite(xSpan) || !Number.isFinite(ySpan) || xSpan <= 0 || ySpan <= 0
    ? "Enter positive X and Y texture lengths." : null;
  const canConfirm = !validation;

  function confirmCalibration() {
    if (disabled || validation) return;
    clearBitmapSelectionCache();
    const values = {
      x_origin: 0,
      x_end: measuredFieldSpan(xSpan, bounds.width),
      y_origin: 0,
      y_end: measuredFieldSpan(ySpan, bounds.height),
      viewport_x_start: 0,
      viewport_x_end: 640,
      viewport_y_start: 0,
      viewport_y_end: 640,
      scale_unit: roi.scale_unit,
      source: { kind: "manual" as const, set_at: new Date().toISOString() },
    };
    dispatch(saveDimensionCalibration(values));
    dispatch(setScanGeometry(null));
    dispatch(applyPersistedDimensionCalibration(values));
    dispatch(updateROI({ imageBounds: null }));
    const equipmentId = selectedEquipmentId();
    if (equipmentId !== null) void saveDimensionCalibrationRemote(equipmentId, values);
  }

  return (
    <div className="roi-calibration-card">
      <p className="muted roi-calibration-card__hint">Use the green rectangle to frame a texture, enter its X and Y lengths, then confirm. Or drag a horizontal or vertical red line on the image to calibrate one axis.</p>
      <SourceBadge source={currentSource} />
      {lastScanImageUrl && onLoadLastScan && (
        <div className="button-row">
          <button
            type="button"
            className="btn btn--ghost"
            disabled={disabled || roi.imageKind === "lastScan"}
            onClick={() => onLoadLastScan()}
          >
            <Icon name="download" tone="accent" />
            {t("roi.loadLastScan")}
          </button>
        </div>
      )}
      <div className="field-row">
        <CalibrationField
          labelKey="roi.xEnd"
          label="X texture length"
          value={xSpan}
          disabled={disabled}
          validate={(next) => next > 0 ? null : "Enter a positive texture length."}
          onCommit={setXSpan}
        />
      </div>
      <div className="field-row">
        <CalibrationField
          labelKey="roi.yEnd"
          label="Y texture length"
          value={ySpan}
          disabled={disabled}
          validate={(next) => next > 0 ? null : "Enter a positive texture length."}
          onCommit={setYSpan}
        />
      </div>
      <div className="roi-calibration-card__meta">
        <span>{t("roi.scaleUnit")}: {unit}</span>
        <span>{t("roi.calibration.hfov", { value: formatOneDecimal(measuredFieldSpan(xSpan, bounds.width)), unit, pixels: 640 })}</span>
        <span>{t("roi.calibration.vfov", { value: formatOneDecimal(measuredFieldSpan(ySpan, bounds.height)), unit, pixels: 640 })}</span>
      </div>
      {validation && <div className="field-warning">{validation}</div>}
      <button
        className={`btn ${canConfirm ? "btn--gold" : "btn--primary"}`}
        disabled={disabled || !canConfirm}
        onClick={confirmCalibration}
      >
        {t("roi.confirmCalibration")}
      </button>
    </div>
  );
}

function CalibrationField(props: {
  labelKey: TranslationKey;
  label?: string;
  value: number;
  disabled: boolean;
  validate: (value: number) => string | null;
  onCommit: (value: number) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(formatOneDecimal(props.value));
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    setText(formatOneDecimal(props.value));
    setWarning(null);
  }, [props.value]);

  function commit(next: string) {
    setText(next);
    if (next === "") {
      setWarning(t("roi.error.pointValueRequired", { label: t(props.labelKey) }));
      return;
    }
    const parsed = Number(next);
    if (!Number.isFinite(parsed)) {
      setWarning(t("roi.error.pointValueRequired", { label: t(props.labelKey) }));
      return;
    }
    const problem = props.validate(parsed);
    if (problem) {
      setWarning(problem);
      return;
    }
    setWarning(null);
    setText(formatNumeric(parsed));
    props.onCommit(parsed);
  }

  return (
    <div className="field">
      <label>{props.label ?? t(props.labelKey)}</label>
      <NumberStepperInput
        value={text}
        step={0.1}
        disabled={props.disabled}
        invalid={Boolean(warning)}
        inputMode="decimal"
        onValueChange={commit}
      />
      {warning && <div className="field-warning">{warning}</div>}
    </div>
  );
}

function formatOneDecimal(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : "0.0";
}

function SourceBadge({ source }: { source: DimensionCalibrationSource | undefined }) {
  const { t } = useTranslation();
  if (!source) return null;
  const text =
    source.kind === "manual"
      ? t("roi.calibration.source.manual", { when: shortTimestamp(source.set_at) })
      : t("roi.calibration.source.scanGeometry", {
          type: source.equipment_type,
          revision: source.profile_revision ?? 0,
          when: shortTimestamp(source.applied_at),
        });
  return (
    <p className={`roi-calibration-card__source roi-calibration-card__source--${source.kind}`}>
      <Icon name={source.kind === "scanGeometry" ? "target" : "edit"} tone="accent" />
      {text}
    </p>
  );
}

function formatNumeric(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}
