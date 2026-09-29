/**
 * Image-level "wedge" for the live / result scan image, modelled on OBI's
 * histogram + gradient bar (pyqtgraph HistogramLUTItem):
 *
 *   axis ticks | histogram of the frame | gradient bar | handles
 *
 * The top handle (filled triangle) is the WHITE level and the bottom handle
 * (hollow triangle) the BLACK level; samples at or below black render black,
 * at or above white render white, and everything between is stretched
 * linearly. Drag a handle to change one level, drag the band between them to
 * move both, double-click the bar (or press Auto) to go back to automatic
 * levels. Handles are keyboard operable (arrows, Shift = x16, Home / End).
 *
 * By default the axis is the 14-bit ADC code (sample >> 2) the detector reports
 * and levels run over the OBI 16-bit range. For an 8-bit gray image (ROI
 * canvas) pass fullScale = ROI_GRAY_FULL_SCALE and codeDivisor =
 * ROI_GRAY_SAMPLE_SCALE so the axis shows gray levels 0..255.
 */
import { useCallback, useMemo, useRef } from "react";

import { useTranslation } from "../i18n";
import {
  LEVEL_HISTOGRAM_BINS,
  OBI_FULL_SCALE,
  MIN_LEVEL_GAP,
  codeToSample,
  dragLevels,
  fractionToValue,
  niceCodeTicks,
  normalizeLevels,
  sampleToCode,
  valueToFraction,
  wedgeDomain,
  type LevelHistogram,
  type ResolvedLevels,
} from "../lib/displayLevels";

export interface LevelWedgeProps {
  histogram: LevelHistogram | null;
  /** Levels currently applied to the image. */
  levels: ResolvedLevels;
  /** True while levels are computed automatically. */
  auto: boolean;
  onChange: (levels: ResolvedLevels) => void;
  onAuto: () => void;
  disabled?: boolean;
  /** Largest level in sample units (default: OBI 16-bit full scale). */
  fullScale?: number;
  /** Sample units per axis unit (default 4: 14-bit ADC codes). */
  codeDivisor?: number;
}

type DragKind = "low" | "high" | "region";

export function LevelWedge({
  histogram,
  levels,
  auto,
  onChange,
  onAuto,
  disabled = false,
  fullScale = OBI_FULL_SCALE,
  codeDivisor = 4,
}: LevelWedgeProps) {
  const { t } = useTranslation();
  const barRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ kind: DragKind; start: ResolvedLevels; offset: number } | null>(null);

  const hist = histogram;
  const domain = useMemo(
    () => wedgeDomain(
        hist ?? { min: 0, max: 0, total: 0, bins: new Uint32Array(LEVEL_HISTOGRAM_BINS) },
        levels,
        fullScale,
      ),
    [hist, levels, fullScale],
  );
  const ticks = useMemo(() => niceCodeTicks(domain, 7, codeDivisor), [domain, codeDivisor]);

  const lowFrac = valueToFraction(levels.low, domain);
  const highFrac = valueToFraction(levels.high, domain);

  // Histogram outline: bin count -> horizontal extent, bin position -> height.
  const histogramPath = useMemo(() => {
    if (!hist || hist.total <= 0) return "";
    let peak = 0;
    for (let i = 0; i < hist.bins.length; i++) if (hist.bins[i] > peak) peak = hist.bins[i];
    if (peak <= 0) return "";
    const binWidth = hist.max > hist.min ? (hist.max - hist.min) / (hist.bins.length - 1) : 0;
    let d = "";
    for (let i = 0; i < hist.bins.length; i++) {
      const count = hist.bins[i];
      if (count === 0) continue;
      const y0 = 1 - valueToFraction(hist.min + i * binWidth, domain);
      const y1 = 1 - valueToFraction(hist.min + (i + 1) * binWidth, domain);
      const x = 1 - count / peak; // grows to the left, away from the bar
      const top = Math.min(y0, y1);
      const height = Math.max(Math.abs(y1 - y0), 0.002);
      d += `M1 ${top.toFixed(4)}H${x.toFixed(4)}V${(top + height).toFixed(4)}H1Z`;
    }
    return d;
  }, [hist, domain]);

  const pointerValue = useCallback(
    (clientY: number): number => {
      const bar = barRef.current;
      if (!bar) return levels.low;
      const rect = bar.getBoundingClientRect();
      const fraction = rect.height > 0 ? 1 - (clientY - rect.top) / rect.height : 0;
      return fractionToValue(fraction, domain);
    },
    [domain, levels.low],
  );

  const beginDrag = (kind: DragKind) => (event: React.PointerEvent<HTMLElement>) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    const value = pointerValue(event.clientY);
    const anchor = kind === "low" ? levels.low : kind === "high" ? levels.high : levels.low;
    dragRef.current = { kind, start: levels, offset: value - anchor };
  };

  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    onChange(dragLevels(drag.kind, drag.start, pointerValue(event.clientY), drag.offset, fullScale));
  };

  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  };

  const nudge = (kind: "low" | "high") => (event: React.KeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    const big = event.shiftKey ? 16 : 1;
    let delta = 0;
    if (event.key === "ArrowUp" || event.key === "ArrowRight") delta = 1;
    else if (event.key === "ArrowDown" || event.key === "ArrowLeft") delta = -1;
    else if (event.key === "Home") delta = -1e6;
    else if (event.key === "End") delta = 1e6;
    else return;
    event.preventDefault();
    const step = codeToSample(delta * big, codeDivisor);
    onChange(
      kind === "low"
        ? normalizeLevels(Math.min(levels.low + step, levels.high - MIN_LEVEL_GAP), levels.high, fullScale)
        : normalizeLevels(levels.low, Math.max(levels.high + step, levels.low + MIN_LEVEL_GAP), fullScale),
    );
  };

  const lowCode = sampleToCode(levels.low, codeDivisor);
  const highCode = sampleToCode(levels.high, codeDivisor);

  return (
    <div className="level-wedge" data-disabled={disabled ? "true" : "false"} aria-label={t("canvas.wedge.label")}>
      <div className="level-wedge__plot">
        <div className="level-wedge__axis" aria-hidden="true">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="level-wedge__tick"
              style={{ bottom: `${valueToFraction(codeToSample(tick, codeDivisor), domain) * 100}%` }}
            >
              {tick}
            </span>
          ))}
        </div>

        <div className="level-wedge__hist-and-bar">
          <svg
            className="level-wedge__hist"
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d={histogramPath} />
          </svg>
          <div
            ref={barRef}
            className="level-wedge__bar"
            title={t("canvas.wedge.hint")}
            onDoubleClick={() => !disabled && onAuto()}
          >
            {/* Gradient actually used by the image: black below the black level, white above the white level. */}
            <div
              className="level-wedge__gradient"
              style={{
                background: `linear-gradient(to top, #000 0%, #000 ${lowFrac * 100}%, #fff ${highFrac * 100}%, #fff 100%)`,
              }}
            />
          </div>
          <div
            className="level-wedge__region"
            style={{ bottom: `${lowFrac * 100}%`, height: `${Math.max(0, highFrac - lowFrac) * 100}%` }}
            onPointerDown={beginDrag("region")}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={() => !disabled && onAuto()}
            title={t("canvas.wedge.region")}
          />
          <div className="level-wedge__line level-wedge__line--high" style={{ bottom: `${highFrac * 100}%` }} />
          <div className="level-wedge__line level-wedge__line--low" style={{ bottom: `${lowFrac * 100}%` }} />
          <div
            className="level-wedge__handle level-wedge__handle--high"
            style={{ bottom: `${highFrac * 100}%` }}
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-orientation="vertical"
            aria-label={t("canvas.wedge.white")}
            aria-valuemin={sampleToCode(domain.min, codeDivisor)}
            aria-valuemax={sampleToCode(domain.max, codeDivisor)}
            aria-valuenow={highCode}
            title={`${t("canvas.wedge.white")}: ${highCode}`}
            onPointerDown={beginDrag("high")}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={nudge("high")}
          />
          <div
            className="level-wedge__handle level-wedge__handle--low"
            style={{ bottom: `${lowFrac * 100}%` }}
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-orientation="vertical"
            aria-label={t("canvas.wedge.black")}
            aria-valuemin={sampleToCode(domain.min, codeDivisor)}
            aria-valuemax={sampleToCode(domain.max, codeDivisor)}
            aria-valuenow={lowCode}
            title={`${t("canvas.wedge.black")}: ${lowCode}`}
            onPointerDown={beginDrag("low")}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={nudge("low")}
          />
        </div>
      </div>

      <div className="level-wedge__readout" aria-live="polite">
        <span title={t("canvas.wedge.white")}>▲ {highCode}</span>
        <span title={t("canvas.wedge.black")}>▽ {lowCode}</span>
      </div>
      <button
        type="button"
        className="level-wedge__auto"
        aria-pressed={auto}
        disabled={disabled}
        title={t("canvas.wedge.autoTitle")}
        onClick={onAuto}
      >
        {t("canvas.wedge.auto")}
      </button>
    </div>
  );
}
