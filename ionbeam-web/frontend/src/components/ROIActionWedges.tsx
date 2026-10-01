import { useEffect, useRef } from "react";

import { useAppDispatch, useAppSelector } from "../store";
import { updateRaster, updateVector } from "../store/scanSlice";
import { useTranslation } from "../i18n";
import { DwellHelp } from "./DwellHelp";
import { LatencyHelp } from "./LatencyHelp";
import { CookieHelp } from "./CookieHelp";
import { OutputModeHelp } from "./OutputModeHelp";
import { VectorResolutionHelp } from "./VectorResolutionHelp";
import { PreProcessHelp } from "./PreProcessHelp";
import { PresetNumberField, type PresetNumberOption } from "./PresetNumberField";
import { NumberStepperInput } from "./NumberStepperField";
import { ResolutionHelp } from "./ResolutionHelp";

const RASTER_RESOLUTIONS: PresetNumberOption[] = [128, 256, 512, 1024, 2048].map((value) => ({ value }));
const RASTER_DWELLS: PresetNumberOption[] = [0, 1, 3, 7, 15, 31, 63].map((value) => ({ value }));
const VECTOR_RESOLUTIONS: PresetNumberOption[] = [128, 256, 512, 1024, 2048].map((value) => ({ value }));
const VECTOR_DWELLS: PresetNumberOption[] = [1, 2, 4, 8, 16, 32, 64].map((value) => ({ value }));

const VECTOR_SETTINGS = {
  vector_resolution: 128,
  latency_bytes: 8196,
  output_mode: "SixteenBit" as const,
  cookie: 123,
  pre_process: true,
};

type VectorSnapshot = {
  vector_resolution: number;
  dwell: number;
  latency_bytes: number;
  output_mode: "SixteenBit" | "EightBit";
  cookie: number;
  pre_process: boolean;
};

export function ROIActionWedges({
  mode,
  active = true,
  disabled,
}: {
  mode: "raster" | "vector";
  active?: boolean;
  disabled: boolean;
}) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const raster = useAppSelector((s) => s.scan.raster);
  const vector = useAppSelector((s) => s.scan.vector);
  const snapshotRef = useRef<VectorSnapshot | null>(null);

  useEffect(() => {
    if (mode !== "vector" || !active) return;

    snapshotRef.current = {
      vector_resolution: vector.vector_resolution,
      dwell: vector.dwell,
      latency_bytes: vector.latency_bytes,
      output_mode: vector.output_mode,
      cookie: vector.cookie,
      pre_process: vector.pre_process,
    };

    dispatch(
      updateVector({
        ...VECTOR_SETTINGS,
        dwell: Math.max(2, vector.dwell),
      })
    );

    return () => {
      const snapshot = snapshotRef.current;
      snapshotRef.current = null;
      if (snapshot) dispatch(updateVector(snapshot));
    };
  }, [active, dispatch, mode]);

  if (mode === "vector" && !active) return null;

  return (
    <div className="roi-action-vector-wedges">
      <div className="card__title" style={{ marginBottom: 6 }}>
        {t("tabs.roi")} {t(mode === "vector" ? "tabs.vector" : "tabs.raster")}
      </div>

      {mode === "raster" ? (
        <div className="field-row">
          <PresetNumberField
            label={<label>{t("raster.resolution")}<ResolutionHelp /></label>}
            value={raster.resolution}
            options={RASTER_RESOLUTIONS}
            min={1}
            max={2048}
            disabled={disabled}
            onChange={(value) => dispatch(updateRaster({ resolution: value }))}
          />
          <PresetNumberField
            label={<label>{t("raster.dwell")}<DwellHelp /></label>}
            value={raster.dwell}
            options={RASTER_DWELLS}
            min={0}
            max={65535}
            disabled={disabled}
            onChange={(value) => dispatch(updateRaster({ dwell: value }))}
          />
        </div>
      ) : (
        <>
          <div className="field-row">
            <PresetNumberField
              label={<label>{t("vector.resolution")}<VectorResolutionHelp /></label>}
              value={vector.vector_resolution}
              options={VECTOR_RESOLUTIONS}
              min={128}
              max={2048}
              disabled={disabled}
              onChange={(value) => dispatch(updateVector({ vector_resolution: value }))}
            />
            <PresetNumberField
              label={<label>{t("vector.dwell")}<DwellHelp /></label>}
              value={vector.dwell}
              options={VECTOR_DWELLS}
              min={1}
              max={65535}
              disabled={disabled}
              normalizeValue={(value) => Math.max(2, value)}
              onChange={(value) => dispatch(updateVector({ dwell: value }))}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label>{t("vector.latencyBytes")}<LatencyHelp /></label>
              <NumberStepperInput value={vector.latency_bytes} min={VECTOR_SETTINGS.latency_bytes} step={1} inputMode="numeric" disabled onValueChange={() => undefined} />
            </div>
            <div className="field">
              <label>{t("vector.outputMode")}<OutputModeHelp /></label>
              <select className="select" value={vector.output_mode} disabled onChange={() => undefined}>
                <option value="SixteenBit">SixteenBit</option>
                <option value="EightBit">EightBit</option>
              </select>
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>{t("vector.cookie")}<CookieHelp /></label>
              <NumberStepperInput value={vector.cookie} min={0} max={0xffff} step={1} inputMode="numeric" disabled onValueChange={() => undefined} />
            </div>
            <label className="checkbox checkbox--disabled vacuum-switch app-switch" aria-disabled="true" style={{ alignSelf: "end" }}>
              <input type="checkbox" checked={VECTOR_SETTINGS.pre_process} disabled onChange={() => undefined} />
              <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
              {t("vector.preProcess")}
              <PreProcessHelp />
            </label>
          </div>
        </>
      )}
    </div>
  );
}
