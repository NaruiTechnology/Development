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
import { useEffect } from "react";

import { Header } from "./components/Header";
import { Footer } from "./components/Footer";
import { ScanControls } from "./components/ScanControls";
import { RasterParameters } from "./components/RasterParameters";
import { VectorParameters } from "./components/VectorParameters";
import { ImageCanvas } from "./components/ImageCanvas";
import { ValidationPanel } from "./components/ValidationPanel";

import { setKind, type ScanKind } from "./store/scanSlice";
import { fetchDefaults } from "./store/statusSlice";
import { useAppDispatch, useAppSelector } from "./store";

export function App() {
  const dispatch = useAppDispatch();
  const kind = useAppSelector((s) => s.scan.kind);
  const phase = useAppSelector((s) => s.scan.phase);

  useEffect(() => {
    dispatch(fetchDefaults());
  }, [dispatch]);

  const formDisabled = phase === "running" || phase === "stopping";

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
                className="tab"
                aria-selected={kind === "raster"}
                onClick={() => dispatch(setKind("raster"))}
              >
                Raster
              </button>
              <button
                role="tab"
                className="tab"
                aria-selected={kind === "vector"}
                onClick={() => dispatch(setKind("vector"))}
              >
                Vector
              </button>
            </div>
            <div className="card__body">
              {kind === "raster" ? (
                <RasterParameters disabled={formDisabled} />
              ) : (
                <VectorParameters disabled={formDisabled} />
              )}
            </div>
          </div>

          <div className="card">
            <div className="card__header">
              <span className="card__title">Controls</span>
            </div>
            <div className="card__body">
              <ScanControls kind={kind as ScanKind} />
            </div>
          </div>
        </section>

        {/* right column */}
        <section>
          <div className="card">
            <div className="card__header">
              <span className="card__title">
                {kind === "raster" ? "Raster image" : "Vector pattern"}
              </span>
            </div>
            <div className="card__body">
              <ImageCanvas kind={kind as ScanKind} />
            </div>
          </div>

          <div className="card">
            <div className="card__header">
              <span className="card__title">Run report</span>
            </div>
            <ValidationPanel />
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
