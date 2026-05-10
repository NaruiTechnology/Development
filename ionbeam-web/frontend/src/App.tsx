/**
 * Top-level layout. Two columns:
 *
 *   left  — scan kind tabs, parameter form, controls
 *   right — image canvas, then validation panel
 *
 * Mirrors the panel split in the existing PyQt GUI's Base/launcher.py
 * but pulls everything into one window because there is no off-screen
 * "console" surface in a browser context.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { Header } from "./components/Header";
import { Footer } from "./components/Footer";
import { ScanControls } from "./components/ScanControls";
import { RasterParameters } from "./components/RasterParameters";
import { VectorParameters } from "./components/VectorParameters";
import { ImageCanvas } from "./components/ImageCanvas";
import { ValidationPanel } from "./components/ValidationPanel";
import { ROIEditor } from "./components/ROIEditor";
import { ErrorWedge } from "./components/ErrorWedge";
import { Icon } from "./components/Icon";

import { setKind, streamReset, type ScanKind } from "./store/scanSlice";
import { resetRaster, resetVector } from "./store/imageSlice";
import { fetchDefaults } from "./store/statusSlice";
import { useAppDispatch, useAppSelector } from "./store";

const RIGHT_PANEL_STORAGE_KEY = "ionbeam:rightPanelWidth";
const DEFAULT_RIGHT_PANEL_WIDTH = 720;
const MIN_LEFT_PANEL_WIDTH = 320;
const MIN_RIGHT_PANEL_WIDTH = 380;
const SPLITTER_SPACE = 32;

export function App() {
  const dispatch = useAppDispatch();
  const mainRef = useRef<HTMLElement | null>(null);
  const kind = useAppSelector((s) => s.scan.kind);
  const phase = useAppSelector((s) => s.scan.phase);
  const rasterResolution = useAppSelector((s) => s.scan.raster.resolution);
  const rasterCursor = useAppSelector((s) => s.image.cursor);
  const vectorCursor = useAppSelector((s) => s.image.vectorCursor);
  const lastResult = useAppSelector((s) => s.scan.lastResult);
  const vectorRenderMode = useAppSelector((s) => s.scan.vectorRenderMode);
  const [lastScanKind, setLastScanKind] = useState<Extract<ScanKind, "raster" | "vector">>("raster");
  const [rightPanelWidth, setRightPanelWidth] = useState(() => {
    const raw = window.localStorage.getItem(RIGHT_PANEL_STORAGE_KEY);
    const parsed = raw ? Number(raw) : DEFAULT_RIGHT_PANEL_WIDTH;
    return Number.isFinite(parsed) ? parsed : DEFAULT_RIGHT_PANEL_WIDTH;
  });
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    dispatch(fetchDefaults());
  }, [dispatch]);

  useEffect(() => {
    if (kind === "raster" || kind === "vector") {
      setLastScanKind(kind);
    }
  }, [kind]);

  useEffect(() => {
    if (!isResizing) return;

    function resizeFromPointer(clientX: number) {
      const main = mainRef.current;
      if (!main) return;
      const rect = main.getBoundingClientRect();
      const maxRight = Math.max(
        MIN_RIGHT_PANEL_WIDTH,
        rect.width - MIN_LEFT_PANEL_WIDTH - SPLITTER_SPACE
      );
      const next = Math.min(
        maxRight,
        Math.max(MIN_RIGHT_PANEL_WIDTH, rect.right - clientX)
      );
      setRightPanelWidth(next);
      window.localStorage.setItem(RIGHT_PANEL_STORAGE_KEY, String(Math.round(next)));
    }

    function onPointerMove(event: PointerEvent) {
      event.preventDefault();
      resizeFromPointer(event.clientX);
    }

    function onPointerUp() {
      setIsResizing(false);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [isResizing]);

  const scanActive = phase === "running" || phase === "stopping";
  const formDisabled = scanActive;
  const hasPriorScanImage =
    (lastScanKind === "raster" && rasterCursor > 0) ||
    (lastScanKind === "vector" && vectorCursor > 0) ||
    lastResult?.kind === lastScanKind;
  const roiScanImageUrl =
    kind === "roi" && hasPriorScanImage
      ? lastScanKind === "vector"
        ? `/api/scan/last/figure?render=${encodeURIComponent(vectorRenderMode)}&view=texture&_=${vectorCursor}`
        : `/api/scan/last/figure?view=texture&_=${rasterCursor}`
      : null;

  function selectKind(nextKind: ScanKind) {
    if (nextKind === kind) return;
    if (scanActive) return;

    const nextScanKind = nextKind === "raster" || nextKind === "vector" ? nextKind : null;
    const currentScanKind = kind === "raster" || kind === "vector" ? kind : hasPriorScanImage ? lastScanKind : null;

    if (currentScanKind && nextScanKind && currentScanKind !== nextScanKind) {
      dispatch(streamReset());
      dispatch(resetRaster({ resolution: rasterResolution }));
      dispatch(resetVector());
    }

    dispatch(setKind(nextKind));
  }

  function resizeRightPanel(delta: number) {
    const main = mainRef.current;
    if (!main) return;
    const rect = main.getBoundingClientRect();
    const maxRight = Math.max(
      MIN_RIGHT_PANEL_WIDTH,
      rect.width - MIN_LEFT_PANEL_WIDTH - SPLITTER_SPACE
    );
    const next = Math.min(maxRight, Math.max(MIN_RIGHT_PANEL_WIDTH, rightPanelWidth + delta));
    setRightPanelWidth(next);
    window.localStorage.setItem(RIGHT_PANEL_STORAGE_KEY, String(Math.round(next)));
  }

  const layoutStyle = {
    "--right-panel-width": `${Math.round(rightPanelWidth)}px`,
  } as CSSProperties;

  return (
    <div className="app-shell">
      <Header />

      <main
        ref={mainRef}
        className={`app-main${isResizing ? " app-main--resizing" : ""}`}
        style={layoutStyle}
      >
        {/* left column */}
        <section>
          <div className="card">
            <div className="tabs" role="tablist" aria-label="Scan kind">
              <button
                role="tab"
                className="tab tab--roi"
                aria-selected={kind === "roi"}
                disabled={scanActive}
                onClick={() => selectKind("roi")}
                title={scanActive ? "ROI is inactive while a scan is running" : "Edit ROI"}
              >
                <Icon name="target" tone="tab" />
                ROI
              </button>
              <button
                role="tab"
                className="tab"
                aria-selected={kind === "raster"}
                disabled={scanActive}
                onClick={() => selectKind("raster")}
              >
                <Icon name="grid" tone="tab" />
                Raster
              </button>
              <button
                role="tab"
                className="tab"
                aria-selected={kind === "vector"}
                disabled={scanActive}
                onClick={() => selectKind("vector")}
              >
                <Icon name="route" tone="tab" />
                Vector
              </button>
            </div>
            <div className="card__body">
              {kind === "raster" ? (
                <RasterParameters disabled={formDisabled} />
              ) : kind === "vector" ? (
                <VectorParameters disabled={formDisabled} />
              ) : (
                <ROIEditor disabled={formDisabled} variant="controls" />
              )}
            </div>
          </div>

          {kind !== "roi" && (
            <>
              <div className="card">
                <div className="card__header">
                  <span className="card__title">Controls</span>
                </div>
                <div className="card__body">
                  <ScanControls kind={kind as ScanKind} />
                </div>
              </div>
              <div className="card">
                <div className="card__header">
                  <span className="card__title">Run report</span>
                </div>
                <ValidationPanel />
              </div>
              <ErrorWedge />
            </>
          )}
        </section>

        <div
          className="panel-resizer"
          role="separator"
          aria-label="Resize image panel"
          aria-orientation="vertical"
          tabIndex={0}
          onPointerDown={(event) => {
            if (window.matchMedia("(max-width: 1024px)").matches) return;
            event.preventDefault();
            setIsResizing(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              resizeRightPanel(32);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              resizeRightPanel(-32);
            } else if (event.key === "Home") {
              event.preventDefault();
              resizeRightPanel(9999);
            } else if (event.key === "End") {
              event.preventDefault();
              resizeRightPanel(-9999);
            }
          }}
        />

        {/* right column */}
        <section>
          <div className="card image-panel-card">
            <div className="card__header">
              <span className="card__title">
                {kind === "raster" ? "Raster image" : kind === "vector" ? "Vector pattern" : "ROI preview"}
              </span>
            </div>
            <div className="card__body">
              {kind === "roi" ? (
                <ROIEditor
                  disabled={formDisabled}
                  variant="canvas"
                  backgroundImageUrl={roiScanImageUrl}
                />
              ) : (
                <ImageCanvas kind={kind as ScanKind} />
              )}
            </div>
          </div>

        </section>
      </main>

      <Footer />
    </div>
  );
}
