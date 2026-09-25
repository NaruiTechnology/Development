import { useEffect, useMemo, useState } from "react";

import { useAppDispatch, useAppSelector } from "../store";
import { confirmROICalibration, updateROI } from "../store/scanSlice";
import { saveDimensionCalibration } from "../store/dimensionCalibrationSlice";
import { shortTimestamp, type DimensionCalibrationSource } from "../lib/dimensionCalibrationPersistence";
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

  const xSpan = Math.abs(roi.calibration_x_end - roi.calibration_x_origin);
  const ySpan = Math.abs(roi.calibration_y_end - roi.calibration_y_origin);
  const unit = UNITS[roi.scale_unit] ?? roi.scale_unit;
  const calibrationDirty =
    roi.calibration_x_origin !== roi.x_origin ||
    roi.calibration_x_end !== roi.x_end ||
    roi.calibration_y_origin !== roi.y_origin ||
    roi.calibration_y_end !== roi.y_end;

  const validation = useMemo(() => {
    if (roi.calibration_x_end <= roi.calibration_x_origin) {
      return t("roi.error.xEndAfterOrigin", { origin: formatOneDecimal(roi.calibration_x_origin) });
    }
    if (roi.calibration_y_end <= roi.calibration_y_origin) {
      return t("roi.error.yEndAfterOrigin", { origin: formatOneDecimal(roi.calibration_y_origin) });
    }
    return null;
  }, [
    roi.calibration_x_end,
    roi.calibration_x_origin,
    roi.calibration_y_end,
    roi.calibration_y_origin,
    t,
  ]);
  const canConfirm = calibrationDirty && !validation;

  function confirmCalibration() {
    if (disabled || validation) return;
    if (
      currentSource?.kind === "scanGeometry" &&
      !window.confirm(
        t("roi.calibration.overwriteScanGeometry", {
          type: currentSource.equipment_type,
          revision: currentSource.profile_revision ?? 0,
        })
      )
    ) {
      return;
    }
    clearBitmapSelectionCache();
    dispatch(saveDimensionCalibration({
      x_origin: roi.calibration_x_origin,
      x_end: roi.calibration_x_end,
      y_origin: roi.calibration_y_origin,
      y_end: roi.calibration_y_end,
      viewport_x_start: roi.calibration_viewport_x_start,
      viewport_x_end: roi.calibration_viewport_x_end,
      viewport_y_start: roi.calibration_viewport_y_start,
      viewport_y_end: roi.calibration_viewport_y_end,
      scale_unit: roi.scale_unit,
      source: { kind: "manual", set_at: new Date().toISOString() },
    }));
    dispatch(confirmROICalibration());
  }

  return (
    <div className="roi-calibration-card">
      <p className="muted roi-calibration-card__hint">{t("roi.calibration.instructions")}</p>
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
          labelKey="roi.xOrigin"
          value={roi.calibration_x_origin}
          disabled={disabled}
          validate={(next) =>
            next < roi.calibration_x_end
              ? null
              : t("roi.error.xOriginBeforeEnd", { end: formatOneDecimal(roi.calibration_x_end) })
          }
          onCommit={(next) => dispatch(updateROI({ calibration_x_origin: next }))}
        />
        <CalibrationField
          labelKey="roi.xEnd"
          value={roi.calibration_x_end}
          disabled={disabled}
          validate={(next) =>
            next > roi.calibration_x_origin
              ? null
              : t("roi.error.xEndAfterOrigin", { origin: formatOneDecimal(roi.calibration_x_origin) })
          }
          onCommit={(next) => dispatch(updateROI({ calibration_x_end: next }))}
        />
      </div>
      <div className="field-row">
        <CalibrationField
          labelKey="roi.yOrigin"
          value={roi.calibration_y_origin}
          disabled={disabled}
          validate={(next) =>
            next < roi.calibration_y_end
              ? null
              : t("roi.error.yOriginBeforeEnd", { end: formatOneDecimal(roi.calibration_y_end) })
          }
          onCommit={(next) => dispatch(updateROI({ calibration_y_origin: next }))}
        />
        <CalibrationField
          labelKey="roi.yEnd"
          value={roi.calibration_y_end}
          disabled={disabled}
          validate={(next) =>
            next > roi.calibration_y_origin
              ? null
              : t("roi.error.yEndAfterOrigin", { origin: formatOneDecimal(roi.calibration_y_origin) })
          }
          onCommit={(next) => dispatch(updateROI({ calibration_y_end: next }))}
        />
      </div>
      <div className="roi-calibration-card__meta">
        <span>{t("roi.scaleUnit")}: {unit}</span>
        <span>{t("roi.calibration.hfov", { value: formatOneDecimal(xSpan), unit, pixels: bounds.width })}</span>
        <span>{t("roi.calibration.vfov", { value: formatOneDecimal(ySpan), unit, pixels: bounds.height })}</span>
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
      <label>{t(props.labelKey)}</label>
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

function hasAtMostOneDecimal(text: string): boolean {
  return /^-?\d+(?:\.\d)?$/.test(text.trim());
}

function formatNumeric(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}
