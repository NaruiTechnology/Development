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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { Header } from "./components/Header";
import type { SignedInUser } from "./components/AuthDialog";
import { apiUrl } from "./lib/backendUrl";
import { readJsonResponse } from "./lib/readJsonResponse";
import { Footer } from "./components/Footer";
import { ScanControls } from "./components/ScanControls";
import { RasterParameters } from "./components/RasterParameters";
import { VectorParameters } from "./components/VectorParameters";
import { ImageCanvas } from "./components/ImageCanvas";
import { ValidationPanel } from "./components/ValidationPanel";
import { ROIEditor } from "./components/ROIEditor";
import { ROIScanPreview } from "./components/ROIScanPreview";
import { ROICalibrationCard } from "./components/ROICalibrationCard";
import { MagCalibrationChart, MagCalibrationControls } from "./components/MagCalibration";
import { GrayScaleHelp } from "./components/GrayScaleHelp";
import { ErrorWedge } from "./components/ErrorWedge";
import { Icon } from "./components/Icon";
import { SettingsDialog } from "./components/SettingsDialog";
import { ManagementReport } from "./components/ManagementReport";
import { grayScaleSpectrumLevelsForSelection } from "./lib/bitmapVector";

import {
  persistGrayScaleStepDelta,
  setKind,
  setROIGrayScaleSelection,
  updateROI,
  streamReset,
  type ScanKind,
} from "./store/scanSlice";
import { resetRaster, resetVector } from "./store/imageSlice";
import { fetchDefaults } from "./store/statusSlice";
import { useAppDispatch, useAppSelector } from "./store";
import { useTranslation } from "./i18n";
import { scanAuthHeaders } from "./lib/authIdentity";
import { openDialog as openSettingsDialog, setActiveTab } from "./store/settingsSlice";

const RIGHT_PANEL_STORAGE_KEY = "ionbeam:rightPanelWidth";
const DEFAULT_RIGHT_PANEL_WIDTH = 720;
const MIN_LEFT_PANEL_WIDTH = 320;
const MIN_RIGHT_PANEL_WIDTH = 380;
const SPLITTER_SPACE = 32;
const LAST_ADMIN_LOGIN_STORAGE_KEY = "ionbeam:lastAdminLogin";
type AppRoute = "control" | "report";

export function App() {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const mainRef = useRef<HTMLElement | null>(null);
  const route = useAppRoute();
  const kind = useAppSelector((s) => s.scan.kind);
  const phase = useAppSelector((s) => s.scan.phase);
  const isProduction = useAppSelector((s) => s.status.defaults?.is_production === true);
  const rasterResolution = useAppSelector((s) => s.scan.raster.resolution);
  const rasterCursor = useAppSelector((s) => s.image.cursor);
  const vectorCursor = useAppSelector((s) => s.image.vectorCursor);
  const imageRevision = useAppSelector((s) => s.image.revision);
  const lastResult = useAppSelector((s) => s.scan.lastResult);
  const vectorRenderMode = useAppSelector((s) => s.scan.vectorRenderMode);
  const roiState = useAppSelector((s) => s.scan.roi);
  const committedGrayScaleSelection = useAppSelector((s) => s.scan.roiGrayScaleSelection);
  const committedGrayScaleSkipped = useAppSelector((s) => s.scan.roiGrayScaleSkipped);
  const committedGrayScaleStepDelta = useAppSelector((s) => s.scan.roiGrayScaleStepDelta);
  const [lastScanKind, setLastScanKind] = useState<Extract<ScanKind, "raster" | "vector">>("raster");
  const [lastLiveScanImage, setLastLiveScanImage] = useState<{
    kind: Extract<ScanKind, "raster" | "vector">;
    imageUrl: string;
  } | null>(null);
  const [pendingGrayScaleSelection, setPendingGrayScaleSelection] = useState<number | null>(committedGrayScaleSelection);
  const [pendingGrayScaleSkipped, setPendingGrayScaleSkipped] = useState<boolean | null>(committedGrayScaleSkipped);
  const [grayScaleLevels, setGrayScaleLevels] = useState<number[]>([]);
  const [grayScaleStepDelta, setGrayScaleStepDelta] = useState(committedGrayScaleStepDelta);
  const [grayScaleConfirmOpen, setGrayScaleConfirmOpen] = useState(false);
  const [mergedFigureByKind, setMergedFigureByKind] = useState<{
    raster: string | null;
    vector: string | null;
  }>({
    raster: null,
    vector: null,
  });
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
  const settingsTarget = useMemo(() => parseSettingsTarget(window.location.search), []);
  const hasPartialROI = isPartialROISelection(roiState);
  const showROICalibrationInControls = kind === "roi" && roiState.calibration_enabled;
  const showROIPreviewSideCard = kind === "roi" && hasPartialROI && !roiState.calibration_enabled;
  const isSignedIn = Boolean(signedInUser);

  useEffect(() => {
    dispatch(fetchDefaults());
  }, [dispatch]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("settings") !== "admin") return;
    dispatch(openSettingsDialog());
    dispatch(setActiveTab("admin"));
  }, [dispatch]);

  useEffect(() => {
    if (!signedInUser) return;
    if (!signedInUser.session_token) {
      window.localStorage.removeItem("ionbeam:adminUser");
      setSignedInUser(null);
      return;
    }
    let cancelled = false;

    fetch(apiUrl("/api/admin/iobeam/auth/current-account"), { headers: scanAuthHeaders() })
      .then(async (r) =>
        r.ok
          ? await readJsonResponse<{
              login?: unknown;
              registered?: unknown;
              session_expired?: unknown;
              user?: SignedInUser | null;
            }>(r, "current account")
          : null
      )
      .then((data: { login?: unknown; registered?: unknown; session_expired?: unknown; user?: SignedInUser | null } | null) => {
        if (cancelled || !data) return;
        const currentLogin = String(data.login ?? "").toLowerCase();
        const signedInLogin = signedInUser.login_name.toLowerCase();
        if (!data.registered || data.session_expired === true || currentLogin !== signedInLogin) {
          window.localStorage.setItem(LAST_ADMIN_LOGIN_STORAGE_KEY, signedInUser.login_name);
          window.localStorage.removeItem("ionbeam:adminUser");
          setSignedInUser(null);
          return;
        }
        if (data.user) {
          const refreshedUser = {
            ...data.user,
            session_token: signedInUser.session_token,
          };
          if (JSON.stringify(refreshedUser) !== JSON.stringify(signedInUser)) {
            window.localStorage.setItem("ionbeam:adminUser", JSON.stringify(refreshedUser));
            setSignedInUser(refreshedUser);
          }
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
        rect.width - MIN_LEFT_PANEL_WIDTH - SPLITTER_SPACE - (showROIPreviewSideCard ? 236 : 0)
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
  }, [isResizing, showROIPreviewSideCard]);

  const scanActive = phase === "running" || phase === "stopping";
  const panelDisabled = scanActive || !isSignedIn;
  const hasPriorScanImage =
    (lastScanKind === "raster" && rasterCursor > 0) ||
    (lastScanKind === "vector" && vectorCursor > 0) ||
    lastResult?.kind === lastScanKind;
  const serverScanImageUrl =
    lastScanKind === "vector"
      ? `/api/scan/last/figure?render=${encodeURIComponent(vectorRenderMode)}&view=texture&_=${imageRevision}`
      : `/api/scan/last/figure?view=texture&_=${imageRevision}`;
  const roiScanImageUrl =
    kind === "roi" && hasPriorScanImage
      ? lastLiveScanImage?.kind === lastScanKind
        ? lastLiveScanImage.imageUrl
        : serverScanImageUrl
      : null;
  const showGraySpectrum =
    kind === "roi" && hasPartialROI && Boolean(roiState.imageDataUrl || roiScanImageUrl);
  const grayScaleSourceKind: "raster" | "vector" | "loaded" | null =
    kind === "roi" && showGraySpectrum
      ? roiState.imageDataUrl
        ? "loaded"
        : roiScanImageUrl
        ? lastScanKind
        : null
      : null;
  const grayScaleSourceLabel =
    grayScaleSourceKind === "raster"
      ? t("roi.grayScale.source.raster")
      : grayScaleSourceKind === "vector"
      ? t("roi.grayScale.source.vector")
      : null;
  const grayScaleScopeNote =
    grayScaleSourceKind === "raster"
      ? isProduction
        ? t("roi.grayScale.context.raster.production")
        : t("roi.grayScale.context.raster.preview")
      : grayScaleSourceKind === "vector"
      ? t("roi.grayScale.context.vector")
      : null;

  useEffect(() => {
    if (!showGraySpectrum) {
      setPendingGrayScaleSelection(null);
      setGrayScaleLevels([]);
      setGrayScaleStepDelta(10);
    }
  }, [showGraySpectrum]);

  useEffect(() => {
    setPendingGrayScaleSelection(committedGrayScaleSelection);
  }, [committedGrayScaleSelection]);

  useEffect(() => {
    persistGrayScaleStepDelta(grayScaleStepDelta);
  }, [grayScaleStepDelta]);

  useEffect(() => {
    if (!showGraySpectrum) return;
    let cancelled = false;
    void (async () => {
      const spectrumROI = roiState.imageDataUrl
        ? roiState
        : roiScanImageUrl
        ? { ...roiState, imageDataUrl: roiScanImageUrl }
        : roiState;
      const levels = await grayScaleSpectrumLevelsForSelection(spectrumROI);
      if (cancelled) return;
      setGrayScaleLevels(levels);
      setPendingGrayScaleSelection((current) => (current !== null && levels.includes(current) ? current : null));
    })();
    return () => {
      cancelled = true;
    };
  }, [roiScanImageUrl, roiState, showGraySpectrum]);

  useEffect(() => {
    if (kind !== "roi") return;
    if (!roiScanImageUrl) return;
    if (roiState.imageKind === "lastScan" && roiState.imageDataUrl === roiScanImageUrl) return;
    dispatch(
      updateROI({
        imageName: t("roi.imageName.lastScan"),
        imageDataUrl: roiScanImageUrl,
        imageKind: "lastScan",
      })
    );
  }, [dispatch, kind, roiScanImageUrl, roiState.imageDataUrl, roiState.imageKind, t]);

  const handleRenderedImageChange = useCallback(
    (scanKind: Extract<ScanKind, "raster" | "vector">, imageUrl: string | null) => {
      setLastLiveScanImage((current) => {
        if (!imageUrl) return current?.kind === scanKind ? null : current;
        return { kind: scanKind, imageUrl };
      });
    },
    []
  );

  const handleMergedFigureChange = useCallback(
    (scanKind: Extract<ScanKind, "raster" | "vector">, imageUrl: string | null) => {
      setMergedFigureByKind((current) =>
        current[scanKind] === imageUrl ? current : { ...current, [scanKind]: imageUrl }
      );
    },
    []
  );

  const handleGrayScaleSelect = useCallback((grayScale: number | null) => {
    setPendingGrayScaleSelection(grayScale);
    if (grayScale !== null) {
      setPendingGrayScaleSkipped((current) => current ?? committedGrayScaleSkipped ?? true);
    }
  }, [committedGrayScaleSkipped]);

  const handleGrayScaleStepDeltaChange = useCallback((nextStepDelta: number) => {
    const n = Number(nextStepDelta);
    if (!Number.isFinite(n)) return;
    setGrayScaleStepDelta(Math.max(1, Math.min(255, Math.round(n))));
  }, []);

  const handleGrayScaleConfirm = useCallback(() => {
    if (pendingGrayScaleSelection === null) return;
    setGrayScaleConfirmOpen(true);
  }, [pendingGrayScaleSelection]);

  const handleGrayScaleConfirmAccept = useCallback(() => {
    if (pendingGrayScaleSelection === null) return;
    dispatch(
      setROIGrayScaleSelection({
        selection: pendingGrayScaleSelection,
        isSkipped: pendingGrayScaleSkipped,
      })
    );
    setGrayScaleConfirmOpen(false);
  }, [dispatch, pendingGrayScaleSelection, pendingGrayScaleSkipped]);

  const handleGrayScaleClear = useCallback(() => {
    dispatch(
      setROIGrayScaleSelection({
        selection: null,
        isSkipped: null,
      })
    );
    setPendingGrayScaleSelection(null);
    setPendingGrayScaleSkipped(null);
    setGrayScaleConfirmOpen(false);
  }, [dispatch]);

  function selectKind(nextKind: ScanKind) {
    if (nextKind === kind) return;
    if (scanActive) return;

    const nextScanKind = nextKind === "raster" || nextKind === "vector" ? nextKind : null;
    const currentScanKind = kind === "raster" || kind === "vector" ? kind : hasPriorScanImage ? lastScanKind : null;

    if (currentScanKind && nextScanKind && currentScanKind !== nextScanKind) {
      dispatch(streamReset());
      dispatch(resetRaster({ resolution: rasterResolution }));
      dispatch(resetVector());
      setLastLiveScanImage(null);
      setMergedFigureByKind({ raster: null, vector: null });
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
      rect.width - MIN_LEFT_PANEL_WIDTH - SPLITTER_SPACE - (showROIPreviewSideCard ? 236 : 0)
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
      : kind === "mag"
      ? "card.magCalibration"
      : roiState.calibration_enabled
      ? "card.calibration"
      : "card.selectROI";

  return (
    <div className="app-shell">
      <Header
        signedInUser={signedInUser}
        onSignedIn={setSignedInUser}
        activeView={route}
        onOpenReport={() => navigateTo("report")}
        onOpenScan={() => navigateTo("control")}
        scanLocked={scanActive}
      />

      {grayScaleConfirmOpen && pendingGrayScaleSelection !== null && (
        <GrayScaleConfirmDialog
          selection={pendingGrayScaleSelection}
          isSkipped={pendingGrayScaleSkipped}
          onIsSkippedChange={setPendingGrayScaleSkipped}
          onClose={() => setGrayScaleConfirmOpen(false)}
          onConfirm={handleGrayScaleConfirmAccept}
        />
      )}

      {route === "report" ? (
        <ReportErrorBoundary>
          <ManagementReport
            key={signedInUser?.id ?? "all"}
            onBack={() => navigateTo("control")}
            defaultAccountId={signedInUser?.id ?? null}
          />
        </ReportErrorBoundary>
      ) : (
      <main
        ref={mainRef}
        className={`app-main${isResizing ? " app-main--resizing" : ""}${
          showROIPreviewSideCard ? " app-main--with-roi-preview" : ""
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
              <button
                role="tab"
                className="tab tab--mag"
                aria-selected={kind === "mag"}
                disabled={panelDisabled}
                onClick={() => selectKind("mag")}
              >
                <Icon name="tools" tone="tab" />
                {t("tabs.mag")}
              </button>
            </div>
            <div className="card__body">
              {kind === "raster" ? (
                <RasterParameters disabled={panelDisabled} />
              ) : kind === "vector" ? (
                <VectorParameters disabled={panelDisabled} />
              ) : kind === "mag" ? (
                <MagCalibrationControls disabled={panelDisabled} />
              ) : (
                <>
                  <ROIEditor disabled={panelDisabled} variant="controls" />
                  {showROICalibrationInControls && <ROICalibrationCard disabled={panelDisabled} />}
                </>
              )}
            </div>
          </div>

          {kind !== "roi" && kind !== "mag" && (
            <>
              <div className="card">
                <div className="card__header">
                  <span className="card__title">{t("card.controls")}</span>
                </div>
                <div className="card__body">
                  <ScanControls
                    kind={kind as ScanKind}
                    disabled={!isSignedIn}
                    scanActive={scanActive}
                    grayScaleSelection={committedGrayScaleSelection}
                    grayScaleSkipped={committedGrayScaleSkipped}
                  />
                </div>
              </div>
              <div className="card">
                <div className="card__header">
                  <span className="card__title">{t("card.runReport")}</span>
                </div>
                <ValidationPanel
                  disabled={!isSignedIn}
                  mergedFigureUrl={
                    kind === "vector" ? mergedFigureByKind.vector : mergedFigureByKind.raster
                  }
                />
              </div>
              <ErrorWedge signedInUser={signedInUser} />
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
                <div id="image-panel-toolbar-slot" className="card__header-toolbar-slot">
                {showGraySpectrum && (
                  <GrayScaleSpectrum
                    selectedGrayScale={pendingGrayScaleSelection}
                    levels={grayScaleLevels}
                    stepDelta={grayScaleStepDelta}
                    sourceLabel={grayScaleSourceLabel}
                    scopeNote={grayScaleScopeNote}
                    onSelect={handleGrayScaleSelect}
                    onStepDeltaChange={handleGrayScaleStepDeltaChange}
                    onConfirm={handleGrayScaleConfirm}
                    onClear={handleGrayScaleClear}
                  />
                )}
                </div>
            </div>
            <div className="card__body">
              {kind === "roi" ? (
                <ROIEditor
                  disabled={panelDisabled}
                  variant="canvas"
                  backgroundImageUrl={roiScanImageUrl}
                  grayScaleSelection={pendingGrayScaleSelection}
                  grayScaleSkipped={pendingGrayScaleSkipped}
                />
              ) : kind === "mag" ? (
                <MagCalibrationChart />
              ) : (
                <ImageCanvas
                  kind={kind as ScanKind}
                  onRenderedImageChange={handleRenderedImageChange}
                  onMergedFigureChange={handleMergedFigureChange}
                />
              )}
            </div>
          </div>
        </section>

        {showROIPreviewSideCard && (
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

      <SettingsDialog targetAccountId={settingsTarget.accountId} targetLogin={settingsTarget.login} />
      <Footer />
    </div>
  );
}

function parseSettingsTarget(search: string): { accountId: number | null; login: string | null } {
  const params = new URLSearchParams(search);
  if (params.get("settings") !== "admin") {
    return { accountId: null, login: null };
  }
  const accountIdRaw = Number(params.get("account_id") ?? 0);
  const accountId = Number.isInteger(accountIdRaw) && accountIdRaw > 0 ? accountIdRaw : null;
  const login = params.get("login")?.trim() || null;
  return { accountId, login };
}

function GrayScaleConfirmDialog({
  selection,
  isSkipped,
  onIsSkippedChange,
  onClose,
  onConfirm,
}: {
  selection: number;
  isSkipped: boolean | null;
  onIsSkippedChange: (value: boolean | null) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleIdRef = useRef(`gray-scale-confirm-title-${Math.random().toString(36).slice(2, 9)}`);
  const messageIdRef = useRef(`gray-scale-confirm-message-${Math.random().toString(36).slice(2, 9)}`);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }

    document.addEventListener("keydown", onKey);
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      window.clearTimeout(timer);
    };
  }, [onClose]);

  return (
    <div
      className="modal-backdrop gray-scale-confirm__backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal gray-scale-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleIdRef.current}
        aria-describedby={messageIdRef.current}
      >
        <div className="modal__header">
          <div id={titleIdRef.current} className="modal__title">
            {t("roi.grayScale.confirm.title")}
          </div>
          <button
            ref={closeRef}
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label={t("help.close")}
            title={t("help.close")}
          >
            <Icon name="x" />
          </button>
        </div>
        <div id={messageIdRef.current} className="modal__body gray-scale-confirm__body">
          <p>{t("roi.grayScale.confirm.body", { selection })}</p>
          <div className="gray-scale-confirm__mode-group" role="radiogroup" aria-label={t("roi.grayScale.confirm.mode.label")}>
            <label className="gray-scale-confirm__mode-option">
              <input
                type="radio"
                name="gray-scale-skip-mode"
                checked={isSkipped !== false}
                onChange={() => onIsSkippedChange(true)}
              />
              <span>
                <strong>{t("roi.grayScale.confirm.mode.skip")}</strong>
                <small>{t("roi.grayScale.confirm.mode.skip.help")}</small>
              </span>
            </label>
            <label className="gray-scale-confirm__mode-option">
              <input
                type="radio"
                name="gray-scale-skip-mode"
                checked={isSkipped === false}
                onChange={() => onIsSkippedChange(false)}
              />
              <span>
                <strong>{t("roi.grayScale.confirm.mode.splash")}</strong>
                <small>{t("roi.grayScale.confirm.mode.splash.help")}</small>
              </span>
            </label>
          </div>
        </div>
        <div className="settings-footer">
          <div className="settings-footer__row gray-scale-confirm__footer">
            <span className="spacer" />
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {t("settings.confirm.cancel")}
            </button>
            <button type="button" className="btn btn--primary" onClick={onConfirm}>
              {t("roi.grayScale.confirm.select")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function GrayScaleSpectrum({
  selectedGrayScale,
  levels,
  stepDelta,
  sourceLabel,
  scopeNote,
  onSelect,
  onStepDeltaChange,
  onConfirm,
  onClear,
}: {
  selectedGrayScale: number | null;
  levels: number[];
  stepDelta: number;
  sourceLabel: string | null;
  scopeNote: string | null;
  onSelect: (grayScale: number | null) => void;
  onStepDeltaChange: (stepDelta: number) => void;
  onConfirm: () => void;
  onClear: () => void;
}) {
  const boxes = buildGrayScaleBoxes(levels, stepDelta);
  const hasPendingSelection = selectedGrayScale !== null;

  return (
    <div className="roi-spectrum" aria-label="Grayscale spectrum">
      <div className="roi-spectrum__topline">
        <div className="roi-spectrum__chain" role="list" aria-label="Gray levels">
          {boxes.map((grayScale) => {
            const selected = selectedGrayScale === grayScale;
            const textTone = grayScale < 140 ? "#f8fafc" : "#101820";
            return (
              <button
                key={grayScale}
                type="button"
                role="listitem"
                className="roi-spectrum__box"
                data-selected={selected ? "true" : "false"}
                aria-pressed={selected}
                title={`Gray level ${grayScale}`}
                style={{
                  backgroundColor: `rgb(${grayScale}, ${grayScale}, ${grayScale})`,
                  color: textTone,
                }}
                onClick={() => onSelect(selected ? null : grayScale)}
              >
                <span className="roi-spectrum__box-value">{grayScale}</span>
              </button>
            );
          })}
        </div>
        <div className="roi-spectrum__meta">
          {sourceLabel && <span className="roi-spectrum__source-pill">{sourceLabel}</span>}
          <GrayScaleHelp />
        </div>
      </div>
      {scopeNote && <span className="roi-spectrum__context">{scopeNote}</span>}
      <div className="roi-spectrum__controls">
        <button
          type="button"
          className="roi-spectrum__step-btn"
          aria-label="Decrease gray level box count"
          onClick={() => onStepDeltaChange(stepDelta - 1)}
        >
          -
        </button>
        <input
          className="input roi-spectrum__step-input"
          type="number"
          min={1}
          max={255}
          step={1}
          value={stepDelta}
          aria-label="Gray level box count"
          onChange={(event) => onStepDeltaChange(Number(event.target.value))}
        />
        <button
          type="button"
          className="roi-spectrum__step-btn"
          aria-label="Increase gray level box count"
          onClick={() => onStepDeltaChange(stepDelta + 1)}
        >
          +
        </button>
        {hasPendingSelection && (
          <button
            type="button"
            className="btn btn--ghost roi-spectrum__confirm-btn"
            onClick={onConfirm}
          >
            Select
          </button>
        )}
        <button
          type="button"
          className="btn btn--ghost roi-spectrum__confirm-btn"
          disabled={selectedGrayScale === null}
          onClick={onClear}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

function buildGrayScaleBoxes(levels: number[], stepDelta: number): number[] {
  if (!levels.length) return [];
  const delta = clampGrayScaleStepDelta(stepDelta);
  const boxCount = Math.max(1, Math.min(levels.length, delta));
  if (boxCount === 1) {
    return [levels[Math.floor((levels.length - 1) / 2)]];
  }
  if (boxCount === levels.length) {
    return levels;
  }
  const boxes: number[] = [];
  const lastIndex = levels.length - 1;
  for (let i = 0; i < boxCount; i++) {
    const index = Math.round((i * lastIndex) / (boxCount - 1));
    const value = levels[index];
    if (boxes[boxes.length - 1] !== value) {
      boxes.push(value);
    }
  }
  if (boxes[0] !== levels[0]) {
    boxes.unshift(levels[0]);
  }
  if (boxes[boxes.length - 1] !== levels[lastIndex]) {
    boxes.push(levels[lastIndex]);
  }
  return [...new Set(boxes)].sort((a, b) => a - b);
}

function clampGrayScaleStepDelta(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 10;
  return Math.max(1, Math.min(255, Math.round(n)));
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
