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
import { useEffect, useState } from "react";

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

export function App() {
  const dispatch = useAppDispatch();
  const kind = useAppSelector((s) => s.scan.kind);
  const phase = useAppSelector((s) => s.scan.phase);
  const rasterResolution = useAppSelector((s) => s.scan.raster.resolution);
  const rasterCursor = useAppSelector((s) => s.image.cursor);
  const vectorCursor = useAppSelector((s) => s.image.vectorCursor);
  const lastResult = useAppSelector((s) => s.scan.lastResult);
  const vectorRenderMode = useAppSelector((s) => s.scan.vectorRenderMode);
  const [lastScanKind, setLastScanKind] = useState<Extract<ScanKind, "raster" | "vector">>("raster");

  useEffect(() => {
    dispatch(fetchDefaults());
  }, [dispatch]);

  useEffect(() => {
    if (kind === "raster" || kind === "vector") {
      setLastScanKind(kind);
    }
  }, [kind]);

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

  return (
    <div className="app-shell">
      <Header />

      <main className="app-main">
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

        {/* right column */}
        <section>
          <div className="card">
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
