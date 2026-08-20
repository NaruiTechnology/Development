import { useAppDispatch, useAppSelector } from "../store";
import { updateBeamEnergyEv } from "../store/scanSlice";
import { useTranslation } from "../i18n";
import { NumberStepperInput } from "./NumberStepperField";

export function BeamEnergyField({ disabled }: { disabled: boolean }) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const beamEnergyEv = useAppSelector((s) => s.scan.beamEnergyEv);

  return (
    <div className="field">
      <label>{t("settings.general.ev")}</label>
      <NumberStepperInput
        value={beamEnergyEv}
        min={0}
        step={1}
        disabled={disabled}
        inputMode="decimal"
        onValueChange={(next) => dispatch(updateBeamEnergyEv(parseNumber(next, beamEnergyEv)))}
      />
    </div>
  );
}

function parseNumber(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
