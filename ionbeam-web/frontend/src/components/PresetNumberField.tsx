import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useTranslation } from "../i18n";
import { NumberStepperInput } from "./NumberStepperField";

const CUSTOM_VALUE = "__custom__";

export interface PresetNumberOption {
  value: number;
  label?: string;
}

export function PresetNumberField({
  label,
  value,
  options,
  min,
  max,
  disabled,
  onChange,
  helperText,
  title,
  customValidate,
}: {
  label: ReactNode;
  value: number;
  options: PresetNumberOption[];
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
  helperText?: ReactNode;
  title?: string;
  customValidate?: (value: number) => string | null;
}) {
  const { t } = useTranslation();
  const presetValues = useMemo(() => options.map((option) => option.value), [options]);
  const isCustom = !presetValues.includes(value);
  const [selected, setSelected] = useState<string>(isCustom ? CUSTOM_VALUE : String(value));
  const [customText, setCustomText] = useState<string>(String(value));
  const [customWarning, setCustomWarning] = useState<string | null>(null);

  useEffect(() => {
    setSelected(isCustom ? CUSTOM_VALUE : String(value));
    setCustomText(String(value));
    setCustomWarning(null);
  }, [isCustom, value]);

  return (
    <div className="field">
      {label}
      <select
        className="select"
        value={selected}
        title={title}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value;
          setSelected(next);
          if (next === CUSTOM_VALUE) {
            setCustomText(String(value));
            setCustomWarning(null);
            return;
          }
          onChange(clampInteger(Number(next), min, max, value));
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label ?? option.value}
          </option>
        ))}
        <option value={CUSTOM_VALUE}>{t("common.custom")}</option>
      </select>
      {selected === CUSTOM_VALUE && (
        <NumberStepperInput
          value={customText}
          min={min}
          max={max}
          step={1}
          title={title}
          disabled={disabled}
          inputMode="numeric"
          onValueChange={(next) => {
            setCustomText(next);
            if (!next.trim()) {
              setCustomWarning(null);
              return;
            }
            const parsed = Number(next);
            if (!Number.isFinite(parsed)) {
              setCustomWarning(t("common.invalidNumber"));
              return;
            }
            const normalized = clampInteger(parsed, min, max, value);
            const validationError = customValidate?.(normalized) ?? null;
            if (validationError) {
              setCustomWarning(validationError);
              return;
            }
            setCustomWarning(null);
            onChange(normalized);
          }}
          warning={customWarning}
        />
      )}
      {helperText ? <small className="muted">{helperText}</small> : null}
    </div>
  );
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
