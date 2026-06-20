import { useAppDispatch, useAppSelector } from "../store";
import { updateBeamEnergyEv } from "../store/scanSlice";
import { useTranslation } from "../i18n";

export function BeamEnergyField({ disabled }: { disabled: boolean }) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const beamEnergyEv = useAppSelector((s) => s.scan.beamEnergyEv);

  return (
    <div className="field">
      <label>{t("settings.general.ev")}</label>
      <input
        className="input"
        type="number"
        step="any"
        min={0}
        value={beamEnergyEv}
        disabled={disabled}
        onChange={(e) => dispatch(updateBeamEnergyEv(parseNumber(e.target.value, beamEnergyEv)))}
      />
    </div>
  );
}

function parseNumber(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
