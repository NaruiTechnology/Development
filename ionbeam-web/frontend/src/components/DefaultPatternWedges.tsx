import type { PatternInstance } from "../store/processingSlice";
import type { PatternSpec } from "../lib/processingPatterns";
import { PatternIcon } from "./PatternIcon";
import { useTranslation, type TranslationKey } from "../i18n";

/** Built-in pattern palette shared by the Default tab and successful custom matches. */
export function DefaultPatternWedges({ specs, instances, activeKey, disabled, imageAvailable, onSelect }: {
  specs: PatternSpec[];
  instances: Record<string, PatternInstance>;
  activeKey: string | null;
  disabled: boolean;
  imageAvailable: boolean;
  onSelect: (key: string | null) => void;
}) {
  const { t } = useTranslation();
  return <div className="pattern-strip" role="toolbar" aria-label={t("processing.patterns")}>
    {specs.filter(spec => (instances[spec.key]?.typeKey ?? spec.key) === spec.key).map(spec => {
      const translated = t(`processing.pattern.${spec.key}` as TranslationKey);
      const caption = translated.startsWith("processing.pattern.") ? spec.caption : translated;
      const selected = Boolean(activeKey && instances[activeKey]?.typeKey === spec.key);
      return <button key={spec.key} type="button" className="pattern-strip__btn"
        disabled={disabled || !imageAvailable} aria-pressed={selected}
        aria-controls={`processing-pattern-${encodeURIComponent(activeKey && selected ? activeKey : spec.key)}`}
        data-tooltip={caption} data-styled-tooltip="true" aria-label={caption}
        onClick={() => onSelect(selected ? null : spec.key)}>
        <PatternIcon name={spec.icon} />
      </button>;
    })}
  </div>;
}
