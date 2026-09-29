/**
 * CONFIGURATION > Admin > Calibration > "Go to Dimension Cal".
 *
 * Replaces the old multi-section "Scan geometry" wedge, which several people found hard to follow. This
 * stays feature-centric instead: one click computes a nominal (uncorrected — no fiducial fitting, no
 * rotation/shear) X/Y world-coordinate mapping from the equipment's calibration-profile values and its
 * magnification calibration, saves that as the operator's starting point in Dimension Cal (server-side,
 * see dimensionCalibrationApi.ts, not just this browser's localStorage), and hands off to App.tsx to close
 * this dialog and switch to CONFIGURATION > Calibrate > DIMENTION CAL so they can fine-tune or reconfirm
 * it there the normal way.
 *
 * lib/roiDac.ts falls back to a plain linear world<->DAC mapping (exactly what Dimension Cal already
 * provides) whenever no rectified scan geometry is applied, so removing the wedge's fiducial-correction
 * step doesn't break scans — it just means scans no longer get rotation/shear correction on top of the
 * linear mapping, which is the trade-off this simplification makes on purpose.
 */
import { useState } from "react";

import { useTranslation } from "../../i18n";
import { calibrationApi, CalibrationApiError } from "../../lib/calibrationApi";
import { ROLE_SUPER_USER } from "../../lib/calibrationModel";
import { saveDimensionCalibrationRemote } from "../../lib/dimensionCalibrationApi";
import {
  NO_CORRECTION,
  buildScanGeometry,
  dimensionBoundsFromGeometry,
  geometryParameterKeys,
  resolveScanGeometryInputs,
} from "../../lib/scanGeometry";
import { useAppDispatch, useAppSelector } from "../../store";
import { saveDimensionCalibration } from "../../store/dimensionCalibrationSlice";
import { fetchMagCalibration } from "../../store/magCalibrationSlice";
import { applyPersistedDimensionCalibration } from "../../store/scanSlice";
import { closeDialog, requestDimensionCalNavigation } from "../../store/settingsSlice";
import type { CalibrationEquipmentType } from "../../types/calibration";
import { Icon } from "../Icon";

export function GoToDimensionCalButton({
  equipmentId,
  type,
  role,
}: {
  equipmentId: number;
  type: CalibrationEquipmentType;
  role: number | null;
}) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const dimension = useAppSelector((s) => s.dimensionCalibration.values);
  const magnification = useAppSelector((s) => s.magCalibration.mag);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canGo = role !== null && role >= ROLE_SUPER_USER;
  const beam = type === "FIB" ? "ion" : "ebeam";

  async function go() {
    if (busy || !canGo) return;
    if (dimension.source?.kind === "manual" && !window.confirm(t("geometry.overwriteManual"))) return;
    setBusy(true);
    setError(null);
    try {
      const [bundle, magResponse] = await Promise.all([
        calibrationApi.bundle(equipmentId, type, { keys: geometryParameterKeys(type), limit: 50 }),
        dispatch(fetchMagCalibration()).unwrap(),
      ]);
      const profileValues = Object.fromEntries(bundle.values.map((v) => [v.parameter_key, v.value]));
      const magPoints = magResponse.beams?.[beam]?.m_per_fov ?? {};
      const resolved = resolveScanGeometryInputs({
        type,
        profileValues,
        magCalibration: magPoints,
        stream: {},
        overrides: { magnification },
      });
      const geometry = buildScanGeometry(resolved.inputs, NO_CORRECTION);
      const bounds = dimensionBoundsFromGeometry(geometry);
      const values = {
        ...dimension,
        ...bounds,
        source: {
          kind: "scanGeometry" as const,
          equipment_id: equipmentId,
          equipment_type: type,
          profile_revision: bundle.profile?.revision ?? null,
          applied_at: new Date().toISOString(),
        },
      };
      dispatch(saveDimensionCalibration(values));
      dispatch(applyPersistedDimensionCalibration(values));
      void saveDimensionCalibrationRemote(equipmentId, values);
      dispatch(closeDialog());
      dispatch(requestDimensionCalNavigation());
    } catch (err) {
      setError(err instanceof CalibrationApiError ? err.message : err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <span className="calib-go-to-dimension">
      <button
        type="button"
        className="btn btn--ghost"
        disabled={busy || !canGo}
        title={canGo ? t("geometry.goToDimensionCal.title") : t("calibration.lock.role", { role: ROLE_SUPER_USER })}
        onClick={() => void go()}
      >
        <Icon name="link" tone="accent" />
        {busy ? t("calibration.save.saving") : t("geometry.goToDimensionCal")}
      </button>
      {error && <span className="calib-row__error" role="alert">{error}</span>}
    </span>
  );
}
