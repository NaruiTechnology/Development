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
import {
  Component,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { Header } from "./components/Header";
import type { SignedInUser } from "./components/AuthDialog";
import { Footer } from "./components/Footer";
import { ScanControls } from "./components/ScanControls";
import { RasterParameters } from "./components/RasterParameters";
import { VectorParameters } from "./components/VectorParameters";
import { ImageCanvas } from "./components/ImageCanvas";
import { ValidationPanel } from "./components/ValidationPanel";
import { ROIEditor } from "./components/ROIEditor";
import { ROIScanPreview } from "./components/ROIScanPreview";
import { ErrorWedge } from "./components/ErrorWedge";
import { Icon } from "./components/Icon";
import { SettingsDialog } from "./components/SettingsDialog";
import { ManagementReport } from "./components/ManagementReport";

import { setKind, streamReset, type ScanKind } from "./store/scanSlice";
import { resetRaster, resetVector } from "./store/imageSlice";
import { fetchDefaults } from "./store/statusSlice";
import { useAppDispatch, useAppSelector } from "./store";
import { useTranslation } from "./i18n";

const RIGHT_PANEL_STORAGE_KEY = "ionbeam:rightPanelWidth";
const DEFAULT_RIGHT_PANEL_WIDTH = 720;
const MIN_LEFT_PANEL_WIDTH = 320;
const MIN_RIGHT_PANEL_WIDTH = 380;
const SPLITTER_SPACE = 32;
type AppRoute = "control" | "report";

export function App() {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const mainRef = useRef<HTMLElement | null>(null);
  const route = useAppRoute();
  const kind = useAppSelector((s) => s.scan.kind);
  const phase = useAppSelector((s) => s.scan.phase);
  const rasterResolution = useAppSelector((s) => s.scan.raster.resolution);
  const rasterCursor = useAppSelector((s) => s.image.cursor);
  const vectorCursor = useAppSelector((s) => s.image.vectorCursor);
  const imageRevision = useAppSelector((s) => s.image.revision);
  const lastResult = useAppSelector((s) => s.scan.lastResult);
  const vectorRenderMode = useAppSelector((s) => s.scan.vectorRenderMode);
  const roiState = useAppSelector((s) => s.scan.roi);
  const [lastScanKind, setLastScanKind] = useState<Extract<ScanKind, "raster" | "vector">>("raster");
  const [rightPanelWidth, setRightPanelWidth] = useState(() => {
    const raw = window.localStorage.getItem(RIGHT_PANEL_STORAGE_KEY);
    const parsed = raw ? Number(raw) : DEFAULT_RIGHT_PANEL_WIDTH;
    return Number.isFinite(parsed) ? parsed : DEFAULT_RIGHT_PANEL_WIDTH;
  });
  const [isResizing, setIsResizing] = useState(false);
  const [signedInUser, setSignedInUser] = useState<SignedInUser | null>(() => {
    const raw = window.localStorage.getItem("ionbeam:adminUser");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SignedInUser;
    } catch {
      return null;
    }
  });
  const hasPartialROI = isPartialROISelection(roiState);
  const isSignedIn = Boolean(signedInUser);

  useEffect(() => {
    dispatch(fetchDefaults());
  }, [dispatch]);

  useEffect(() => {
    if (!signedInUser) return;
    let cancelled = false;

    fetch("/api/admin/iobeam/auth/current-account")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { login?: unknown; registered?: unknown; session_expired?: unknown } | null) => {
        if (cancelled || !data) return;
        const currentLogin = String(data.login ?? "").toLowerCase();
        const signedInLogin = signedInUser.login_name.toLowerCase();
        if (!data.registered || data.session_expired === true || currentLogin !== signedInLogin) {
          window.localStorage.removeItem("ionbeam:adminUser");
          setSignedInUser(null);
        }
      })
      .catch(() => {
        // Keep the existing session if the startup account check is temporarily unavailable.
      });

    return () => {
      cancelled = true;
    };
  }, [signedInUser]);

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
        rect.width - MIN_LEFT_PANEL_WIDTH - SPLITTER_SPACE - (hasPartialROI ? 236 : 0)
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
  }, [isResizing, hasPartialROI]);

  const scanActive = phase === "running" || phase === "stopping";
  const panelDisabled = scanActive || !isSignedIn;
  const hasPriorScanImage =
    (lastScanKind === "raster" && rasterCursor > 0) ||
    (lastScanKind === "vector" && vectorCursor > 0) ||
    lastResult?.kind === lastScanKind;
  const roiScanImageUrl =
    kind === "roi" && hasPriorScanImage
      ? lastScanKind === "vector"
        ? `/api/scan/last/figure?render=${encodeURIComponent(vectorRenderMode)}&view=texture&_=${imageRevision}`
        : `/api/scan/last/figure?view=texture&_=${imageRevision}`
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

  function navigateTo(nextRoute: AppRoute) {
    const nextPath = `/${nextRoute}`;
    if (window.location.pathname === nextPath) return;
    window.history.pushState(null, "", nextPath);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  function resizeRightPanel(delta: number) {
    const main = mainRef.current;
    if (!main) return;
    const rect = main.getBoundingClientRect();
    const maxRight = Math.max(
      MIN_RIGHT_PANEL_WIDTH,
      rect.width - MIN_LEFT_PANEL_WIDTH - SPLITTER_SPACE - (hasPartialROI ? 236 : 0)
    );
    const next = Math.min(maxRight, Math.max(MIN_RIGHT_PANEL_WIDTH, rightPanelWidth + delta));
    setRightPanelWidth(next);
    window.localStorage.setItem(RIGHT_PANEL_STORAGE_KEY, String(Math.round(next)));
  }

  const layoutStyle = {
    "--right-panel-width": `${Math.round(rightPanelWidth)}px`,
  } as CSSProperties;

  // The image-panel title key flips with the active tab. Picking it
  // up front rather than inline below means the JSX stays readable.
  const imagePanelTitleKey =
    kind === "raster"
      ? "card.rasterImage"
      : kind === "vector"
      ? "card.vectorPattern"
      : "card.selectROI";

  return (
    <div className="app-shell">
      <Header
        signedInUser={signedInUser}
        onSignedIn={setSignedInUser}
        activeView={route}
        onOpenReport={() => navigateTo("report")}
        onOpenScan={() => navigateTo("control")}
      />

      {route === "report" ? (
        <ReportErrorBoundary>
          <ManagementReport onBack={() => navigateTo("control")} />
        </ReportErrorBoundary>
      ) : (
      <main
        ref={mainRef}
        className={`app-main${isResizing ? " app-main--resizing" : ""}${
          hasPartialROI ? " app-main--with-roi-preview" : ""
        }`}
        style={layoutStyle}
      >
        {/* left column */}
        <section>
          <div className="card">
            <div className="tabs" role="tablist" aria-label={t("tabs.aria")}>
              <button
                role="tab"
                className="tab tab--roi"
                aria-selected={kind === "roi"}
                disabled={panelDisabled}
                onClick={() => selectKind("roi")}
                title={panelDisabled ? t("tabs.roi.title.disabled") : t("tabs.roi.title")}
              >
                <Icon name="target" tone="tab" />
                {t("tabs.roi")}
              </button>
              <button
                role="tab"
                className="tab"
                aria-selected={kind === "raster"}
                disabled={panelDisabled}
                onClick={() => selectKind("raster")}
              >
                <Icon name="grid" tone="tab" />
                {t("tabs.raster")}
              </button>
              <button
                role="tab"
                className="tab"
                aria-selected={kind === "vector"}
                disabled={panelDisabled}
                onClick={() => selectKind("vector")}
              >
                <Icon name="route" tone="tab" />
                {t("tabs.vector")}
              </button>
            </div>
            <div className="card__body">
              {kind === "raster" ? (
                <RasterParameters disabled={panelDisabled} />
              ) : kind === "vector" ? (
                <VectorParameters disabled={panelDisabled} />
              ) : (
                <ROIEditor disabled={panelDisabled} variant="controls" />
              )}
            </div>
          </div>

          {kind !== "roi" && (
            <>
              <div className="card">
                <div className="card__header">
                  <span className="card__title">{t("card.controls")}</span>
                </div>
                <div className="card__body">
                  <ScanControls kind={kind as ScanKind} disabled={panelDisabled} />
                </div>
              </div>
              <div className="card">
                <div className="card__header">
                  <span className="card__title">{t("card.runReport")}</span>
                </div>
                <ValidationPanel disabled={!isSignedIn} />
              </div>
              <ErrorWedge />
            </>
          )}
        </section>

        <div
          className="panel-resizer"
          role="separator"
          aria-label={t("card.rasterImage")  /* generic; not user-visible string */}
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
              <span className="card__title">{t(imagePanelTitleKey)}</span>
            </div>
            <div className="card__body">
              {kind === "roi" ? (
                <ROIEditor
                  disabled={panelDisabled}
                  variant="canvas"
                  backgroundImageUrl={roiScanImageUrl}
                />
              ) : (
                <ImageCanvas kind={kind as ScanKind} />
              )}
            </div>
          </div>

        </section>

        {hasPartialROI && (
          <section className="roi-preview-column">
            <div className="card roi-preview-card">
              <div className="card__header">
                <span className="card__title">{t("card.roiPreview")}</span>
              </div>
              <div className="card__body">
                <ROIScanPreview backgroundImageUrl={roiScanImageUrl} />
              </div>
            </div>
          </section>
        )}
      </main>
      )}

      <SettingsDialog />
      <Footer />
    </div>
  );
}

function useAppRoute(): AppRoute {
  const [route, setRoute] = useState<AppRoute>(() => normalizeRoute(window.location.pathname));

  useEffect(() => {
    const normalized = normalizeRoute(window.location.pathname);
    if (window.location.pathname !== `/${normalized}`) {
      window.history.replaceState(null, "", `/${normalized}`);
    }

    function onPopState() {
      setRoute(normalizeRoute(window.location.pathname));
    }

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return route;
}

function normalizeRoute(pathname: string): AppRoute {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === "/report" ? "report" : "control";
}

class ReportErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="management-report">
        <div className="report-error">
          Report rendering failed: {this.state.error.message}
        </div>
      </main>
    );
  }
}

function isPartialROISelection(roi: {
  x_origin: number;
  x_end: number;
  y_origin: number;
  y_end: number;
  selection: {
    x_start: number;
    x_end: number;
    y_start: number;
    y_end: number;
  } | null;
}): boolean {
  const sel = roi.selection;
  if (!sel) return false;

  const x0 = Math.min(roi.x_origin, roi.x_end);
  const x1 = Math.max(roi.x_origin, roi.x_end);
  const y0 = Math.min(roi.y_origin, roi.y_end);
  const y1 = Math.max(roi.y_origin, roi.y_end);
  const sx0 = Math.min(sel.x_start, sel.x_end);
  const sx1 = Math.max(sel.x_start, sel.x_end);
  const sy0 = Math.min(sel.y_start, sel.y_end);
  const sy1 = Math.max(sel.y_start, sel.y_end);

  return sx0 > x0 || sx1 < x1 || sy0 > y0 || sy1 < y1;
}
