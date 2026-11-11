import { useTranslation } from "../i18n";
import type { ImagePanelLayout } from "../lib/imagePanelLayout";
import { Icon } from "./Icon";

export function ImagePanelLayoutControls({ layout, locked, onLockedChange, onSplit, showLock = layout > 1,
  controlsId = "image-panel-grid", busy = false, splitDisabled = false }: {
  layout: ImagePanelLayout; locked: boolean; onLockedChange: (locked: boolean) => void;
  onSplit: () => void; showLock?: boolean; controlsId?: string; busy?: boolean; splitDisabled?: boolean;
}) {
  const { t } = useTranslation();
  return <>
    {showLock && <label className="checkbox vacuum-switch app-switch image-panel-card__layout-lock">
      <input type="checkbox" checked={locked} onChange={(event) => onLockedChange(event.target.checked)} />
      <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
      {t("canvas.layout.lock")}
    </label>}
    <button type="button" className="btn btn--primary image-panel-card__layout-button"
      aria-label={t("canvas.layout.cycle", { count: layout })} aria-pressed={layout > 1}
      aria-controls={controlsId} disabled={splitDisabled || layout !== 1 || busy}
      title={t("canvas.layout.cycle", { count: layout })} onClick={onSplit}>
      <Icon name="quad" tone="accent" /><span>{t("canvas.layout.splitScreen")}</span>
    </button>
  </>;
}
