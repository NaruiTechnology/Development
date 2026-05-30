import { useEffect, useRef, useState } from "react";

import { clearROIImage, clearROISelection, updateROI, type ROIState } from "../store/scanSlice";
import { useAppDispatch, useAppSelector } from "../store";
import type { ROIRequest } from "../types/api";
import {
  clearBitmapSelectionCache,
  worldSelectionToDacROI,
} from "../lib/bitmapVector";
import { useTranslation, type TranslationApi, type TranslationKey } from "../i18n";
import { Icon } from "./Icon";

const EDGE = 640;
// Scale-unit values are stored in state as ASCII codes ("um" / "mm" / …)
// because the wire-format API doesn't carry units (everything is
// linearly remapped to DAC codes). The display labels use the actual
// Unicode symbols; we don't translate these because they're SI-standard
// notation that operators read the same way in every language.
const UNITS = [
  { value: "um", label: "μm" },
  { value: "mm", label: "mm" },
  { value: "cm", label: "cm" },
  { value: "nm", label: "nm" },
];

export function ROIEditor({
  disabled,
  variant = "all",
  backgroundImageUrl = null,
}: {
  disabled: boolean;
  variant?: "controls" | "canvas" | "all";
  backgroundImageUrl?: string | null;
}) {
  const dispatch = useAppDispatch();
  const tr = useTranslation();
  const { t } = tr;
  const roi = useAppSelector((s) => s.scan.roi);
  const simulationSource = useAppSelector((s) => {
    const raw = s.status.defaults?.simulation?.source;
    return typeof raw === "string" ? raw : "";
  });
  const isProduction = useAppSelector((s) => s.status.defaults?.is_production === true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const promotedBackgroundRef = useRef<string | null>(null);
  const [draft, setDraft] = useState<ROIRequest | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [suppressedBackgroundUrl, setSuppressedBackgroundUrl] = useState<string | null>(null);
  const hasLoadedImage = Boolean(roi.imageDataUrl);
  const hasPartialRegion = Boolean(roi.selection);
  const imageFileSourceEnabled = isProduction || simulationSource === "file";
  const imageFileSourcePrompt = !imageFileSourceEnabled
    ? t("roi.imageSourceFileRequired", { source: simulationSource || "unset" })
    : "";
  const bitmapCleanupDisabled = !hasLoadedImage || !hasPartialRegion;
  const backgroundSource =
    backgroundImageUrl && backgroundImageUrl !== suppressedBackgroundUrl
      ? backgroundImageUrl
      : null;
  const imageSource =
    roi.imageKind === "lastScan"
      ? backgroundSource ?? roi.imageDataUrl
      : roi.imageDataUrl ?? backgroundSource;

  useEffect(() => {
    if (!imageSource) {
      imageRef.current = null;
      draw();
      return;
    }
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      if (
        backgroundImageUrl &&
        imageSource === backgroundImageUrl &&
        promotedBackgroundRef.current !== backgroundImageUrl
      ) {
        const fillStyle = canvasRef.current
          ? getCssColor(canvasRef.current, "--c-bg-elev", "#11203a")
          : "#11203a";
        const dataUrl = imageToDataUrl(img, fillStyle);
        if (dataUrl) {
          promotedBackgroundRef.current = backgroundImageUrl;
          // The imageName field shows in the controls header and in
          // download filenames; localising it at promote-time means
          // the operator sees their language. If they switch locales
          // later it stays at the old name — that's acceptable
          // because the name is treated as a label for a specific
          // capture, not a UI string.
          dispatch(updateROI({
            imageName: t("roi.imageName.lastScan"),
            imageDataUrl: dataUrl,
            imageKind: "lastScan",
          }));
        }
      }
      draw();
    };
    img.onerror = () => {
      imageRef.current = null;
      draw();
    };
    img.src = imageSource;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageSource]);

  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roi, draft, tr.locale]);

  useEffect(() => {
    if (!dragStartRef.current) {
      setDraft(null);
    }
  }, [roi.selection]);

  function loadFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        clearBitmapSelectionCache();
        setSuppressedBackgroundUrl(null);
        // file.name comes from the OS — leave it verbatim.
        dispatch(updateROI({ imageName: file.name, imageDataUrl: reader.result, imageKind: "file" }));
      }
    };
    reader.readAsDataURL(file);
  }

  function canvasPoint(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    return {
      x: clamp(Math.round(((e.clientX - r.left) / r.width) * EDGE), 0, EDGE),
      y: clamp(Math.round(((e.clientY - r.top) / r.height) * EDGE), 0, EDGE),
    };
  }

  function toDut(p: { x: number; y: number }) {
    const x = Math.round(lerp(roi.x_origin, roi.x_end, p.x / EDGE));
    const y = Math.round(lerp(roi.y_origin, roi.y_end, p.y / EDGE));
    return { x, y };
  }

  function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): ROIRequest {
    const p0 = toDut(a);
    const p1 = toDut(b);
    return {
      x_start: Math.min(p0.x, p1.x),
      x_end: Math.max(p0.x, p1.x),
      y_start: Math.min(p0.y, p1.y),
      y_end: Math.max(p0.y, p1.y),
    };
  }

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, EDGE, EDGE);

    const img = imageRef.current;
    if (img) {
      ctx.drawImage(img, 0, 0, EDGE, EDGE);
    }

    ctx.save();
    ctx.strokeStyle = "rgba(95, 184, 255, 0.85)";
    ctx.fillStyle = "rgba(230, 238, 249, 0.92)";
    ctx.lineWidth = 1;
    ctx.font = "12px ui-monospace, monospace";
    drawScale(ctx, roi, unitLabel(roi.scale_unit), tr);
    ctx.restore();

    const selected = draft ?? roi.selection;
    if (selected) drawSelection(ctx, selected);
  }

  function drawSelection(ctx: CanvasRenderingContext2D, selected: ROIRequest) {
    const x0 = dutToCanvas(selected.x_start, roi.x_origin, roi.x_end);
    const x1 = dutToCanvas(selected.x_end, roi.x_origin, roi.x_end);
    const y0 = dutToCanvas(selected.y_start, roi.y_origin, roi.y_end);
    const y1 = dutToCanvas(selected.y_end, roi.y_origin, roi.y_end);
    ctx.save();
    ctx.strokeStyle = "#ff2d2d";
    ctx.fillStyle = "#ff2d2d";
    ctx.lineWidth = 0.8;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    // "S" and "E" are visual mnemonics on the canvas (Start / End). We
    // keep them as single letters even in Chinese because they refer
    // to the on-canvas points and need to be visually compact; the
    // matching prose labels in the field-row above are translated.
    drawLabel(ctx, x0 + 4, y0 + 14, `S(${selected.x_start}, ${selected.y_start})`);
    drawLabel(ctx, x1 + 4, y1 - 6, `E(${selected.x_end}, ${selected.y_end})`);
    ctx.restore();
  }

  function clearLoadedImage() {
    clearBitmapSelectionCache();
    imageRef.current = null;
    setSuppressedBackgroundUrl(backgroundImageUrl);
    dispatch(clearROIImage());
  }

  function clearPartialRegion() {
    clearBitmapSelectionCache();
    setDraft(null);
    dispatch(clearROISelection());
  }

  return (
    <div>
      {(variant === "controls" || variant === "all") && (
        <>
          <div className="button-row" style={{ marginBottom: 10 }}>
            <button
              className="btn"
              disabled={disabled || !imageFileSourceEnabled}
              title={!disabled && imageFileSourcePrompt ? imageFileSourcePrompt : undefined}
              onClick={() => fileRef.current?.click()}
            >
              <Icon name="upload" tone="accent" />
              {t("roi.select")}
            </button>
            <button
              className="btn btn--ghost"
              disabled={disabled || !imageFileSourceEnabled || !hasLoadedImage}
              title={!disabled && imageFileSourcePrompt ? imageFileSourcePrompt : undefined}
              onClick={clearLoadedImage}
            >
              <Icon name="trash" tone="danger" />
              {t("roi.clearImage")}
            </button>
            <button className="btn btn--ghost" disabled={disabled || !hasPartialRegion} onClick={clearPartialRegion}>
              <Icon name="crop" tone="warn" />
              {t("roi.clearRegion")}
            </button>
            <span className="muted" style={{ fontSize: 12 }}>{roi.imageName}</span>
            <input
              ref={fileRef}
              type="file"
              accept=".bmp,.png,.jpg,.jpeg,image/bmp,image/png,image/jpeg"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) loadFile(file);
              }}
            />
          </div>
          {imageFileSourcePrompt && (
            <div className="roi-source-prompt" role="status">
              {imageFileSourcePrompt}
            </div>
          )}

          <div className="field-row">
            <Num
              labelKey="roi.xOrigin"
              value={roi.x_origin}
              min={0}
              max={Math.max(0, roi.x_end - 1)}
              rangeText={t("roi.error.rangeXLessThanEnd", { max: Math.max(0, roi.x_end - 1) })}
              disabled={disabled}
              onChange={(v) => {
                clearBitmapSelectionCache();
                dispatch(updateROI({ x_origin: v }));
              }}
            />
            <Num
              labelKey="roi.xEnd"
              value={roi.x_end}
              min={Math.min(16383, roi.x_origin + 1)}
              max={16383}
              rangeText={t("roi.error.rangeXGreaterThanOrigin", { min: Math.min(16383, roi.x_origin + 1) })}
              disabled={disabled}
              onChange={(v) => {
                clearBitmapSelectionCache();
                dispatch(updateROI({ x_end: v }));
              }}
            />
          </div>
          <div className="field-row">
            <Num
              labelKey="roi.yOrigin"
              value={roi.y_origin}
              min={0}
              max={Math.max(0, roi.y_end - 1)}
              rangeText={t("roi.error.rangeYLessThanEnd", { max: Math.max(0, roi.y_end - 1) })}
              disabled={disabled}
              onChange={(v) => {
                clearBitmapSelectionCache();
                dispatch(updateROI({ y_origin: v }));
              }}
            />
            <Num
              labelKey="roi.yEnd"
              value={roi.y_end}
              min={Math.min(16383, roi.y_origin + 1)}
              max={16383}
              rangeText={t("roi.error.rangeYGreaterThanOrigin", { min: Math.min(16383, roi.y_origin + 1) })}
              disabled={disabled}
              onChange={(v) => {
                clearBitmapSelectionCache();
                dispatch(updateROI({ y_end: v }));
              }}
            />
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={roi.show_grid}
              disabled={disabled}
              onChange={(e) => dispatch(updateROI({ show_grid: e.target.checked }))}
            />
            {t("roi.showGrid")}
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={roi.keep_loaded_bitmap_after_scan}
              disabled={disabled || bitmapCleanupDisabled}
              onChange={(e) => dispatch(updateROI({ keep_loaded_bitmap_after_scan: e.target.checked }))}
            />
            {t("roi.keepBitmap")}
          </label>

          <div className="field-row">
            <CoordinateField
              labelKey="roi.start"
              value={selectionStart(roi)}
              disabled={disabled}
              validate={(p) => validateStartPoint(p, roi, tr)}
              onChange={(p) => {
                const end = selectionEnd(roi);
                clearBitmapSelectionCache();
                dispatch(
                  updateROI({
                    selection: {
                      x_start: p.x,
                      y_start: p.y,
                      x_end: end.x,
                      y_end: end.y,
                    },
                  })
                );
              }}
            />
            <CoordinateField
              labelKey="roi.end"
              value={selectionEnd(roi)}
              disabled={disabled}
              validate={(p) => validateEndPoint(p, roi, tr)}
              onChange={(p) => {
                const start = selectionStart(roi);
                clearBitmapSelectionCache();
                dispatch(
                  updateROI({
                    selection: {
                      x_start: start.x,
                      y_start: start.y,
                      x_end: p.x,
                      y_end: p.y,
                    },
                  })
                );
              }}
            />
          </div>

          {/* DAC mapping diagnostic readout. See the verbatim comment in
              the original file for full background — it remaps a world-
              units selection onto the DAC range 0..16383 for sanity. */}
          {roi.selection && (
            <div
              className="muted"
              style={{
                fontSize: 11,
                marginTop: 2,
                marginBottom: 8,
                fontFamily: "var(--font-mono)",
              }}
            >
              {(() => {
                const dac = worldSelectionToDacROI(roi.selection, roi);
                return (
                  <>
                    {t("roi.dacEquivalent")}&nbsp;
                    S({dac.x_start}, {dac.y_start}) → E({dac.x_end}, {dac.y_end})
                    &nbsp;<span style={{ opacity: 0.7 }}>
                      {t("roi.dacMappingNote", {
                        xRange: fmtRange(roi.x_origin, roi.x_end),
                        yRange: fmtRange(roi.y_origin, roi.y_end),
                        unit: unitLabel(roi.scale_unit),
                      })}
                    </span>
                  </>
                );
              })()}
            </div>
          )}
          <div className="field">
            <label>{t("roi.scaleUnit")}</label>
            <select
              className="select"
              value={roi.scale_unit}
              disabled={disabled}
              onChange={(e) => dispatch(updateROI({ scale_unit: e.target.value }))}
            >
              {UNITS.map((u) => (
                <option key={u.value} value={u.value}>{u.label}</option>
              ))}
            </select>
          </div>
        </>
      )}

      {(variant === "canvas" || variant === "all") && (
        <div className="roi-canvas-wrap">
          <canvas
            ref={canvasRef}
            className={disabled ? "is-disabled" : undefined}
            width={EDGE}
            height={EDGE}
            onPointerDown={(e) => {
              if (disabled) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              const p = canvasPoint(e);
              dragStartRef.current = p;
              const d = toDut(p);
              setTip({ x: e.clientX, y: e.clientY, text: `(${d.x}, ${d.y})` });
            }}
            onPointerMove={(e) => {
              if (disabled) return;
              e.preventDefault();
              const p = canvasPoint(e);
              const d = toDut(p);
              if (dragStartRef.current) {
                const next = rectFromPoints(dragStartRef.current, p);
                setDraft(next);
                setTip({ x: e.clientX, y: e.clientY, text: `(${d.x}, ${d.y})` });
              }
            }}
            onPointerUp={(e) => {
              if (disabled) return;
              e.preventDefault();
              if (!dragStartRef.current) return;
              const next = rectFromPoints(dragStartRef.current, canvasPoint(e));
              dragStartRef.current = null;
              setDraft(null);
              clearBitmapSelectionCache();
              dispatch(updateROI({ selection: next }));
              setTip(null);
            }}
            onPointerLeave={() => {
              dragStartRef.current = null;
              setDraft(null);
              setTip(null);
            }}
          />
          {tip && (
            <div className="roi-tooltip" style={{ left: tip.x + 10, top: tip.y + 10 }}>
              {tip.text}
            </div>
          )}
        </div>
      )}

    </div>
  );
}

function imageToDataUrl(img: HTMLImageElement, fillStyle = "#11203a"): string | null {
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (width <= 0 || height <= 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  try {
    ctx.fillStyle = fillStyle;
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

function getCssColor(el: Element, variable: string, fallback: string): string {
  const value = getComputedStyle(el).getPropertyValue(variable).trim();
  return value || fallback;
}

function Num(props: {
  labelKey: TranslationKey;
  value: number;
  disabled: boolean;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  /** Pre-formatted range text for the "must be between {range}" message,
   *  e.g. "0 and 4095 (less than X end)". Built by the caller because
   *  the range depends on sibling field values. */
  rangeText?: string;
}) {
  const min = props.min ?? 0;
  const max = props.max ?? 16383;
  const { t } = useTranslation();
  const label = t(props.labelKey);
  const [text, setText] = useState(formatOneDecimal(props.value));
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    setText(formatOneDecimal(props.value));
    setWarning(null);
  }, [props.value]);

  function commit(next: string) {
    setText(next);
    if (next === "") {
      // The required / NaN / >1-decimal cases were previously distinct
      // English messages in the original; collapsed to a single
      // numeric-range message here since the translation table has
      // one slot per category and these three are all "you gave us
      // something not in [min..max]".
      setWarning(t("roi.error.numericRange", { label, range: props.rangeText ?? `${min} ${max}` }));
      return;
    }

    const parsed = Number(next);
    if (!Number.isFinite(parsed) || !hasAtMostOneDecimal(next) || parsed < min || parsed > max) {
      setWarning(t("roi.error.numericRange", { label, range: props.rangeText ?? `${min} ${max}` }));
      return;
    }

    setWarning(null);
    setText(formatOneDecimal(parsed));
    props.onChange(parsed);
  }

  return (
    <div className="field">
      <label>{label}</label>
      <input
        className={`input${warning ? " input--invalid" : ""}`}
        type="number"
        step={0.1}
        value={text}
        disabled={props.disabled}
        aria-invalid={warning ? "true" : "false"}
        onChange={(e) => commit(e.target.value)}
      />
      {warning && <div className="field-warning">{warning}</div>}
    </div>
  );
}

function CoordinateField(props: {
  labelKey: TranslationKey;
  value: { x: number; y: number };
  disabled: boolean;
  validate: (p: { x: number; y: number }) => string | null;
  onChange: (p: { x: number; y: number }) => void;
}) {
  const { t } = useTranslation();
  const label = t(props.labelKey);
  const [text, setText] = useState(formatPointText(props.value));
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    setText(formatPointText(props.value));
    setWarning(null);
  }, [props.value.x, props.value.y]);

  function commit(next: string) {
    setText(next);
    const parsed = parsePointText(next);
    if (!parsed) {
      setWarning(t("roi.error.pointFormat", { label }));
      return;
    }

    const validation = props.validate(parsed);
    if (validation) {
      setWarning(validation);
      return;
    }

    setWarning(null);
    props.onChange(parsed);
  }

  return (
    <div className="field">
      <label>{label}</label>
      <input
        className={`input${warning ? " input--invalid" : ""}`}
        value={text}
        disabled={props.disabled}
        aria-invalid={warning ? "true" : "false"}
        onChange={(e) => commit(e.target.value)}
      />
      {warning && <div className="field-warning">{warning}</div>}
    </div>
  );
}

function clamp(n: number, lo: number, hi: number) {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function dutToCanvas(v: number, a: number, b: number) {
  if (a === b) return 0;
  return ((v - a) / (b - a)) * EDGE;
}

function unitLabel(value: string) {
  return UNITS.find((u) => u.value === value)?.label ?? value;
}

function drawLabel(ctx: CanvasRenderingContext2D, x: number, y: number, text: string) {
  ctx.save();
  ctx.font = "12px ui-monospace, monospace";
  const w = ctx.measureText(text).width + 8;
  const bx = Math.min(Math.max(0, x), EDGE - w);
  const by = Math.min(Math.max(14, y), EDGE - 2);
  ctx.fillStyle = "rgba(0, 0, 0, 0.52)";
  ctx.fillRect(bx - 2, by - 12, w, 16);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, bx + 2, by);
  ctx.restore();
}

function drawScale(
  ctx: CanvasRenderingContext2D,
  roi: ROIState,
  unit: string,
  tr: TranslationApi,
) {
  const major = 4;
  const minorPerMajor = 5;
  const minorTicks = major * minorPerMajor;
  const axisPad = 28;

  ctx.save();
  ctx.strokeStyle = "rgba(95, 184, 255, 0.9)";
  ctx.fillStyle = "rgba(230, 238, 249, 0.95)";
  ctx.lineWidth = 1;
  ctx.font = "12px ui-monospace, monospace";

  ctx.beginPath();
  ctx.moveTo(0, axisPad);
  ctx.lineTo(EDGE, axisPad);
  ctx.moveTo(axisPad, 0);
  ctx.lineTo(axisPad, EDGE);
  ctx.stroke();

  for (let i = 0; i <= minorTicks; i++) {
    const isMajor = i % minorPerMajor === 0;
    const p = (i / minorTicks) * EDGE;
    const len = isMajor ? 10 : 5;
    ctx.beginPath();
    ctx.moveTo(p, axisPad);
    ctx.lineTo(p, axisPad + len);
    ctx.moveTo(axisPad, p);
    ctx.lineTo(axisPad + len, p);
    ctx.stroke();

    if (roi.show_grid && isMajor) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, EDGE);
      ctx.moveTo(0, p);
      ctx.lineTo(EDGE, p);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
      ctx.lineWidth = 0.3;
      ctx.stroke();
      ctx.strokeStyle = "rgba(95, 184, 255, 0.95)";
      ctx.lineWidth = 0.3;
      ctx.stroke();
      ctx.restore();
    }

    if (isMajor) {
      const t = i / minorTicks;
      const xLabel = `${roundScale(lerp(roi.x_origin, roi.x_end, t))}`;
      const yLabel = `${roundScale(lerp(roi.y_origin, roi.y_end, t))}`;
      ctx.fillText(xLabel, Math.min(p + 3, EDGE - 46), axisPad + 24);
      ctx.fillText(yLabel, axisPad + 14, Math.max(12, p - 3));
    }
  }

  // The on-canvas "Start ..." / "End ..." labels — translated via the
  // passed-in API. Width is bounded by the drawLabel measurement loop,
  // so long Chinese phrases ("起点 (x, y) μm") still fit.
  drawLabel(
    ctx,
    EDGE - 240,
    axisPad + 42,
    tr.t("roi.canvas.start", { point: formatROIStart(roi), unit }),
  );
  drawLabel(
    ctx,
    axisPad + 14,
    EDGE - 8,
    tr.t("roi.canvas.end", { point: formatROIEnd(roi), unit }),
  );
  ctx.restore();
}

function selectionStart(roi: ROIState) {
  const r = roi.selection;
  return r ? { x: r.x_start, y: r.y_start } : { x: roi.x_origin, y: roi.y_origin };
}

function selectionEnd(roi: ROIState) {
  const r = roi.selection;
  return r ? { x: r.x_end, y: r.y_end } : { x: roi.x_end, y: roi.y_end };
}

function formatROIStart(roi: ROIState) {
  return formatPointText(selectionStart(roi));
}

function formatROIEnd(roi: ROIState) {
  return formatPointText(selectionEnd(roi));
}

function formatPointText(p: { x: number; y: number }) {
  return `(${formatOneDecimal(p.x)}, ${formatOneDecimal(p.y)})`;
}

function parsePointText(text: string): { x: number; y: number } | null {
  const cleaned = text.trim().replace(/[()]/g, "");
  const parts = cleaned.split(/[,\s]+/).filter(Boolean);
  if (parts.length !== 2) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!hasAtMostOneDecimal(parts[0]) || !hasAtMostOneDecimal(parts[1])) return null;
  return { x, y };
}

function validateStartPoint(
  p: { x: number; y: number },
  roi: ROIState,
  tr: TranslationApi,
): string | null {
  const { t } = tr;
  const end = selectionEnd(roi);
  if (p.x < roi.x_origin || p.x > roi.x_end) {
    return t("roi.error.startXBounds", { origin: roi.x_origin, end: roi.x_end });
  }
  if (p.y < roi.y_origin || p.y > roi.y_end) {
    return t("roi.error.startYBounds", { origin: roi.y_origin, end: roi.y_end });
  }
  if (p.x >= end.x) return t("roi.error.startXLessThanEnd", { end: end.x });
  if (p.y >= end.y) return t("roi.error.startYLessThanEnd", { end: end.y });
  return null;
}

function validateEndPoint(
  p: { x: number; y: number },
  roi: ROIState,
  tr: TranslationApi,
): string | null {
  const { t } = tr;
  const start = selectionStart(roi);
  if (p.x < roi.x_origin || p.x > roi.x_end) {
    return t("roi.error.endXBounds", { origin: roi.x_origin, end: roi.x_end });
  }
  if (p.y < roi.y_origin || p.y > roi.y_end) {
    return t("roi.error.endYBounds", { origin: roi.y_origin, end: roi.y_end });
  }
  if (p.x <= start.x) return t("roi.error.endXGreaterThanStart", { start: start.x });
  if (p.y <= start.y) return t("roi.error.endYGreaterThanStart", { start: start.y });
  return null;
}

function roundScale(v: number) {
  return formatOneDecimal(v);
}

function fmtRange(a: number, b: number): string {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return `${formatOneDecimal(lo)}..${formatOneDecimal(hi)}`;
}

function formatOneDecimal(v: number): string {
  return Number.isFinite(v) ? v.toFixed(1) : "0.0";
}

function hasAtMostOneDecimal(text: string): boolean {
  return /^-?\d+(?:\.\d)?$/.test(text.trim());
}
