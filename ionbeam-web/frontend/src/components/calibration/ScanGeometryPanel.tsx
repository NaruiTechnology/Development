/**
 * CONFIGURATION > Admin > Calibration > Scan geometry.
 *
 * Uses the calibration-profile values of the selected machine / column (scan pixels, rotation offset, Y/X aspect,
 * beam tilt, spot park, ...) plus the measured magnification calibration to compute the scan frame: pixels, DAC step,
 * pixel size, scale factor (µm per DAC code), FOV and its corners in world coordinates. Fiducials (image pixel ->
 * known world position) rectify the frame by least squares; "Apply to scans" stores the result in streamData.json and
 * switches the ROI / bitmap scan paths to the rectified world -> DAC mapping.
 */
import { useEffect, useMemo, useState } from "react";

import { useTranslation, type TranslationKey } from "../../i18n";
import { clearBitmapSelectionCache } from "../../lib/bitmapVector";
import { calibrationApi } from "../../lib/calibrationApi";
import { ROLE_SUPER_USER } from "../../lib/calibrationModel";
import {
  NO_CORRECTION,
  SCAN_GEOMETRY_KEYS,
  SCAN_GEOMETRY_VERSION,
  buildScanGeometry,
  dimensionBoundsFromGeometry,
  fitFiducials,
  foldScaleIntoHfov,
  geometryParameterKeys,
  resolveScanGeometryInputs,
  scanGeometryResults,
  toAppliedGeometry,
  type Fiducial,
  type FitModel,
  type FitResult,
  type GeometryCorrection,
  type GeometryRole,
  type InputSource,
  type ScanGeometry,
  type ScanGeometryConfig,
  type Vec2,
} from "../../lib/scanGeometry";
import { fetchScanGeometry, saveScanGeometry, type ScanGeometryState } from "../../lib/scanGeometryApi";
import { useAppDispatch, useAppSelector } from "../../store";
import { saveDimensionCalibration } from "../../store/dimensionCalibrationSlice";
import { shortTimestamp, type DimensionCalibrationValues } from "../../lib/dimensionCalibrationPersistence";
import { fetchMagCalibration, saveMagCalibration } from "../../store/magCalibrationSlice";
import { applyPersistedDimensionCalibration, setScanGeometry } from "../../store/scanSlice";
import type { CalibrationEquipmentType } from "../../types/calibration";
import { Icon } from "../Icon";
import { LoadingSpinner } from "../LoadingSpinner";
import { ScanGeometryHelp } from "./ScanGeometryHelp";
import { GeometryFitHelp } from "./GeometryFitHelp";
import { GoToDimensionCalButton } from "./GoToDimensionCalButton";

interface Props {
  equipmentId: number;
  type: CalibrationEquipmentType;
  role: number | null;
  profileRevision: number | null;
  /** jump to one parameter in the list view (to edit it there) */
  onEditParameter: (parameterKey: string) => void;
  onClose: () => void;
}

const ROLE_ORDER: GeometryRole[] = ["pixelsX", "pixelsY", "scanWidth", "scanLines", "rotationOffsetDeg", "yxAspect", "photoImageHeightMm", "beamTiltDeg", "spotParkX", "spotParkY", "vendorDwell"];

const g4 = (v: number) => (Number.isFinite(v) ? Number(v.toPrecision(6)).toString() : "—");
const numOr = (text: string, fallback: number) => (text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : fallback);
const optNum = (text: string) => (text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : null);
let fidSeq = 0;
const newFiducial = (): Fiducial => ({ id: `f${++fidSeq}`, space: "pixel", u: NaN, v: NaN, worldX: NaN, worldY: NaN, enabled: true });

export function ScanGeometryPanel({ equipmentId, type, role, profileRevision, onEditParameter, onClose }: Props) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const beam = type === "FIB" ? "ion" : "ebeam";
  const magState = useAppSelector((s) => s.magCalibration);
  const dimension = useAppSelector((s) => s.dimensionCalibration.values);
  const magPoints = magState.beams[beam]?.m_per_fov ?? {};
  const canApply = role !== null && role >= ROLE_SUPER_USER;

  const [profileValues, setProfileValues] = useState<Record<string, unknown>>({});
  const [stored, setStored] = useState<ScanGeometryState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingData, setLoadingData] = useState(true);

  // operator inputs (text so partially typed numbers survive)
  const [mag, setMag] = useState("1000");
  const [hfov, setHfov] = useState("");
  const [px, setPx] = useState("");
  const [py, setPy] = useState("");
  const [scanRot, setScanRot] = useState("0");
  const [stageX, setStageX] = useState("0");
  const [stageY, setStageY] = useState("0");
  const [tiltOn, setTiltOn] = useState(false);
  const [stageTilt, setStageTilt] = useState("52");

  const [correction, setCorrection] = useState<GeometryCorrection>(NO_CORRECTION);
  const [fiducials, setFiducials] = useState<Fiducial[]>([newFiducial(), newFiducial(), newFiducial(), newFiducial()]);
  const [model, setModel] = useState<FitModel>("affine");
  const [fit, setFit] = useState<FitResult | null>(null);
  const [fitError, setFitError] = useState<string | null>(null);
  const [foldScale, setFoldScale] = useState(false);

  // ---- load ------------------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setLoadingData(true);
    dispatch(fetchMagCalibration());
    Promise.all([
      calibrationApi.bundle(equipmentId, type, { keys: geometryParameterKeys(type), limit: 50 }),
      fetchScanGeometry(),
    ])
      .then(([bundle, geometry]) => {
        if (cancelled) return;
        setProfileValues(Object.fromEntries(bundle.values.map((v) => [v.parameter_key, v.value])));
        setStored(geometry);
        const cfg = geometry.config;
        if (cfg && cfg.equipment_id === equipmentId && cfg.equipment_type === type) {
          const i = cfg.inputs;
          setMag(String(i.magnification));
          setScanRot(String(i.scanRotationDeg));
          setStageX(String(i.stageOriginUm[0]));
          setStageY(String(i.stageOriginUm[1]));
          setTiltOn(i.tiltCorrection.enabled);
          setStageTilt(String(i.tiltCorrection.stageTiltDeg));
          setCorrection(cfg.correction);
          if (cfg.fit?.points?.length) setFiducials(cfg.fit.points.map((p) => ({ ...p, id: `f${++fidSeq}` })));
          if (cfg.fit?.model) setModel(cfg.fit.model);
        }
      })
      .catch((err) => !cancelled && setLoadError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setLoadingData(false));
    return () => {
      cancelled = true;
    };
  }, [equipmentId, type, dispatch]);

  // ---- model -----------------------------------------------------------------------------------
  const resolved = useMemo(
    () =>
      resolveScanGeometryInputs({
        type,
        profileValues,
        magCalibration: magPoints,
        stream: stored?.stream ?? {},
        overrides: {
          magnification: numOr(mag, 1000),
          hfovUm: optNum(hfov),
          pixelsX: optNum(px),
          pixelsY: optNum(py),
          scanRotationDeg: numOr(scanRot, 0),
          stageOriginUm: [numOr(stageX, 0), numOr(stageY, 0)],
          tiltCorrection: { enabled: tiltOn, stageTiltDeg: numOr(stageTilt, 52) },
        },
      }),
    [type, profileValues, magPoints, stored, mag, hfov, px, py, scanRot, stageX, stageY, tiltOn, stageTilt],
  );

  const built = useMemo((): { nominal: ScanGeometry; rectified: ScanGeometry } | { error: string } => {
    try {
      return { nominal: buildScanGeometry(resolved.inputs, NO_CORRECTION), rectified: buildScanGeometry(resolved.inputs, correction) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, [resolved, correction]);

  const results = "error" in built ? null : scanGeometryResults(built.rectified);
  const nominalResults = "error" in built ? null : scanGeometryResults(built.nominal);
  const storedCfg = stored?.config ?? null;
  const appliedHere = Boolean(storedCfg?.enabled && storedCfg.equipment_id === equipmentId && storedCfg.equipment_type === type);
  const stale = appliedHere && storedCfg?.profile_revision !== null && profileRevision !== null && storedCfg?.profile_revision !== profileRevision;
  const corrected = correction !== NO_CORRECTION && correction.matrix.some((v, k) => Math.abs(v - NO_CORRECTION.matrix[k]) > 1e-12);

  // ---- actions ---------------------------------------------------------------------------------
  function runFit() {
    setFitError(null);
    if ("error" in built) return;
    try {
      const result = fitFiducials(built.nominal, fiducials, model);
      setFit(result);
      setCorrection(result.correction);
    } catch (err) {
      setFit(null);
      setFitError(err instanceof Error ? err.message : String(err));
    }
  }

  async function apply() {
    if ("error" in built || !canApply) return;
    if (
      dimension.source?.kind === "manual" &&
      !window.confirm(t("geometry.overwriteManual"))
    ) {
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      let inputs = resolved.inputs;
      let corr = correction;
      if (foldScale) {
        const folded = foldScaleIntoHfov(inputs, corr);
        inputs = { ...inputs, hfovUm: folded.hfovUm };
        corr = folded.correction;
        await dispatch(
          saveMagCalibration({ beam, points: { ...magPoints, [String(Math.trunc(inputs.magnification))]: inputs.hfovUm * 1e-6 }, path: magState.beams[beam]?.path }),
        ).unwrap();
      }
      const config: Omit<ScanGeometryConfig, "applied_at" | "applied_by"> = {
        version: SCAN_GEOMETRY_VERSION,
        enabled: true,
        beam,
        equipment_id: equipmentId,
        equipment_type: type,
        profile_revision: profileRevision,
        inputs,
        correction: corr,
        fit: fit
          ? { model: fit.model, rms_um: fit.rmsUm, max_um: fit.maxUm, points: fiducials.filter((f) => [f.u, f.v, f.worldX, f.worldY].every(Number.isFinite)), magnification: inputs.magnification, fitted_at: new Date().toISOString() }
          : storedCfg?.fit ?? null,
      };
      const saved = await saveScanGeometry(config);
      setStored(saved);
      if (foldScale) {
        setCorrection(corr);
        setHfov("");
        setFoldScale(false);
      }
      const geometry = buildScanGeometry(inputs, corr);
      clearBitmapSelectionCache();
      dispatch(setScanGeometry(toAppliedGeometry(geometry, profileRevision)));
      const bounds = dimensionBoundsFromGeometry(geometry);
      const values: DimensionCalibrationValues = {
        ...dimension,
        ...bounds,
        source: { kind: "scanGeometry", equipment_id: equipmentId, equipment_type: type, profile_revision: profileRevision, applied_at: new Date().toISOString() },
      };
      dispatch(saveDimensionCalibration(values));
      dispatch(applyPersistedDimensionCalibration(values));
      setNotice({ tone: "ok", text: t("geometry.applied") });
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!storedCfg || !canApply) return;
    setBusy(true);
    try {
      const saved = await saveScanGeometry({ ...storedCfg, enabled: false });
      setStored(saved);
      clearBitmapSelectionCache();
      dispatch(setScanGeometry(null));
      setNotice({ tone: "warn", text: t("geometry.disabled") });
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  function updateFiducial(id: string, patch: Partial<Fiducial>) {
    setFiducials((list) => list.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  // ---- render ----------------------------------------------------------------------------------
  const sourceLabel = (s: InputSource | undefined) => t(`geometry.source.${s ?? "default"}` as TranslationKey);
  const keys = SCAN_GEOMETRY_KEYS[type];
  const residualById = new Map(fit?.residuals.map((r) => [r.id, r]) ?? []);

  return (
    <section className="calib-geom">
      <div className="calib-geom__head">
        <strong>{t("geometry.title")}</strong>
        <ScanGeometryHelp />
        {appliedHere ? (
          <span className={`calib-badge calib-badge--${stale ? "warn" : "ok"}`}>
            {stale ? t("geometry.status.stale", { revision: storedCfg?.profile_revision ?? 0 }) : t("geometry.status.applied")}
          </span>
        ) : (
          <span className="calib-badge">{t("geometry.status.notApplied")}</span>
        )}
        <span className="spacer" />
        <button type="button" className="btn btn--ghost" onClick={onClose}>{t("calibration.history.close")}</button>
      </div>
      <p className="calib-muted">{t("geometry.intro")}</p>
      {loadingData && <LoadingSpinner label={t("geometry.loading")} />}
      {loadError && <p className="calib-row__error" role="alert">{loadError}</p>}
      {notice && <p className={`calib-banner calib-banner--${notice.tone}`} role="status">{notice.text}</p>}

      {/* 1. inputs from the calibration profile */}
      <h4 className="calib-geom__h">{t("geometry.section.profile")}</h4>
      <div className="calib-geom__table" role="table">
        {ROLE_ORDER.filter((r) => keys[r]).map((r) => {
          const key = keys[r] as string;
          const value = profileValues[key];
          return (
            <div className="calib-geom__tr" role="row" key={r}>
              <span role="cell">{t(`geometry.role.${r}` as TranslationKey)}</span>
              <code role="cell" title={key}>{key.split(".").pop()}</code>
              <span role="cell" className="calib-geom__num">{value === undefined || value === null || value === "" ? <span className="calib-muted">{t("geometry.notSet")}</span> : String(value)}</span>
              <span role="cell">
                <button type="button" className="btn btn--ghost" onClick={() => onEditParameter(key)}>{t("geometry.edit")}</button>
              </span>
            </div>
          );
        })}
      </div>
      {resolved.warnings.length > 0 && (
        <ul className="calib-geom__warn">
          {resolved.warnings.map((w) => <li key={w}>{t(`geometry.warn.${w}` as TranslationKey)}</li>)}
        </ul>
      )}

      {/* 2. operating point */}
      <h4 className="calib-geom__h">{t("geometry.section.operating")}</h4>
      <div className="calib-geom__form">
        <label>{t("geometry.mag")}<input className="input" inputMode="decimal" value={mag} onChange={(e) => setMag(e.target.value)} /></label>
        <label>{t("geometry.hfovOverride")}<input className="input" inputMode="decimal" value={hfov} placeholder={g4(resolved.inputs.hfovUm)} onChange={(e) => setHfov(e.target.value)} /></label>
        <label>{t("geometry.pixelsX")}<input className="input" inputMode="numeric" value={px} placeholder={String(resolved.inputs.pixelsX)} onChange={(e) => setPx(e.target.value)} /></label>
        <label>{t("geometry.pixelsY")}<input className="input" inputMode="numeric" value={py} placeholder={String(resolved.inputs.pixelsY)} onChange={(e) => setPy(e.target.value)} /></label>
        <label>{t("geometry.scanRotation")}<input className="input" inputMode="decimal" value={scanRot} onChange={(e) => setScanRot(e.target.value)} /></label>
        <label>{t("geometry.stageX")}<input className="input" inputMode="decimal" value={stageX} onChange={(e) => setStageX(e.target.value)} /></label>
        <label>{t("geometry.stageY")}<input className="input" inputMode="decimal" value={stageY} onChange={(e) => setStageY(e.target.value)} /></label>
        <label className="calib-check"><input type="checkbox" checked={tiltOn} onChange={(e) => setTiltOn(e.target.checked)} />{t("geometry.tilt", { beam: g4(resolved.inputs.tiltCorrection.beamTiltDeg) })}</label>
        {tiltOn && <label>{t("geometry.stageTilt")}<input className="input" inputMode="decimal" value={stageTilt} onChange={(e) => setStageTilt(e.target.value)} /></label>}
      </div>
      <p className="calib-muted">
        {t("geometry.sources", {
          hfov: sourceLabel(resolved.sources.hfov),
          pixels: sourceLabel(resolved.sources.pixelsX),
          rotation: sourceLabel(resolved.sources.rotationOffsetDeg),
          aspect: sourceLabel(resolved.sources.yxAspect),
        })}
      </p>

      {"error" in built && <p className="calib-row__error" role="alert">{built.error}</p>}

      {/* 3. results */}
      {results && nominalResults && (
        <>
          <h4 className="calib-geom__h">{t("geometry.section.results")}</h4>
          <div className="calib-geom__results">
            <table className="calib-geom__grid">
              <thead>
                <tr><th /><th>X</th><th>Y</th></tr>
              </thead>
              <tbody>
                <tr><th>{t("geometry.r.pixels")}</th><td>{results.pixels[0]}</td><td>{results.pixels[1]}</td></tr>
                <tr><th>{t("geometry.r.dacPerPixel")}</th><td>{g4(results.dacPerPixel[0])}</td><td>{g4(results.dacPerPixel[1])}</td></tr>
                <tr><th>{t("geometry.r.scale")}</th><td>{g4(results.scaleUmPerCode[0] * 1e3)}</td><td>{g4(results.scaleUmPerCode[1] * 1e3)}</td></tr>
                <tr><th>{t("geometry.r.pixelSize")}</th><td>{g4(results.pixelSizeNm[0])}</td><td>{g4(results.pixelSizeNm[1])}</td></tr>
                <tr><th>{t("geometry.r.fov")}</th><td>{g4(results.fovUm[0])}</td><td>{g4(results.fovUm[1])}</td></tr>
                <tr><th>{t("geometry.r.center")}</th><td>{g4(results.center[0])}</td><td>{g4(results.center[1])}</td></tr>
                {results.spotParkWorld && (
                  <tr><th>{t("geometry.r.spotPark")}</th><td>{g4(results.spotParkWorld[0])}</td><td>{g4(results.spotParkWorld[1])}</td></tr>
                )}
              </tbody>
            </table>
            <dl className="calib-geom__dl">
              <dt>{t("geometry.r.rotation")}</dt><dd>{g4(results.rotationDeg)}°{results.mirrored ? ` · ${t("geometry.r.mirrored")}` : ""}</dd>
              <dt>{t("geometry.r.shear")}</dt><dd>{g4(results.shear)}</dd>
              <dt>{t("geometry.r.frameTime")}</dt><dd>{g4(results.frameSeconds)} s ({g4(results.pixelDwellNs)} ns / px)</dd>
              <dt>{t("geometry.r.corners")}</dt>
              <dd className="calib-geom__corners">
                {(["topLeft", "topRight", "bottomRight", "bottomLeft"] as const).map((k) => (
                  <span key={k}>{t(`geometry.corner.${k}` as TranslationKey)} ({g4(results.corners[k][0])}, {g4(results.corners[k][1])})</span>
                ))}
              </dd>
            </dl>
            <GeometryPreview nominal={nominalResults.corners} rectified={results.corners} fiducials={fiducials} fit={fit} geometry={"error" in built ? null : built.rectified} />
          </div>
          <div className="calib-geom__goto">
            <GoToDimensionCalButton equipmentId={equipmentId} type={type} role={role} />
          </div>
        </>
      )}

      {/* 4. rectification */}
      <h4 className="calib-geom__h">{t("geometry.section.fit")}</h4>
      <p className="calib-muted">{t("geometry.fitHelp")}</p>
      <div className="calib-geom__fid" role="table">
        <div className="calib-geom__fid-row calib-geom__fid-head" role="row">
          <span />
          <span>{t("geometry.fid.space")}</span>
          <span>{t("geometry.fid.u")}</span>
          <span>{t("geometry.fid.v")}</span>
          <span>{t("geometry.fid.worldX")}</span>
          <span>{t("geometry.fid.worldY")}</span>
          <span>{t("geometry.fid.residual")}</span>
          <span />
        </div>
        {fiducials.map((f) => {
          const r = residualById.get(f.id);
          const cell = (value: number, key: "u" | "v" | "worldX" | "worldY") => (
            <input className="input" inputMode="decimal" defaultValue={Number.isFinite(value) ? String(value) : ""} onChange={(e) => updateFiducial(f.id, { [key]: optNum(e.target.value) ?? NaN })} />
          );
          return (
            <div className="calib-geom__fid-row" role="row" key={f.id}>
              <input type="checkbox" checked={f.enabled} aria-label={t("geometry.fid.use")} onChange={(e) => updateFiducial(f.id, { enabled: e.target.checked })} />
              <select className="select" value={f.space} onChange={(e) => updateFiducial(f.id, { space: e.target.value as Fiducial["space"] })}>
                <option value="pixel">{t("geometry.fid.pixel")}</option>
                <option value="dac">DAC</option>
              </select>
              {cell(f.u, "u")}
              {cell(f.v, "v")}
              {cell(f.worldX, "worldX")}
              {cell(f.worldY, "worldY")}
              <span className="calib-geom__num">{r ? `${g4(r.distance)} µm` : ""}</span>
              <button type="button" className="btn btn--ghost btn--icon" aria-label={t("geometry.fid.remove")} onClick={() => setFiducials((l) => l.filter((x) => x.id !== f.id))}>
                <Icon name="trash" tone="accent" />
              </button>
            </div>
          );
        })}
      </div>
      <div className="calib__toolbar">
        <button type="button" className="btn btn--ghost" onClick={() => setFiducials((l) => [...l, newFiducial()])}><Icon name="plus" tone="accent" />{t("geometry.fid.add")}</button>
        <select className="select" value={model} aria-label={t("geometry.model")} onChange={(e) => setModel(e.target.value as FitModel)}>
          <option value="affine">{t("geometry.model.affine")}</option>
          <option value="similarity">{t("geometry.model.similarity")}</option>
        </select>
        <button type="button" className="btn btn--primary" onClick={runFit}><Icon name="target" />{t("geometry.fit")}</button>
        <GeometryFitHelp />
        {corrected && <button type="button" className="btn btn--ghost" onClick={() => { setCorrection(NO_CORRECTION); setFit(null); }}>{t("geometry.resetCorrection")}</button>}
      </div>
      {fitError && <p className="calib-row__error" role="alert">{fitError}</p>}
      {fit && (
        <p className={`calib-banner calib-banner--${fit.maxUm > 3 * (results?.pixelSizeNm[0] ?? 0) / 1e3 && fit.points > 3 ? "warn" : "ok"}`}>
          {t("geometry.fitResult", {
            points: fit.points,
            rms: g4(fit.rmsUm * 1e3),
            max: g4(fit.maxUm * 1e3),
            sx: g4((fit.change.scaleX - 1) * 100),
            sy: g4((fit.change.scaleY - 1) * 100),
            rot: g4(fit.change.rotationDeg),
            shear: g4(fit.change.shear),
            ox: g4(fit.change.offsetUm[0]),
            oy: g4(fit.change.offsetUm[1]),
          })}
          {fit.points === (fit.model === "affine" ? 3 : 2) ? ` ${t("geometry.fitExact")}` : ""}
          {fit.change.mirrored ? ` ${t("geometry.fitMirrored")}` : ""}
        </p>
      )}

      {/* 5. apply */}
      {dimension.source && (
        <p className="calib-muted">
          {dimension.source.kind === "manual"
            ? t("geometry.dimensionSource.manual", { when: shortTimestamp(dimension.source.set_at) })
            : t("geometry.dimensionSource.scanGeometry", {
                type: dimension.source.equipment_type,
                revision: dimension.source.profile_revision ?? 0,
                when: shortTimestamp(dimension.source.applied_at),
              })}
        </p>
      )}
      <div className="calib-geom__apply">
        {corrected && (
          <label className="calib-check">
            <input type="checkbox" checked={foldScale} onChange={(e) => setFoldScale(e.target.checked)} />
            {t("geometry.foldScale", { mag: Math.trunc(resolved.inputs.magnification) })}
          </label>
        )}
        <span className="spacer" />
        {appliedHere && <button type="button" className="btn btn--ghost" disabled={busy || !canApply} onClick={() => void disable()}>{t("geometry.disable")}</button>}
        <button type="button" className="btn btn--primary" disabled={busy || !canApply || "error" in built} title={canApply ? undefined : t("calibration.lock.role", { role: ROLE_SUPER_USER })} onClick={() => void apply()}>
          <Icon name="save" />{busy ? t("calibration.save.saving") : t("geometry.apply")}
        </button>
      </div>
    </section>
  );
}

function GeometryPreview(props: {
  nominal: Record<"topLeft" | "topRight" | "bottomRight" | "bottomLeft", Vec2>;
  rectified: Record<"topLeft" | "topRight" | "bottomRight" | "bottomLeft", Vec2>;
  fiducials: Fiducial[];
  fit: FitResult | null;
  geometry: ScanGeometry | null;
}) {
  const { t } = useTranslation();
  const order = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;
  const known = props.fiducials.filter((f) => f.enabled && Number.isFinite(f.worldX) && Number.isFinite(f.worldY));
  const all: Vec2[] = [...order.map((k) => props.nominal[k]), ...order.map((k) => props.rectified[k]), ...known.map((f) => [f.worldX, f.worldY] as Vec2)];
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const span = Math.max(x1 - x0, y1 - y0, 1e-9);
  const pad = span * 0.08;
  const vbX = x0 - pad, vbY = y0 - pad, vbW = x1 - x0 + 2 * pad, vbH = y1 - y0 + 2 * pad;
  const vb = `${vbX} ${vbY} ${vbW} ${vbH}`;
  const gridRatios = [0, 0.25, 0.5, 0.75, 1]; // same 5 major divisions as Dimension Cal's canvas grid
  const poly = (c: typeof props.nominal) => order.map((k) => c[k].join(",")).join(" ");
  const sw = span / 250;
  const residual = new Map(props.fit?.residuals.map((r) => [r.id, r]) ?? []);
  const exaggerate = 20;
  return (
    <figure className="calib-geom__preview">
      <svg viewBox={vb} role="img" aria-label={t("geometry.preview")}>
        {/* Grid: same 5-division layout and colour as the Dimension Cal canvas (.canvas-axis-overlay__grid), for visual consistency between the two calibration tools. */}
        {gridRatios.map((r) => (
          <line key={`gx${r}`} x1={vbX + vbW * r} y1={vbY} x2={vbX + vbW * r} y2={vbY + vbH} stroke="rgba(95, 184, 255, 0.14)" strokeWidth={sw} />
        ))}
        {gridRatios.map((r) => (
          <line key={`gy${r}`} x1={vbX} y1={vbY + vbH * r} x2={vbX + vbW} y2={vbY + vbH * r} stroke="rgba(95, 184, 255, 0.14)" strokeWidth={sw} />
        ))}
        <polygon points={poly(props.nominal)} fill="none" stroke="currentColor" strokeOpacity={0.45} strokeWidth={sw} strokeDasharray={`${sw * 4} ${sw * 3}`} />
        <polygon points={poly(props.rectified)} fill="var(--c-accent)" fillOpacity={0.08} stroke="var(--c-accent)" strokeWidth={sw * 1.5} />
        <circle cx={props.rectified.topLeft[0]} cy={props.rectified.topLeft[1]} r={sw * 4} fill="var(--c-accent)" />
        {known.map((f) => {
          const r = residual.get(f.id);
          return (
            <g key={f.id}>
              <circle cx={f.worldX} cy={f.worldY} r={sw * 3.5} fill="none" stroke="var(--c-warn)" strokeWidth={sw} />
              {r && <line x1={f.worldX} y1={f.worldY} x2={f.worldX + r.dx * exaggerate} y2={f.worldY + r.dy * exaggerate} stroke="var(--c-danger)" strokeWidth={sw} />}
            </g>
          );
        })}
      </svg>
      <figcaption className="calib-muted">{t("geometry.previewLegend", { factor: exaggerate })}</figcaption>
    </figure>
  );
}
