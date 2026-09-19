/**
 * Raster scan parameter form. Fields map 1:1 to RasterRequest in
 * glasgow_service.models.
 *
 * Bounds match the Pydantic field validators:
 *   resolution    1..2048
 *   dwell         1..65535
 *   latency_bytes >= 2
 *
 * Every parameter has an inline "?" help button next to its label,
 * opening a modal with a technical explanation. Help components live
 * in their own files (one per parameter), now thin shells over the
 * per-locale body registry.
 */
import { type ReactNode } from "react";

import { updateRaster, updateROI } from "../store/scanSlice";
import { useAppDispatch, useAppSelector } from "../store";
import { useTranslation } from "../i18n";
import { DwellHelp } from "./DwellHelp";
import { ResolutionHelp } from "./ResolutionHelp";
import { LatencyHelp } from "./LatencyHelp";
import { CookieHelp } from "./CookieHelp";
import { OutputModeHelp } from "./OutputModeHelp";
import { FrameBlankHelp } from "./FrameBlankHelp";
import { ValidationHelp } from "./ValidationHelp";
import { AdcValidHelp } from "./AdcValidHelp";
import { ScanModeHelp } from "./ScanModeHelp";
import { BeamEnergyField } from "./BeamEnergyField";
import { PresetNumberField, type PresetNumberOption } from "./PresetNumberField";
import { NumberStepperInput } from "./NumberStepperField";
import { estimateRevC3ScanTiming, formatDuration, formatNanoseconds, revC3DwellPresetOptions } from "../lib/scanTiming";

const RES_PRESETS: PresetNumberOption[] = [128, 256, 512, 1024, 2048].map((value) => ({ value }));
const LATENCY_PRESETS = [4096, 8192, 16384, 32768];

export function RasterParameters({ disabled }: { disabled: boolean }) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const r = useAppSelector((s) => s.scan.raster);
  const roi = useAppSelector((s) => s.scan.roi);
  const halfPeriod = useAppSelector((s) => Number(s.status.defaults?.adc?.adcHalfPeriod ?? 3));
  const timing = estimateRevC3ScanTiming(r.resolution, r.dwell, halfPeriod);
  const dwellPresets = revC3DwellPresetOptions(undefined, halfPeriod);

  // The footnote in the original code interpolates two <b> spans into a
  // sentence. Localised text reorders those spans (e.g. zh-CN puts
  // the action before the modifier), so we render the footnote as
  // a single key and post-process the `<Download CSV>` / `<Download
  // figure>` / `<Run validated>` brackets into <b>…</b> at render
  // time. This keeps the translator's job sentence-level rather than
  // span-level. The angle-bracket markers are deliberately chosen to
  // be unmistakable in a flat-string editor (vs HTML, which a
  // translator might accidentally edit).
  const footnoteParts = renderBracketedBold(t("raster.footnote"));

  return (
    <div>
      <BeamEnergyField disabled={disabled} />

      <div className="field-row">
        <label>
          {t("scan.modeGuide")}
          <ScanModeHelp />
        </label>
      </div>

      <div className="field-row">
        <PresetNumberField
          label={
            <label>
              {t("raster.resolution")}
              <ResolutionHelp />
            </label>
          }
          value={r.resolution}
          options={RES_PRESETS}
          min={1}
          max={2048}
          disabled={disabled}
          onChange={(v) => dispatch(updateRaster({ resolution: v }))}
        />
        <PresetNumberField
          label={
            <label>
              {t("scan.dwell.dynamic", {
                dwell: r.dwell,
                period: formatNanoseconds(timing.samplePeriodNs),
                samples: timing.samplesPerPixel,
                pixel: formatNanoseconds(timing.pixelDwellNs),
                resolution: r.resolution,
                frame: formatDuration(timing.frameSeconds),
              })}
              <DwellHelp />
            </label>
          }
          value={r.dwell}
          options={dwellPresets}
          min={1}
          max={65535}
          disabled={disabled}
          onChange={(v) => dispatch(updateRaster({ dwell: v }))}
        />
      </div>

      <div className="field-row">
        <PresetNumberField
          label={
            <label>
              {t("raster.latencyBytes")}
              <LatencyHelp />
            </label>
          }
          value={r.latency_bytes}
          options={LATENCY_PRESETS.map((value) => ({ value }))}
          min={2}
          max={1 << 20}
          disabled={disabled}
          onChange={(v) => dispatch(updateRaster({ latency_bytes: v }))}
        />
        <div className="field">
          <label>
            {t("raster.cookie")}
            <CookieHelp />
          </label>
          <NumberStepperInput
            value={r.cookie}
            disabled={disabled}
            onValueChange={(next) =>
              dispatch(updateRaster({ cookie: clamp(next, 0, 0xffff, 123) }))
            }
            min={0}
            max={0xffff}
            step={1}
            inputMode="numeric"
          />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
        <label>
          {t("raster.outputMode")}
          <OutputModeHelp />
        </label>
        <select
          className="select"
          value={r.output_mode ?? "SixteenBit"}
          disabled={disabled}
          onChange={(e) =>
            dispatch(
              updateRaster({
                output_mode: e.target.value as "SixteenBit" | "EightBit",
              })
            )
          }
        >
          {/* Output mode values are FPGA-side enums, not user-facing
              prose; they stay in English in every locale. */}
          <option value="SixteenBit">SixteenBit</option>
          <option value="EightBit">EightBit</option>
        </select>
      </div>
      <label className="checkbox vacuum-switch app-switch">
        <input type="checkbox" checked={r.adc_valid} disabled={disabled}
          onChange={(e) => dispatch(updateRaster({ adc_valid: e.target.checked }))} />
        <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
        {t("raster.adcValid")} <AdcValidHelp />
      </label>
      </div>

      <label className="checkbox vacuum-switch app-switch">
        <input
          type="checkbox"
          checked={r.frame_blank}
          disabled={disabled}
          onChange={(e) => dispatch(updateRaster({ frame_blank: e.target.checked }))}
        />
        <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
        {t("raster.frameBlank")}
        <FrameBlankHelp />
      </label>

      <div className="divider" />

      <div className="card__title" style={{ marginBottom: 6 }}>
        {t("card.validatedRunOptions")}
      </div>

      <label className="checkbox vacuum-switch app-switch">
        <input
          type="checkbox"
          checked={r.do_validate}
          disabled={disabled}
          onChange={(e) => dispatch(updateRaster({ do_validate: e.target.checked }))}
        />
        <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
        {t("raster.doValidate")}
        <ValidationHelp />
      </label>


      <p className="muted" style={{ fontSize: 11, marginTop: 6, marginBottom: 0 }}>
        {footnoteParts}
      </p>
    </div>
  );
}

function clamp(s: string, lo: number, hi: number, fallback: number): number {
  const n = Number(s);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

/** Convert "...the <Run validated> button..." into a fragment with
 *  bracketed segments wrapped in <b>. Localisation-safe; both the
 *  English and Chinese tables use the same `<…>` delimiters. */
function renderBracketedBold(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /<([^<>]+)>/g;
  let last = 0;
  let i = 0;
  for (const m of s.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > last) out.push(s.slice(last, start));
    out.push(<b key={i++}>{m[1]}</b>);
    last = start + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
