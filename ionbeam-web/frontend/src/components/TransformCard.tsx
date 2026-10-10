import { useState } from "react";
import { useTranslation } from "../i18n";
import { useAppDispatch, useAppSelector } from "../store";
import { clearROISelection, setStreamTransforms } from "../store/scanSlice";
import { clearBitmapSelectionCache } from "../lib/bitmapVector";
import { Icon } from "./Icon";

export function TransformCard() {
  const [collapsed, setCollapsed] = useState(true);
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const transforms = useAppSelector((s) => s.scan.streamTransforms);

  return (
    <div className="card scan-transform-card">
      <div className="card__header">
        <span className="card__title">{t("scan.transform")}</span>
        <button
          type="button"
          className="card__collapse-btn"
          aria-expanded={!collapsed}
          aria-label={`${t("scan.transform")}: ${t(collapsed ? "controls.expand" : "controls.collapse")}`}
          onClick={() => setCollapsed((value) => !value)}
        >
          <Icon name="chevronDown" />
        </button>
      </div>
      <div className="card__body scan-transform-switches" hidden={collapsed}>
        {(["xflip", "yflip", "rotate90"] as const).map((name) => (
          <label key={name} className="checkbox vacuum-switch app-switch">
            <input
              type="checkbox"
              checked={transforms[name]}
              onChange={(event) => {
                dispatch(setStreamTransforms({ ...transforms, [name]: event.target.checked }));
                clearBitmapSelectionCache();
                dispatch(clearROISelection());
              }}
            />
            <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
            <span className={name === "rotate90" ? "scan-transform-label--nowrap" : undefined}>{t(`settings.general.${name}`)}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
