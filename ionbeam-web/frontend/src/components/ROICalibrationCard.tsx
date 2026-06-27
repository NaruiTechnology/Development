import { useEffect, useMemo, useState } from "react";

import { useAppDispatch, useAppSelector } from "../store";
import { confirmROICalibration, updateROI } from "../store/scanSlice";
import { clearBitmapSelectionCache } from "../lib/bitmapVector";
import { viewportBounds } from "../lib/roiGeometry";
import { useTranslation, type TranslationKey } from "../i18n";

const UNITS: Record<string, string> = {
  um: "μm",
  mm: "mm",
  cm: "cm",
  nm: "nm",
};

export function ROICalibrationCard({ disabled }: { disabled: boolean }) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const roi = useAppSelector((s) => s.scan.roi);
  const bounds = viewportBounds(roi, "draft");

  const xSpan = Math.abs(roi.calibration_x_end - roi.calibration_x_origin);
  const ySpan = Math.abs(roi.calibration_y_end - roi.calibration_y_origin);
  const unit = UNITS[roi.scale_unit] ?? roi.scale_unit;

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

  function confirmCalibration() {
    if (disabled || validation) return;
    clearBitmapSelectionCache();
    dispatch(confirmROICalibration());
    dispatch(updateROI({ calibration_enabled: false }));
  }

  return (
    <div className="roi-calibration-card">
      <p className="muted roi-calibration-card__hint">{t("roi.calibration.instructions")}</p>
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
      <button className="btn btn--primary" disabled={disabled || Boolean(validation)} onClick={confirmCalibration}>
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
      <input
        className={`input${warning ? " input--invalid" : ""}`}
        type="number"
        step="any"
        value={text}
        disabled={props.disabled}
        aria-invalid={warning ? "true" : "false"}
        onChange={(event) => commit(event.target.value)}
      />
      {warning && <div className="field-warning">{warning}</div>}
    </div>
  );
}

function formatOneDecimal(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : "0.0";
}

function hasAtMostOneDecimal(text: string): boolean {
  return /^-?\d+(?:\.\d)?$/.test(text.trim());
}

function formatNumeric(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}
