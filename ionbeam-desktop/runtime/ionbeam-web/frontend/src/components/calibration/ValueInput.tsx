/**
 * One editable parameter value. Renders the widget the definition asks for (number / enum select / boolean / text)
 * and reports either a parsed value or a parse problem. The typed text is kept locally so "1." or "-" can be typed
 * on the way to a number; it is reset whenever the value that is committed from outside no longer matches it.
 */
import { useEffect, useState } from "react";

import { useTranslation, type TranslationKey } from "../../i18n";
import { formatValue, parseInput, type ParseResult } from "../../lib/calibrationModel";
import type { CalibrationEnumOption, CalibrationValueType } from "../../types/calibration";

export interface ValueInputProps {
  valueType: CalibrationValueType;
  enumOptions: CalibrationEnumOption[];
  /** the value currently in effect (edit if any, else stored), or undefined when nothing is set */
  value: unknown;
  /** shown greyed when nothing is set (the vendor factory value) */
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  compact?: boolean;
  ariaLabel: string;
  title?: string;
  /** bump to throw away typed text and show the committed value again (revert / discard) */
  resetKey?: number;
  onChange: (parsed: ParseResult) => void;
}

const PARSE_MESSAGE: Record<Extract<ParseResult, { ok: false }>["message"], TranslationKey> = {
  required: "calibration.parse.required",
  number: "calibration.parse.number",
  integer: "calibration.parse.integer",
  boolean: "calibration.parse.boolean",
  enum: "calibration.parse.enum",
};

export function parseMessageKey(message: Extract<ParseResult, { ok: false }>["message"]): TranslationKey {
  return PARSE_MESSAGE[message];
}

export function ValueInput(props: ValueInputProps) {
  const { t } = useTranslation();
  const { valueType, enumOptions, value, disabled, invalid, compact, ariaLabel, title, onChange, resetKey } = props;
  const external = formatValue(value);
  const [text, setText] = useState(external);
  const className = `input calib-input${compact ? " calib-input--compact" : ""}${invalid ? " input--invalid" : ""}`;

  useEffect(() => {
    setText(external);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  useEffect(() => {
    const parsed = parseInput({ value_type: valueType, enum_options: enumOptions }, text);
    if (!parsed.ok || formatValue(parsed.value) !== external) setText(external);
    // only when the committed value changes from outside; `text` is deliberately not a dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [external]);

  if (valueType === "enum") {
    const known = typeof value === "number" && enumOptions.some((o) => o.value === value);
    return (
      <select
        className={`select calib-input${invalid ? " input--invalid" : ""}`}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        value={external}
        onChange={(e) => onChange(parseInput({ value_type: "enum", enum_options: enumOptions }, e.target.value))}
      >
        <option value="" disabled>
          {t("calibration.value.notSet")}
        </option>
        {enumOptions.map((o) => (
          <option key={o.value} value={String(o.value)}>
            {o.value} — {o.label}
          </option>
        ))}
        {typeof value === "number" && !known && (
          <option value={String(value)} disabled>
            {value} — {t("calibration.value.undocumentedOption")}
          </option>
        )}
      </select>
    );
  }

  if (valueType === "boolean") {
    return (
      <select
        className={`select calib-input${invalid ? " input--invalid" : ""}`}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        value={external}
        onChange={(e) => onChange(parseInput({ value_type: "boolean" }, e.target.value))}
      >
        <option value="" disabled>
          {t("calibration.value.notSet")}
        </option>
        <option value="true">{t("calibration.value.on")}</option>
        <option value="false">{t("calibration.value.off")}</option>
      </select>
    );
  }

  return (
    <input
      className={className}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      inputMode={valueType === "text" ? "text" : "decimal"}
      spellCheck={false}
      autoComplete="off"
      placeholder={props.placeholder}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseInput({ value_type: valueType, enum_options: enumOptions }, e.target.value));
      }}
    />
  );
}
