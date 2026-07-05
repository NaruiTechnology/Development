import { useEffect, useMemo, useState, type ReactNode } from "react";

interface NumberStepperFieldProps {
  label: ReactNode;
  value: string | number;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  step?: number;
  min?: number;
  max?: number;
  inputMode?: "decimal" | "numeric";
  invalid?: boolean;
  warning?: ReactNode;
  title?: string;
  ariaLabel?: string;
}

export function NumberStepperField({
  label,
  value,
  onValueChange,
  disabled = false,
  step = 1,
  min,
  max,
  inputMode = "decimal",
  invalid = false,
  warning,
  title,
  ariaLabel,
}: NumberStepperFieldProps) {
  return (
    <div className="field">
      <label>{label}</label>
      <NumberStepperInput
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        step={step}
        min={min}
        max={max}
        inputMode={inputMode}
        invalid={invalid}
        warning={warning}
        title={title}
        ariaLabel={ariaLabel}
      />
    </div>
  );
}

export function NumberStepperInput({
  value,
  onValueChange,
  disabled = false,
  step = 1,
  min,
  max,
  inputMode = "decimal",
  invalid = false,
  warning,
  title,
  ariaLabel,
}: Omit<NumberStepperFieldProps, "label">) {
  const [local, setLocal] = useState(String(value));

  useEffect(() => {
    setLocal(String(value));
  }, [value]);

  const stepSize = useMemo(() => sanitizeStep(step), [step]);

  function commit(next: string) {
    setLocal(next);
    onValueChange(next);
  }

  function nudge(direction: 1 | -1) {
    if (disabled) return;
    const parsed = Number(local);
    const base = Number.isFinite(parsed) ? parsed : min ?? max ?? 0;
    let next = base + direction * stepSize;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    commit(formatNumeric(next, stepSize));
  }

  return (
    <div className="number-stepper" title={title}>
      <input
        className={`input number-stepper__input${invalid ? " input--invalid" : ""}`}
        type="text"
        inputMode={inputMode}
        value={local}
        disabled={disabled}
        aria-invalid={invalid ? "true" : "false"}
        aria-label={ariaLabel}
        onChange={(event) => commit(event.target.value)}
      />
      <div className="number-stepper__buttons">
        <button
          type="button"
          className="number-stepper__button number-stepper__button--up"
          onClick={() => nudge(1)}
          disabled={disabled}
          aria-label="Increase value"
        >
          ▲
        </button>
        <button
          type="button"
          className="number-stepper__button number-stepper__button--down"
          onClick={() => nudge(-1)}
          disabled={disabled}
          aria-label="Decrease value"
        >
          ▼
        </button>
      </div>
      {warning ? <div className="field-warning number-stepper__warning">{warning}</div> : null}
    </div>
  );
}

function sanitizeStep(step: number): number {
  return Number.isFinite(step) && step > 0 ? step : 1;
}

function formatNumeric(value: number, step: number): string {
  if (!Number.isFinite(value)) return "0";
  const decimals = decimalsForStep(step);
  return decimals > 0 ? value.toFixed(decimals) : String(Math.trunc(value));
}

function decimalsForStep(step: number): number {
  const text = String(step);
  const point = text.indexOf(".");
  if (point === -1) return 0;
  return text.length - point - 1;
}
