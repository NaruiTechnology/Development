import { useEffect, useRef } from "react";

import { useAppDispatch, useAppSelector } from "../store";
import { updateVector } from "../store/scanSlice";
import { useTranslation } from "../i18n";
import { LatencyHelp } from "./LatencyHelp";
import { CookieHelp } from "./CookieHelp";
import { OutputModeHelp } from "./OutputModeHelp";
import { VectorResolutionHelp } from "./VectorResolutionHelp";
import { PreProcessHelp } from "./PreProcessHelp";
import { PresetNumberField, type PresetNumberOption } from "./PresetNumberField";
import { NumberStepperInput } from "./NumberStepperField";
import { DwellHelp } from "./DwellHelp";

const FORCED_RESOLUTION = 128;
const FORCED_DWELL = 16;
const FORCED_LATENCY_BYTES = 8196;
const FORCED_OUTPUT_MODE: "SixteenBit" = "SixteenBit";
const FORCED_COOKIE = 123;
const FORCED_PRE_PROCESS = true;

const FORCED_DWELL_OPTIONS: PresetNumberOption[] = [16, 32, 64].map((value) => ({ value }));
const FORCED_RESOLUTION_OPTIONS: PresetNumberOption[] = [128, 256, 512, 1024, 2048].map((value) => ({
  value,
}));

type VectorSnapshot = {
  vector_resolution: number;
  dwell: number;
  latency_bytes: number;
  output_mode: "SixteenBit" | "EightBit";
  cookie: number;
  pre_process: boolean;
};

export function ROIGrayActionVectorWedges({ active, disabled }: { active: boolean; disabled: boolean }) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const vector = useAppSelector((s) => s.scan.vector);
  const snapshotRef = useRef<VectorSnapshot | null>(null);

  useEffect(() => {
    if (!active) return;

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
        vector_resolution: FORCED_RESOLUTION,
        dwell: FORCED_DWELL,
        latency_bytes: FORCED_LATENCY_BYTES,
        output_mode: FORCED_OUTPUT_MODE,
        cookie: FORCED_COOKIE,
        pre_process: FORCED_PRE_PROCESS,
      })
    );

    return () => {
      const snapshot = snapshotRef.current;
      snapshotRef.current = null;
      if (!snapshot) return;
      dispatch(updateVector(snapshot));
    };
  }, [active, dispatch]);

  if (!active) return null;

  return (
    <div className="roi-action-vector-wedges">
      <div className="card__title" style={{ marginBottom: 6 }}>
        {t("tabs.roi")} {t("tabs.vector")}
      </div>

      <div className="field-row">
        <PresetNumberField
          label={
            <label>
              {t("vector.resolution")}
              <VectorResolutionHelp />
            </label>
          }
          value={vector.vector_resolution}
          options={FORCED_RESOLUTION_OPTIONS}
          min={128}
          max={2048}
          disabled={disabled}
          onChange={() => {
            /* locked while ROI gray action is active */
          }}
        />
        <PresetNumberField
          label={
            <label>
              {t("vector.dwell")}
              <DwellHelp />
            </label>
          }
          value={vector.dwell}
          options={FORCED_DWELL_OPTIONS}
          min={16}
          max={65535}
          disabled={disabled}
          onChange={() => {
            /* locked while ROI gray action is active */
          }}
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label>
            {t("vector.latencyBytes")}
            <LatencyHelp />
          </label>
          <NumberStepperInput value={vector.latency_bytes} min={2} step={1} inputMode="numeric" disabled={disabled} onValueChange={() => undefined} />
        </div>
        <div className="field">
          <label>
            {t("vector.outputMode")}
            <OutputModeHelp />
          </label>
          <select className="select" value={vector.output_mode} disabled={disabled} onChange={() => undefined}>
            <option value="SixteenBit">SixteenBit</option>
            <option value="EightBit">EightBit</option>
          </select>
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label>
            {t("vector.cookie")}
            <CookieHelp />
          </label>
          <NumberStepperInput value={vector.cookie} min={0} max={0xffff} step={1} inputMode="numeric" disabled={disabled} onValueChange={() => undefined} />
        </div>
        <label
          className="checkbox checkbox--disabled"
          aria-disabled="true"
          style={{ alignSelf: "end" }}
        >
          <input type="checkbox" checked={FORCED_PRE_PROCESS} disabled onChange={() => undefined} />
          {t("vector.preProcess")}
          <PreProcessHelp />
        </label>
      </div>
    </div>
  );
}
