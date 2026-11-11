import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAppSelector } from "../store";
import { useTranslation } from "../i18n";
import { placeCompletedScan, type ImagePanelLayout } from "../lib/imagePanelLayout";
import { Icon } from "./Icon";
import { ImagePanelLayoutControls } from "./ImagePanelLayoutControls";

/** Freeze the displayed pixels and pattern shapes without touching acquisition. */
export async function captureProcessingCanvas(root: HTMLElement): Promise<string | null> {
  const wrap = root.querySelector<HTMLElement>(".roi-canvas-wrap");
  const base = wrap?.querySelector<HTMLCanvasElement>(".roi-canvas-layer--base");
  if (!wrap || !base || !base.width || !base.height) return null;
  const copy = document.createElement("canvas");
  copy.width = base.width;
  copy.height = base.height;
  const context = copy.getContext("2d");
  if (!context) return null;
  const transform = getComputedStyle(wrap).transform;
  if (transform && transform !== "none") {
    const matrix = new DOMMatrix(transform);
    context.translate(copy.width / 2, copy.height / 2);
    context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    context.translate(-copy.width / 2, -copy.height / 2);
  }
  for (const canvas of wrap.querySelectorAll<HTMLCanvasElement>("canvas")) {
    if (canvas.width && canvas.height && getComputedStyle(canvas).display !== "none") {
      context.drawImage(canvas, 0, 0, copy.width, copy.height);
    }
  }
  const pattern = wrap.querySelector<SVGSVGElement>(".roi-pattern-overlay");
  if (pattern) {
    const clone = pattern.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(copy.width));
    clone.setAttribute("height", String(copy.height));
    const svg = new XMLSerializer().serializeToString(clone);
    await new Promise<void>((resolve, reject) => {
      const image = new Image();
      image.onload = () => { context.drawImage(image, 0, 0, copy.width, copy.height); resolve(); };
      image.onerror = () => reject(new Error("Could not capture the Processing pattern overlay"));
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
  }
  const scale = root.querySelector<HTMLElement>(".canvas-image-scale");
  const fraction = Number(scale?.dataset.scaleFraction);
  if (scale && Number.isFinite(fraction) && fraction > 0) {
    context.save(); context.resetTransform();
    const length = fraction * copy.width;
    const right = copy.width - 14;
    const bottom = copy.height - 14;
    context.strokeStyle = context.fillStyle = "#fff"; context.lineWidth = 1;
    context.beginPath(); context.moveTo(right - length, bottom); context.lineTo(right, bottom);
    context.moveTo(right - length, bottom - 4); context.lineTo(right - length, bottom + 4);
    context.moveTo(right, bottom - 4); context.lineTo(right, bottom + 4); context.stroke();
    context.font = "11px monospace"; context.textAlign = "center";
    context.fillText(scale.dataset.scaleLabel ?? "", right - length / 2, bottom - 10);
    context.restore();
  }
  return copy.toDataURL("image/png");
}

export function ProcessingImagePanel({ children, headerHost, capture = captureProcessingCanvas }: {
  children: ReactNode; headerHost: HTMLElement | null; capture?: typeof captureProcessingCanvas;
}) {
  const { t } = useTranslation();
  const phase = useAppSelector((s) => s.scan.phase);
  const [layout, setLayout] = useState<ImagePanelLayout>(1);
  const [locked, setLocked] = useState(true);
  const [slots, setSlots] = useState<Array<string | null>>([null]);
  const [selected, setSelected] = useState(0);
  const [target, setTarget] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef<HTMLDivElement | null>(null);
  const saved = useRef<{ layout: ImagePanelLayout; slots: Array<string | null>; selected: number; target: number } | null>(null);
  const state = useRef({ layout, slots, selected, target, locked });
  state.current = { layout, slots, selected, target, locked };
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const split = useCallback(async () => {
    if (pending.current || state.current.layout !== 1) return;
    setLocked(true);
    if (saved.current) {
      const prior = saved.current;
      setLayout(prior.layout); setSlots(prior.slots); setSelected(prior.selected); setTarget(prior.target);
      saved.current = null;
      return;
    }
    pending.current = true;
    setBusy(true); setError(null);
    try {
      const image = live.current ? await capture(live.current) : null;
      if (!mounted.current) return;
      setSlots([image, null]); setLayout(2); setTarget(image ? 1 : 0); setSelected(image ? 1 : 0);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [capture]);
  const previousPhase = useRef(phase);
  useEffect(() => {
    const before = previousPhase.current;
    previousPhase.current = phase;
    if (state.current.layout === 1) return;
    if (phase === "running" && before !== "running") setTarget(state.current.selected);
    if ((before !== "running" && before !== "stopping") || phase === "running" || phase === "stopping" || phase === "error") return;
    let cancelled = false;
    void (async () => {
      const image = live.current ? await capture(live.current) : null;
      if (!image || cancelled || !mounted.current) return;
      const current = state.current;
      const placed = placeCompletedScan({ slots: current.slots, layout: current.layout,
        selectedPane: current.target, locked: current.locked, imageUrl: image });
      setSlots(placed.slots); setLayout(placed.layout); setSelected(placed.selectedPane); setTarget(placed.selectedPane);
    })().catch((cause) => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [phase, capture]);
  const controls = <ImagePanelLayoutControls layout={layout} locked={locked} busy={busy} splitDisabled
    controlsId="processing-image-panel-grid" onSplit={() => void split()} onLockedChange={(value) => {
      setLocked(value);
      if (!value && layout > 1) {
        saved.current = { layout, slots, selected, target };
        setLayout(1); setTarget(0); setSelected(0);
      }
    }} />;
  return <>
    {headerHost ? createPortal(controls, headerHost) : controls}
    {error && <p className="scan-inline-error" role="alert">{error}</p>}
    <div id="processing-image-panel-grid" className={`image-panel-grid image-panel-grid--${layout}`}>
      {Array.from({ length: layout }, (_, index) => index).filter((index) => index !== target).map((index) =>
        <div key={index} className="image-panel-grid__tile" data-selected={selected === index ? "true" : "false"}
          style={{ order: index }} onClick={() => setSelected(index)}>
          <div className="image-panel-grid__label"><span>{t("canvas.layout.previous", { number: index + 1 })}</span>
            <button type="button" className="btn btn--ghost image-panel-grid__recycle"
              title={t("canvas.layout.recycle", { number: index + 1 })}
              aria-label={t("canvas.layout.recycle", { number: index + 1 })}
              onClick={(event) => { event.stopPropagation(); setSlots((items) => items.map((item, i) => i === index ? null : item)); }}>
              <Icon name="trash" tone="danger" />
            </button>
          </div>
          {slots[index] ? <img className="image-panel-grid__image" src={slots[index]!}
            alt={t("canvas.layout.previous", { number: index + 1 })} />
            : <div className="image-panel-grid__empty">{t("canvas.layout.empty", { number: index + 1 })}</div>}
        </div>)}
      <div key="live" ref={live} className={`image-panel-grid__target${layout === 1 ? " image-panel-grid__target--single" : ""}`} style={{ order: target }}
        data-selected={selected === target ? "true" : "false"} onClick={() => setSelected(target)}>
        {layout > 1 && <div className="image-panel-grid__label">{t("canvas.layout.target")}</div>}
        {children}
      </div>
    </div>
  </>;
}
