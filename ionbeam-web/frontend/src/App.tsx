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
import { shouldDisableScanPanel } from "./lib/vacuumPolicy";
import { dimensionBoundsFromGeometry, geometryFromConfig, toAppliedGeometry } from "./lib/scanGeometry";
import { fetchScanGeometry } from "./lib/scanGeometryApi";
import { fetchDimensionCalibrationRemote } from "./lib/dimensionCalibrationApi";
import { selectedEquipmentId } from "./lib/adminActivity";
import { setScanGeometry, setStreamTransforms } from "./store/scanSlice";
import { saveDimensionCalibration } from "./store/dimensionCalibrationSlice";
import { Footer } from "./components/Footer";
import { ScanControls } from "./components/ScanControls";
import { RasterParameters } from "./components/RasterParameters";
import { VectorParameters } from "./components/VectorParameters";
import { VectorScanPathField } from "./components/VectorScanPathField";
import { ImageCanvas } from "./components/ImageCanvas";
import { ValidationPanel } from "./components/ValidationPanel";
import { ROIEditor } from "./components/ROIEditor";
import { ROIScanPreview } from "./components/ROIScanPreview";
import { ROICalibrationCard } from "./components/ROICalibrationCard";
import { MagCalibrationChart, MagCalibrationControls } from "./components/MagCalibration";
import { GrayScaleHelp } from "./components/GrayScaleHelp";
import { NumberStepperInput } from "./components/NumberStepperField";
import { VectorGrayLevelHelp } from "./components/VectorGrayLevelHelp";
import { ErrorWedge } from "./components/ErrorWedge";
import { Icon } from "./components/Icon";
import { SettingsDialog } from "./components/SettingsDialog";
import { ManagementReport } from "./components/ManagementReport";
import { VacuumDashboard } from "./components/VacuumDashboard";
import { SampleStageDashboard } from "./components/SampleStageDashboard";
import { AdcTestControls, AdcTimelineCanvas } from "./components/AdcTest";
import { DacRampPanel } from "./components/DacRampTest";
import { DacCheckHelp } from "./components/DacCheckHelp";
import { useAdcTestStream } from "./hooks/useAdcTestStream";
import { clearBitmapSelectionCache, grayScaleSpectrumLevelsForSelection } from "./lib/bitmapVector";
import {
  formatGrayScaleSelection,
  normalizeGrayScaleSelection,
  type GrayScaleSelection,
} from "./lib/grayScaleSelection";
import {
  grayScaleScopeNoteForKind,
  grayScaleSourceLabelForKind,
  resolveROIActionKind,
  shouldShowROIGrayScaleClear,
  shouldShowROIActionControls,
  resolveGrayScaleSourceKind,
} from "./lib/grayScaleUI";
import { completedROIImagePatch } from "./lib/roiWorkflow";

import {
  beginDimensionCalibration,
  applyPersistedDimensionCalibration,
  clearROISelection,
  clearROIScanImage,
  persistGrayScaleStepDelta,
  setKind,
  setROIGrayScaleSelection,
  updateVector,
  updateROI,
  streamReset,
  type ScanKind,
} from "./store/scanSlice";
import { resetRaster, resetVector } from "./store/imageSlice";
import { fetchDefaults } from "./store/statusSlice";
import { useAppDispatch, useAppSelector } from "./store";
import { useTranslation } from "./i18n";
import { scanAuthHeaders } from "./lib/authIdentity";
import {
  openDialog as openSettingsDialog,
  readPath,
  setActiveTab,
  VECTOR_PATH,
  setDraft,
  writePath,
  clearDimensionCalNavigationRequest,
} from "./store/settingsSlice";
import { SCAN_TYPE_COLORS, type ScanType } from "./types/scanType";
import type { VacuumSystemStatus } from "./types/api";

const RIGHT_PANEL_STORAGE_KEY = "ionbeam:rightPanelWidth";
const DEFAULT_RIGHT_PANEL_WIDTH = 400;
const MIN_LEFT_PANEL_WIDTH = 320;
const MIN_RIGHT_PANEL_WIDTH = 380;
const SPLITTER_SPACE = 32;
const LAST_ADMIN_LOGIN_STORAGE_KEY = "ionbeam:lastAdminLogin";
type AppRoute = "control" | "report" | "vacuum";
type LeftTopTab = "scan" | "calibrate" | "adcTest";
type ScanSubTab = "roi" | "raster" | "vector";
type CalibrateSubTab = "dimension" | "mag";

export function App() {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const mainRef = useRef<HTMLElement | null>(null);
  const route = useAppRoute();
  // Both hardware controllers start docked. Their header buttons restore the
  // corresponding popup without requiring an initial open/close cycle.
  const [vacuumMinimized, setVacuumMinimized] = useState(true);
  const [vacuumControllerBusy, setVacuumControllerBusy] = useState(false);
  const [sampleStageOpen, setSampleStageOpen] = useState(true);
  const [sampleStageMinimized, setSampleStageMinimized] = useState(true);
  const [sampleStageControllerBusy, setSampleStageControllerBusy] = useState(false);
  // DAC check card starts collapsed — it's an occasional diagnostic,
  // not part of the normal vector-scan flow, so it shouldn't compete
  // with Controls/Run report for attention by default.
  const [dacCheckCollapsed, setDacCheckCollapsed] = useState(true);
  const handleVacuumActivityChange = useCallback((active: boolean) => {
    setVacuumControllerBusy(active);
    setVacuumMinimized(!active);
  }, []);
  const autoOpenedVacuumRef = useRef(false);
  const serviceStatus = useAppSelector((s) => s.status.service);
  const vacuumEnabled = serviceStatus?.vacuum_enabled === true;
  const [isVacuumSystemReady, setIsVacuumSystemReady] = useState(false);
  const [highVoltagePower, setHighVoltagePower] = useState(false);
  const [highVoltagePending, setHighVoltagePending] = useState(false);
  const [highVoltageError, setHighVoltageError] = useState<string | null>(null);
  const kind = useAppSelector((s) => s.scan.kind);
  const phase = useAppSelector((s) => s.scan.phase);
  const isProduction = useAppSelector((s) => s.status.defaults?.is_production === true);
  const adcTestEnabled = useAppSelector((s) => s.status.defaults?.adc_test !== false);
  const rasterResolution = useAppSelector((s) => s.scan.raster.resolution);
  const rasterCursor = useAppSelector((s) => s.image.cursor);
  const vectorCursor = useAppSelector((s) => s.image.vectorCursor);
  const imageRevision = useAppSelector((s) => s.image.revision);
  const lastResult = useAppSelector((s) => s.scan.lastResult);
  const vector = useAppSelector((s) => s.scan.vector);
  const vectorRenderMode = useAppSelector((s) => s.scan.vectorRenderMode);
  const vectorLatencyBytes = useAppSelector((s) => s.scan.vector.latency_bytes);
  const roiState = useAppSelector((s) => s.scan.roi);
  const dimensionCalibration = useAppSelector((s) => s.dimensionCalibration.values);
  const hasPersistedDimensionCalibration = useAppSelector(
    (s) => s.dimensionCalibration.persisted
  );
  const roiStateRef = useRef(roiState);
  roiStateRef.current = roiState;
  const roiSelectionKey = roiState.selection
    ? `${roiState.selection.x_start}:${roiState.selection.x_end}:${roiState.selection.y_start}:${roiState.selection.y_end}`
    : "";
  const committedGrayScaleSelection = useAppSelector((s) => s.scan.roiGrayScaleSelection);
  const committedGrayScaleSkipped = useAppSelector((s) => s.scan.roiGrayScaleSkipped);
  const committedGrayScaleStepDelta = useAppSelector((s) => s.scan.roiGrayScaleStepDelta);
  const settingsDraft = useAppSelector((s) => s.settings.draft);
  const dimensionCalNavigationRequest = useAppSelector((s) => s.settings.dimensionCalNavigationRequest);
  const [lastScanKind, setLastScanKind] = useState<Extract<ScanKind, "raster" | "vector">>("raster");
  const [lastLiveScanImage, setLastLiveScanImage] = useState<{
    kind: Extract<ScanKind, "raster" | "vector">;
    imageUrl: string;
  } | null>(null);
  const suppressedROIScanImageUrlRef = useRef<string | null>(null);
  const previousROIImageRef = useRef({
    imageDataUrl: roiState.imageDataUrl,
  });
  const [suppressedROIScanImageUrl, setSuppressedROIScanImageUrl] = useState<string | null>(null);
  const [pendingGrayScaleSelection, setPendingGrayScaleSelection] = useState<GrayScaleSelection>(committedGrayScaleSelection);
  const [pendingGrayScaleAnchor, setPendingGrayScaleAnchor] = useState<number | null>(null);
  const [pendingGrayScaleSkipped, setPendingGrayScaleSkipped] = useState<boolean | null>(committedGrayScaleSkipped);
  const [grayScaleLevels, setGrayScaleLevels] = useState<number[]>([]);
  const [grayScaleStepDelta, setGrayScaleStepDelta] = useState(committedGrayScaleStepDelta);
  const [grayScaleConfirmOpen, setGrayScaleConfirmOpen] = useState(false);
  const [grayScaleConfirmTarget, setGrayScaleConfirmTarget] = useState<"roi" | "vector">("roi");
  const [grayScaleCommitCount, setGrayScaleCommitCount] = useState(0);
  const [vectorGrayLevelsEnabled, setVectorGrayLevelsEnabled] = useState(false);
  const [vectorGrayRange, setVectorGrayRange] = useState<[number, number]>([0, 255]);
  const [vectorGrayScaleSkipped, setVectorGrayScaleSkipped] = useState<boolean | null>(null);
  const [vectorGrayRangeCommitCount, setVectorGrayRangeCommitCount] = useState(0);
  const [repeat, setRepeat] = useState(1);
  const [roiActionLocked, setROIActionLocked] = useState(false);
  const [roiActionCanvasVisible, setROIActionCanvasVisible] = useState(false);
  const [roiGraySelectionResetToken, setROIGraySelectionResetToken] = useState(0);
  const [activeScanType, setActiveScanType] = useState<ScanType | null>(null);
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
  const showROIPreviewSideCardBase = kind === "roi" && hasPartialROI && !roiState.calibration_enabled;
  const isSignedIn = Boolean(signedInUser);
  const [activeTopTab, setActiveTopTab] = useState<LeftTopTab>(
    kind === "mag" || roiState.calibration_enabled || hasPersistedDimensionCalibration
      ? "calibrate"
      : "scan"
  );
  const [scanSubTab, setScanSubTab] = useState<ScanSubTab>(
    kind === "raster" ? "raster" : kind === "vector" ? "vector" : "roi"
  );
  const [calibrateSubTab, setCalibrateSubTab] = useState<CalibrateSubTab>(
    kind === "mag" ? "mag" : "dimension"
  );
  const adcTest = useAdcTestStream();
  const adcActive = adcTest.state.phase === "connecting" || adcTest.state.phase === "running";
  const showROIPreviewSideCard = showROIPreviewSideCardBase && activeTopTab !== "adcTest";

  useEffect(() => {
    dispatch(fetchDefaults());
  }, [dispatch]);

  useEffect(() => {
    if (!adcTestEnabled && activeTopTab === "adcTest") {
      setActiveTopTab("scan");
    }
  }, [adcTestEnabled, activeTopTab]);

  const dimensionCalibrationRestoredRef = useRef(false);
  useEffect(() => {
    if (dimensionCalibrationRestoredRef.current) return;
    dimensionCalibrationRestoredRef.current = true;
    if (!hasPersistedDimensionCalibration) return;
    clearBitmapSelectionCache();
    dispatch(applyPersistedDimensionCalibration(dimensionCalibration));
  }, [dimensionCalibration, dispatch, hasPersistedDimensionCalibration]);

  // Dimension Cal also lives server-side, one row per equipment (see dimensionCalibrationApi.ts) so it's
  // shared across browsers/operators instead of being stuck in whichever one last confirmed it. The local
  // copy above applies instantly (works offline, no flash of defaults); if the backend has a row for the
  // currently selected equipment, it supersedes the local copy once the fetch resolves.
  const dimensionCalibrationRemoteSyncedRef = useRef(false);
  useEffect(() => {
    if (dimensionCalibrationRemoteSyncedRef.current) return;
    dimensionCalibrationRemoteSyncedRef.current = true;
    const equipmentId = selectedEquipmentId();
    if (equipmentId === null) return;
    fetchDimensionCalibrationRemote(equipmentId).then((remote) => {
      if (!remote) return;
      clearBitmapSelectionCache();
      dispatch(saveDimensionCalibration(remote));
      dispatch(applyPersistedDimensionCalibration(remote));
    });
  }, [dispatch]);

  // CONFIGURATION > Admin > Calibration's "Go to Dimension Cal" shortcut dispatches closeDialog() +
  // requestDimensionCalNavigation() together (it lives inside the settings modal's component tree, which
  // has no direct line to this component's local tab state) — this is the other end of that handoff.
  useEffect(() => {
    if (dimensionCalNavigationRequest === 0) return;
    if (route !== "control") navigateTo("control");
    activateCalibrateSubTab("dimension");
    dispatch(clearDimensionCalNavigationRequest());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimensionCalNavigationRequest]);

  // Rectified scan geometry (Admin > Calibration > Scan geometry): when one is applied, ROI / bitmap scans map world
  // µm to DAC codes through it. Loaded once; on failure scans keep the linear ROI mapping.
  const scanGeometryLoadedRef = useRef(false);
  useEffect(() => {
    if (scanGeometryLoadedRef.current) return;
    scanGeometryLoadedRef.current = true;
    fetchScanGeometry()
      .then(({ config, stream }) => {
        dispatch(setStreamTransforms({
          xflip: stream.transforms?.xflip === true,
          yflip: stream.transforms?.yflip === true,
          rotate90: stream.transforms?.rotate90 === true,
        }));
        if (!config?.enabled) return;
        const geometry = geometryFromConfig(config);
        clearBitmapSelectionCache();
        dispatch(setScanGeometry(toAppliedGeometry(geometry, config.profile_revision)));
        dispatch(applyPersistedDimensionCalibration({ ...dimensionCalibration, ...dimensionBoundsFromGeometry(geometry) }));
      })
      .catch((err) => console.warn(`[scan-geometry] not loaded: ${err instanceof Error ? err.message : String(err)}`));
  }, [dispatch, dimensionCalibration]);

  useEffect(() => {
    if (route !== "vacuum" || serviceStatus === null || vacuumEnabled) return;
    navigateTo("control");
  }, [route, serviceStatus, vacuumEnabled]);

  useEffect(() => {
    // Open the dashboard once as soon as the enabled vacuum service is
    // available. VacuumDashboard's mount lifecycle acquires the controller;
    // the ref prevents closing it from immediately reopening it.
    if (!vacuumEnabled || autoOpenedVacuumRef.current) return;
    autoOpenedVacuumRef.current = true;
    if (route !== "vacuum") navigateTo("vacuum");
  }, [route, vacuumEnabled]);

  useEffect(() => {
    if (!vacuumEnabled) {
      setIsVacuumSystemReady(false);
      setHighVoltagePower(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    async function refreshVacuumReadiness() {
      try {
        const response = await fetch(apiUrl("/api/vacuum"), {
          cache: "no-store",
          headers: scanAuthHeaders(),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`vacuum status: HTTP ${response.status}`);
        const status = await readJsonResponse<VacuumSystemStatus>(response, "vacuum status");
        if (!cancelled) {
          setIsVacuumSystemReady(status.isVacuumSystemReady === true);
          setHighVoltagePower(status.high_voltage_power === true);
        }
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        if (!cancelled) setIsVacuumSystemReady(false);
      }
    }

    void refreshVacuumReadiness();
    const timer = window.setInterval(() => void refreshVacuumReadiness(), 1000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [vacuumEnabled]);

  const toggleHighVoltage = useCallback(async () => {
    if (!isVacuumSystemReady || highVoltagePending) return;
    setHighVoltagePending(true);
    setHighVoltageError(null);
    try {
      const response = await fetch(apiUrl("/api/vacuum/high-voltage/power"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...scanAuthHeaders() },
        body: JSON.stringify({ power: !highVoltagePower }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as {
          detail?: unknown;
          error?: unknown;
        } | null;
        if (response.status === 401) {
          window.localStorage.setItem(LAST_ADMIN_LOGIN_STORAGE_KEY, signedInUser?.login_name ?? "");
          window.localStorage.removeItem("ionbeam:adminUser");
          setSignedInUser(null);
          throw new Error(t("auth.sessionExpired"));
        }
        const detail = String(payload?.error ?? payload?.detail ?? "").trim();
        throw new Error(detail || `${response.status} ${response.statusText}`);
      }
      const status = await readJsonResponse<VacuumSystemStatus>(response, "high-voltage power");
      setIsVacuumSystemReady(status.isVacuumSystemReady === true);
      setHighVoltagePower(status.high_voltage_power === true);
    } catch (cause) {
      setHighVoltageError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setHighVoltagePending(false);
    }
  }, [highVoltagePending, highVoltagePower, isVacuumSystemReady, signedInUser?.login_name, t]);

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
  const panelDisabled = shouldDisableScanPanel({
    scanActive: scanActive || adcActive,
    signedIn: isSignedIn,
    vacuumEnabled,
    vacuumReady: isVacuumSystemReady,
  });
  const rasterVectorTabsDisabled = panelDisabled || roiActionLocked;
  const hasPriorScanImage =
    (lastScanKind === "raster" && rasterCursor > 0) ||
    (lastScanKind === "vector" && vectorCursor > 0) ||
    lastResult?.kind === lastScanKind ||
    roiState.scanImageDataUrl !== null;
  const roiCachedScanImageUrl =
    kind === "roi" && hasPartialROI ? roiState.scanImageDataUrl : null;
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
  const activeROIScanImageUrl =
    roiCachedScanImageUrl && roiCachedScanImageUrl !== suppressedROIScanImageUrl
      ? roiCachedScanImageUrl
      : null;
  const showGraySpectrum =
    kind === "roi" &&
    hasPartialROI &&
    Boolean(roiState.scanImageDataUrl || roiState.imageDataUrl || activeROIScanImageUrl);
  const grayScaleSourceKind = resolveGrayScaleSourceKind({
    showGraySpectrum: kind === "roi" && showGraySpectrum,
    roiImageDataUrl: roiState.imageDataUrl,
    roiScanImageUrl: activeROIScanImageUrl,
    lastScanKind,
  });
  const grayScaleSourceLabel = grayScaleSourceLabelForKind(grayScaleSourceKind, t);
  const grayScaleScopeNote = grayScaleScopeNoteForKind(grayScaleSourceKind, isProduction, t);
  const roiActionGrayFilterActive =
    committedGrayScaleSelection !== null && committedGrayScaleSkipped !== null;
  const displayedROIGrayScaleSelection = pendingGrayScaleSelection ?? committedGrayScaleSelection;
  const displayedROIGrayScaleSkipped = pendingGrayScaleSkipped ?? committedGrayScaleSkipped;
  const actionScanKind =
    kind === "roi"
      ? "vector"
      : resolveROIActionKind(kind, lastScanKind) ?? lastScanKind;
  const showROIActionControls = shouldShowROIActionControls({
    kind,
    hasPartialROI,
  });
  const gridLineToggle =
    kind === "roi" ? (
      <label className="checkbox vacuum-switch app-switch canvas-grid-toggle canvas-grid-toggle--grid">
        <input
          type="checkbox"
          checked={roiState.show_grid}
          disabled={panelDisabled}
          onChange={(e) => dispatch(updateROI({ show_grid: e.target.checked }))}
        />
        <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
        {t("roi.showGrid")}
      </label>
    ) : kind === "raster" ? (
      <label className="checkbox vacuum-switch app-switch canvas-grid-toggle canvas-grid-toggle--grid">
        <input
          type="checkbox"
          checked={roiState.raster_show_grid}
          disabled={panelDisabled}
          onChange={(e) => dispatch(updateROI({ raster_show_grid: e.target.checked }))}
        />
        <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
        {t("roi.showGrid")}
      </label>
    ) : kind === "vector" ? (
      <label className="checkbox vacuum-switch app-switch canvas-grid-toggle canvas-grid-toggle--grid">
        <input
          type="checkbox"
          checked={roiState.vector_show_grid}
          disabled={panelDisabled}
          onChange={(e) => dispatch(updateROI({ vector_show_grid: e.target.checked }))}
        />
        <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
        {t("roi.showGrid")}
      </label>
    ) : null;
  const scanPathToggle =
    kind === "vector" || (kind === "roi" && hasPartialROI) ? (
    <label className="checkbox vacuum-switch app-switch canvas-grid-toggle canvas-scan-path-toggle">
      <input
        type="checkbox"
        checked={roiState.vector_show_scan_path}
        disabled={panelDisabled}
        onChange={(e) =>
          dispatch(updateROI({ vector_show_scan_path: e.target.checked }))
        }
      />
      <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
      {t("vector.displayScanPath")}
    </label>
    ) : null;
  const clearCommittedGrayScaleSelection = useCallback(() => {
    dispatch(
      setROIGrayScaleSelection({
        selection: null,
        isSkipped: null,
      })
    );
  }, [dispatch]);

  useEffect(() => {
    if (!roiState.selection || phase === "completed" || phase === "error" || phase === "idle") {
      setROIActionLocked(false);
    }
    if (!roiState.selection || phase === "idle" || phase === "error") {
      setROIActionCanvasVisible(false);
    }
  }, [phase, roiSelectionKey]);

  useEffect(() => {
    if (phase === "running" || phase === "stopping") return;
    setActiveScanType(null);
  }, [phase]);

  useEffect(() => {
    if (kind !== "roi") return;
    if (!showGraySpectrum) {
      setPendingGrayScaleSelection(null);
      setPendingGrayScaleAnchor(null);
      setGrayScaleLevels([]);
      setGrayScaleCommitCount(0);
    }
  }, [kind, showGraySpectrum]);

  const resetROIActionContext = useCallback(
    (options?: { clearSelection?: boolean; preserveScanImage?: boolean; preserveGraySelection?: boolean }) => {
      clearBitmapSelectionCache();
      if (!options?.preserveScanImage) {
        dispatch(clearROIScanImage());
      }
      if (options?.clearSelection) {
        dispatch(clearROISelection());
      }
      if (!options?.preserveGraySelection) {
        clearCommittedGrayScaleSelection();
        setPendingGrayScaleSelection(null);
        setPendingGrayScaleAnchor(null);
        setPendingGrayScaleSkipped(null);
      }
      setGrayScaleLevels([]);
      setGrayScaleConfirmOpen(false);
      setGrayScaleCommitCount(0);
      setROIActionLocked(false);
      setROIActionCanvasVisible(false);
    },
    [clearCommittedGrayScaleSelection, dispatch]
  );

  const handleClearROIGrayScaleValues = useCallback(() => {
    clearCommittedGrayScaleSelection();
    setPendingGrayScaleSelection(null);
    setPendingGrayScaleAnchor(null);
    setPendingGrayScaleSkipped(null);
    setGrayScaleConfirmOpen(false);
    setGrayScaleCommitCount(0);
    setROIActionLocked(false);
    setROIActionCanvasVisible(false);
  }, [clearCommittedGrayScaleSelection]);

  useEffect(() => {
    setPendingGrayScaleSelection(committedGrayScaleSelection);
    setPendingGrayScaleAnchor(null);
  }, [committedGrayScaleSelection]);

  useEffect(() => {
    persistGrayScaleStepDelta(grayScaleStepDelta);
  }, [grayScaleStepDelta]);

  useEffect(() => {
    const previous = previousROIImageRef.current;
    const clearedImage = previous.imageDataUrl !== null && roiState.imageDataUrl === null;

    if (clearedImage && roiScanImageUrl) {
      suppressedROIScanImageUrlRef.current = roiScanImageUrl;
      setSuppressedROIScanImageUrl(roiScanImageUrl);
    } else if (
      suppressedROIScanImageUrlRef.current !== null &&
      (roiState.imageKind === "file" ||
        !roiScanImageUrl ||
        roiScanImageUrl !== suppressedROIScanImageUrlRef.current)
    ) {
      suppressedROIScanImageUrlRef.current = null;
      setSuppressedROIScanImageUrl(null);
    }

    previousROIImageRef.current = {
      imageDataUrl: roiState.imageDataUrl,
    };
  }, [roiScanImageUrl, roiState.imageDataUrl, roiState.imageKind]);

  useEffect(() => {
    if (!showGraySpectrum) return;
    let cancelled = false;
    void (async () => {
      const spectrumROI = roiState.imageDataUrl
        ? roiState
        : activeROIScanImageUrl
        ? { ...roiState, imageDataUrl: activeROIScanImageUrl }
        : roiState;
      const levels = await grayScaleSpectrumLevelsForSelection(spectrumROI);
      if (cancelled) return;
      setGrayScaleLevels((current) =>
        current.length === levels.length && current.every((value, index) => value === levels[index])
          ? current
          : levels
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [
    activeROIScanImageUrl,
    showGraySpectrum,
    roiState.imageDataUrl,
    roiState.imageKind,
    roiState.selection?.x_start,
    roiState.selection?.x_end,
    roiState.selection?.y_start,
    roiState.selection?.y_end,
    roiState.x_origin,
    roiState.x_end,
    roiState.y_origin,
    roiState.y_end,
    roiState.viewport_x_start,
    roiState.viewport_x_end,
    roiState.viewport_y_start,
    roiState.viewport_y_end,
  ]);

  useEffect(() => {
    if (!showGraySpectrum) return;
    if (grayScaleStepDelta >= 2) return;
    setGrayScaleStepDelta(10);
  }, [grayScaleStepDelta, showGraySpectrum]);

  const previousROISelectionKeyRef = useRef(roiSelectionKey);
  useEffect(() => {
    if (previousROISelectionKeyRef.current === roiSelectionKey) return;
    previousROISelectionKeyRef.current = roiSelectionKey;
    if (roiState.scanImageDataUrl) {
      dispatch(
        updateROI({
          imageName: t("roi.imageName.lastScan"),
          imageDataUrl: roiState.scanImageDataUrl,
          imageKind: "lastScan",
          scanImageDataUrl: null,
        })
      );
      resetROIActionContext({ preserveScanImage: true });
      return;
    }
    resetROIActionContext();
  }, [dispatch, resetROIActionContext, roiSelectionKey, roiState.scanImageDataUrl, t]);

  useEffect(() => {
    if (kind !== "roi") return;
    if (!activeROIScanImageUrl) return;
    if (phase === "running" || phase === "stopping") return;
    if (roiState.imageKind === "file") return;
    if (roiState.scanImageDataUrl !== null) return;
    if (suppressedROIScanImageUrlRef.current === activeROIScanImageUrl) return;
    // ROIEditor may promote the last-scan URL into a data URL for local
    // annotation/highlight work. Once ROI state is already in last-scan
    // mode, don't overwrite that promoted image on every render.
    if (roiState.imageKind === "lastScan") return;
    dispatch(
      updateROI({
        imageName: t("roi.imageName.lastScan"),
        imageDataUrl: activeROIScanImageUrl,
        imageKind: "lastScan",
      })
    );
  }, [activeROIScanImageUrl, dispatch, kind, phase, roiState.imageDataUrl, roiState.imageKind, roiState.scanImageDataUrl, t]);

  const handleRenderedImageChange = useCallback(
    (scanKind: Extract<ScanKind, "raster" | "vector">, imageUrl: string | null) => {
      if (
        kind === "roi" &&
        scanKind === "vector" &&
        roiActionCanvasVisible &&
        !roiActionGrayFilterActive
      ) {
        if (imageUrl) {
          dispatch(
            updateROI(
              completedROIImagePatch(
                roiStateRef.current,
                imageUrl,
                t("roi.imageName.lastScan"),
              ),
            )
          );
          dispatch(resetVector());
          setROIActionLocked(false);
          setROIActionCanvasVisible(false);
          setLastLiveScanImage(null);
          setMergedFigureByKind({ raster: null, vector: null });
        }
        return;
      }
      setLastLiveScanImage((current) => {
        if (!imageUrl) return current?.kind === scanKind ? null : current;
        if (current?.kind === scanKind && current.imageUrl === imageUrl) {
          return current;
        }
        return { kind: scanKind, imageUrl };
      });
    },
    [
      dispatch,
      kind,
      roiActionCanvasVisible,
      roiActionGrayFilterActive,
      t,
    ]
  );

  const handleMergedFigureChange = useCallback(
    (scanKind: Extract<ScanKind, "raster" | "vector">, imageUrl: string | null) => {
      setMergedFigureByKind((current) =>
        current[scanKind] === imageUrl ? current : { ...current, [scanKind]: imageUrl }
      );
    },
    []
  );

  const handleGrayScaleSelect = useCallback((grayScale: number) => {
    setGrayScaleConfirmTarget("roi");
    setPendingGrayScaleSkipped((current) => current ?? committedGrayScaleSkipped ?? false);
    if (grayScaleCommitCount === 0) {
      setPendingGrayScaleAnchor(grayScale);
      setPendingGrayScaleSelection([grayScale, grayScale]);
      setGrayScaleCommitCount(1);
      setGrayScaleConfirmOpen(false);
      return;
    }
    const next =
      pendingGrayScaleAnchor !== null && pendingGrayScaleSelection !== null
        ? normalizeGrayScaleSelection([pendingGrayScaleAnchor, grayScale])
        : [grayScale, grayScale];
    setPendingGrayScaleAnchor(null);
    setPendingGrayScaleSelection((next ?? [grayScale, grayScale]) as GrayScaleSelection);
    setGrayScaleCommitCount(0);
    setGrayScaleConfirmOpen(true);
  }, [committedGrayScaleSkipped, grayScaleCommitCount, pendingGrayScaleAnchor, pendingGrayScaleSelection]);

  const handleGrayScaleStepDeltaChange = useCallback((nextStepDelta: number) => {
    const n = Number(nextStepDelta);
    if (!Number.isFinite(n)) return;
    setGrayScaleStepDelta(Math.max(1, Math.min(255, Math.round(n))));
  }, []);

  const handleGrayScaleConfirm = useCallback(() => {
    if (pendingGrayScaleSelection === null || pendingGrayScaleAnchor !== null) return;
    setGrayScaleConfirmOpen(true);
  }, [pendingGrayScaleAnchor, pendingGrayScaleSelection]);

  const handleGrayScaleConfirmAccept = useCallback(() => {
    if (pendingGrayScaleSelection === null || pendingGrayScaleAnchor !== null) return;
    dispatch(updateVector({ dwell: 2 }));
    if (grayScaleConfirmTarget === "vector") {
      setVectorGrayScaleSkipped(true);
    } else {
      if (roiState.scanImageDataUrl !== null && roiState.imageKind === "lastScan") {
        dispatch(
          updateROI({
            imageName: "No image selected",
            imageDataUrl: null,
            imageKind: "none",
            imageBounds: null,
          })
        );
      }
      dispatch(clearROIScanImage());
      dispatch(resetVector());
      setROIActionCanvasVisible(false);
      setROIGraySelectionResetToken((n) => n + 1);
      dispatch(
        setROIGrayScaleSelection({
          selection: pendingGrayScaleSelection,
          isSkipped: pendingGrayScaleSkipped,
        })
      );
    }
    setGrayScaleConfirmOpen(false);
  }, [
    dispatch,
    grayScaleConfirmTarget,
    pendingGrayScaleAnchor,
    pendingGrayScaleSelection,
    pendingGrayScaleSkipped,
    roiState.imageKind,
    roiState.scanImageDataUrl,
  ]);

  const applyVectorGrayLevelsToggle = useCallback((checked: boolean) => {
    setVectorGrayLevelsEnabled(checked);
    if (checked) {
      const defaultRange: [number, number] = [0, 255];
      const nextSkipped = true;
      setVectorGrayRange(defaultRange);
      setVectorGrayScaleSkipped(nextSkipped);
      // Adaptive feedback visits each coordinate twice (probe + action), so
      // starting it at the normal 2048 edge can leave the live canvas showing
      // only its first scan line for a long time. Initialize the filtered
      // sweep at 128x128 so both dimensions become visible promptly; the
      // resolution control remains editable after the filter is enabled.
      dispatch(updateVector({
        vector_resolution: 128,
        pattern: "default",
        points: null,
      }));
      return;
    }
    setVectorGrayRange([0, 255]);
    setVectorGrayScaleSkipped(null);
  }, [dispatch]);

  const handleVectorGrayLevelsToggle = useCallback((checked: boolean) => {
    if (settingsDraft !== null) {
      dispatch(setDraft(writePath(settingsDraft, [...VECTOR_PATH, "PixelFallbackBlank"], checked)));
    }
    setVectorGrayRangeCommitCount(0);
    applyVectorGrayLevelsToggle(checked);
  }, [applyVectorGrayLevelsToggle, dispatch, settingsDraft]);

  useEffect(() => {
    if (settingsDraft === null) return;
    const nextEnabled = readPath(settingsDraft, [...VECTOR_PATH, "PixelFallbackBlank"]) === true;
    if (nextEnabled === vectorGrayLevelsEnabled) return;
    applyVectorGrayLevelsToggle(nextEnabled);
  }, [applyVectorGrayLevelsToggle, settingsDraft, vectorGrayLevelsEnabled]);

  useEffect(() => {
    if (!vectorGrayLevelsEnabled || vectorLatencyBytes >= 8196) return;
    dispatch(updateVector({ latency_bytes: 8196 }));
  }, [dispatch, vectorGrayLevelsEnabled, vectorLatencyBytes]);

  const handleVectorGrayRangeChange = useCallback((nextRange: [number, number]) => {
    const normalized = normalizeGrayScaleSelection(nextRange) ?? [0, 255];
    setVectorGrayRange(normalized);
  }, []);

  const handleVectorGrayRangeSelect = useCallback(() => {
    if (!vectorGrayLevelsEnabled) return;
    setGrayScaleConfirmTarget("vector");
    setPendingGrayScaleSelection(vectorGrayRange);
    setPendingGrayScaleAnchor(null);
    setPendingGrayScaleSkipped(true);
    if (vectorGrayRangeCommitCount === 0) {
      setVectorGrayRangeCommitCount(1);
      return;
    }
    setVectorGrayRangeCommitCount(0);
    setGrayScaleConfirmOpen(true);
  }, [committedGrayScaleSkipped, vectorGrayLevelsEnabled, vectorGrayRange, vectorGrayRangeCommitCount]);

  const handleLoadLastScan = useCallback(() => {
    if (!roiScanImageUrl) return;
    suppressedROIScanImageUrlRef.current = null;
    setSuppressedROIScanImageUrl(null);
    resetROIActionContext({ clearSelection: true });
    dispatch(
      updateROI({
        imageName: t("roi.imageName.lastScan"),
        imageDataUrl: roiScanImageUrl,
        imageKind: "lastScan",
        imageBounds: null,
      })
    );
  }, [dispatch, resetROIActionContext, roiScanImageUrl, t]);

  function selectKind(nextKind: ScanKind) {
    if (nextKind === kind) return;
    if (scanActive) return;

    const nextScanKind = nextKind === "raster" || nextKind === "vector" ? nextKind : null;
    const currentScanKind = kind === "raster" || kind === "vector" ? kind : null;

    resetROIActionContext({ preserveScanImage: true, preserveGraySelection: true });

    if (nextScanKind && (currentScanKind === null || currentScanKind !== nextScanKind)) {
      dispatch(streamReset());
      // A scan buffer belongs to the run that populated it. Merely changing
      // tabs is not a new run, so do not present the previous raster/vector
      // frame as live data for the newly selected mode.
      if (nextScanKind === "raster") {
        dispatch(resetRaster({ resolution: rasterResolution }));
      } else {
        dispatch(resetVector());
      }
    }

    dispatch(setKind(nextKind));
  }

  function activateScanSubTab(nextTab: ScanSubTab) {
    setActiveTopTab("scan");
    setScanSubTab(nextTab);
    setRepeat(1);
    dispatch(updateROI({ calibration_enabled: false }));
    if (nextTab === "roi") {
      selectKind("roi");
      return;
    }
    selectKind(nextTab);
  }

  function activateCalibrateSubTab(nextTab: CalibrateSubTab) {
    setActiveTopTab("calibrate");
    setCalibrateSubTab(nextTab);
    if (nextTab === "dimension") {
      if (kind !== "roi") {
        selectKind("roi");
      }
      dispatch(
        hasPersistedDimensionCalibration
          ? applyPersistedDimensionCalibration(dimensionCalibration)
          : beginDimensionCalibration(dimensionCalibration)
      );
      return;
    }
    dispatch(updateROI({ calibration_enabled: false }));
    selectKind("mag");
  }

  function activateScanTopTab() {
    setActiveTopTab("scan");
    activateScanSubTab(scanSubTab);
  }

  function activateCalibrateTopTab() {
    setActiveTopTab("calibrate");
    activateCalibrateSubTab(calibrateSubTab);
  }

  function activateAdcTestTab() {
    if (scanActive) return;
    setActiveTopTab("adcTest");
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
  const activeScanColor = activeScanType ? SCAN_TYPE_COLORS[activeScanType] : null;
  const scanPanelStyle = activeScanColor
    ? ({
        "--scan-panel-active-color": activeScanColor,
      } as CSSProperties)
    : undefined;

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
        onOpenVacuum={() => {
          setVacuumMinimized(false);
          navigateTo("vacuum");
        }}
        vacuumMinimized={vacuumMinimized}
        vacuumControllerBusy={vacuumControllerBusy}
        onOpenSampleStage={() => {
          setSampleStageOpen(true);
          setSampleStageMinimized(false);
        }}
        sampleStageMinimized={sampleStageMinimized}
        sampleStageControllerBusy={sampleStageControllerBusy}
        highVoltagePower={highVoltagePower}
        highVoltageReady={vacuumEnabled && isVacuumSystemReady}
        highVoltagePending={highVoltagePending}
        highVoltageError={highVoltageError}
        onToggleHighVoltage={() => void toggleHighVoltage()}
        scanLocked={scanActive || adcActive}
        adcTestActive={adcActive}
      />

      {grayScaleConfirmOpen && pendingGrayScaleSelection !== null && pendingGrayScaleAnchor === null && (
        <GrayScaleConfirmDialog
          selection={pendingGrayScaleSelection}
          isSkipped={pendingGrayScaleSkipped}
          onIsSkippedChange={setPendingGrayScaleSkipped}
          onClose={() => {
            setGrayScaleConfirmOpen(false);
            setGrayScaleCommitCount(0);
            setVectorGrayRangeCommitCount(0);
          }}
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
          <div
            className={`card scan-panel-card${activeScanColor ? " scan-panel-card--active" : ""}`}
            style={scanPanelStyle}
          >
            <div className="tabs tabs--top" role="tablist" aria-label={t("tabs.top.aria")}>
              <button
                role="tab"
                className="tab tab--top"
                aria-selected={activeTopTab === "scan"}
                disabled={panelDisabled}
                onClick={activateScanTopTab}
              >
                <Icon name="scan" tone="tab" />
                {t("tabs.scan")}
              </button>
              <button
                role="tab"
                className="tab tab--top"
                aria-selected={activeTopTab === "calibrate"}
                disabled={panelDisabled}
                onClick={activateCalibrateTopTab}
              >
                <Icon name="calibrate" tone="tab" />
                {t("tabs.calibrate")}
              </button>
              {adcTestEnabled && <button
                role="tab"
                className="tab tab--top"
                aria-selected={activeTopTab === "adcTest"}
                disabled={scanActive}
                onClick={activateAdcTestTab}
              >
                <Icon name="adcTest" tone="tab" />
                {t("tabs.adcTest")}
              </button>}
            </div>
            {activeTopTab === "scan" ? (
              <div className="tabs tabs--sub" role="tablist" aria-label={t("tabs.scan.aria")}>
                <button
                  role="tab"
                  className="tab tab--sub"
                  aria-selected={scanSubTab === "roi"}
                  disabled={panelDisabled}
                  onClick={() => activateScanSubTab("roi")}
                >
                  <Icon name="target" tone="tab" />
                  {t("tabs.roi")}
                </button>
                <button
                  role="tab"
                  className="tab tab--sub"
                  aria-selected={scanSubTab === "raster"}
                  disabled={rasterVectorTabsDisabled}
                  onClick={() => activateScanSubTab("raster")}
                >
                  <Icon name="grid" tone="tab" />
                  {t("tabs.raster")}
                </button>
                <button
                  role="tab"
                  className="tab tab--sub"
                  aria-selected={scanSubTab === "vector"}
                  disabled={rasterVectorTabsDisabled}
                  onClick={() => activateScanSubTab("vector")}
                >
                  <Icon name="route" tone="tab" />
                  {t("tabs.vector")}
                </button>
              </div>
            ) : activeTopTab === "calibrate" ? (
              <div className="tabs tabs--sub" role="tablist" aria-label={t("tabs.calibrate.aria")}>
                <button
                  role="tab"
                  className="tab tab--sub"
                  aria-selected={calibrateSubTab === "dimension"}
                  disabled={panelDisabled}
                  onClick={() => activateCalibrateSubTab("dimension")}
                >
                  <Icon name="ruler" tone="tab" />
                  {t("tabs.dimensionCal")}
                </button>
                <button
                  role="tab"
                  className="tab tab--sub"
                  aria-selected={calibrateSubTab === "mag"}
                  disabled={panelDisabled}
                  onClick={() => activateCalibrateSubTab("mag")}
                >
                  <Icon name="magCal" tone="tab" />
                  {t("tabs.mag")}
                </button>
              </div>
            ) : null}
            <div className="card__body">
              {activeTopTab === "adcTest" ? (
                <AdcTestControls
                  state={adcTest.state}
                  onStart={adcTest.start}
                  onStop={adcTest.stop}
                />
              ) : activeTopTab === "scan" ? (
                scanSubTab === "raster" ? (
                  <RasterParameters disabled={panelDisabled} />
                ) : scanSubTab === "vector" ? (
                  <VectorParameters
                    disabled={panelDisabled}
                    grayLevelFilterActive={vectorGrayLevelsEnabled}
                  />
                ) : (
                  <>
                    <ROIEditor
                      disabled={panelDisabled}
                      variant="controls"
                      allowClearRegionWhileDisabled={roiActionLocked}
                      lastScanImageUrl={roiScanImageUrl}
                      onLoadLastScan={handleLoadLastScan}
                    />
                    {hasPartialROI && (
                      <VectorScanPathField
                        id="roi-vector-scan-path"
                        disabled={panelDisabled}
                      />
                    )}
                    {showROIActionControls && kind === "roi" && (
                      <div className="roi-action-controls">
                    <ScanControls
                          kind={actionScanKind}
                          disabled={panelDisabled}
                          scanActive={scanActive}
                          repeat={repeat}
                          onRepeatChange={setRepeat}
                          showRepeatControl={roiActionGrayFilterActive}
                          vectorGrayScaleSelection={vectorGrayLevelsEnabled ? vectorGrayRange : null}
                          vectorGrayScaleSkipped={vectorGrayLevelsEnabled ? vectorGrayScaleSkipped : null}
                          roiAction
                          onScanRunStart={setActiveScanType}
                          onActionRunStart={() => {
                            setROIActionLocked(true);
                            setROIActionCanvasVisible(true);
                          }}
                        />
                      </div>
                    )}
                    {showROICalibrationInControls && (
                      <ROICalibrationCard
                        disabled={panelDisabled}
                        lastScanImageUrl={roiScanImageUrl}
                        onLoadLastScan={handleLoadLastScan}
                      />
                    )}
                  </>
                )
              ) : (
                calibrateSubTab === "mag" ? (
                  <MagCalibrationControls disabled={panelDisabled} />
                ) : (
                  <>
                    <ROIEditor
                      disabled={panelDisabled}
                      variant="controls"
                      allowClearRegionWhileDisabled={roiActionLocked}
                      lastScanImageUrl={roiScanImageUrl}
                      onLoadLastScan={handleLoadLastScan}
                    />
                    {showROICalibrationInControls && (
                      <ROICalibrationCard
                        disabled={panelDisabled}
                        lastScanImageUrl={roiScanImageUrl}
                        onLoadLastScan={handleLoadLastScan}
                      />
                    )}
                  </>
                )
              )}
            </div>
          </div>

          {activeTopTab !== "adcTest" && showROIActionControls && kind !== "roi" && (
            <>
              <div
                className={`card scan-panel-card${activeScanColor ? " scan-panel-card--active" : ""}`}
                style={scanPanelStyle}
              >
                <div className="card__header">
                  <span className="card__title">{t("card.controls")}</span>
                </div>
                <div className="card__body">
                  <ScanControls
                    kind={actionScanKind}
                    disabled={panelDisabled}
                    scanActive={scanActive}
                    repeat={repeat}
                    onRepeatChange={setRepeat}
                    showRepeatControl={actionScanKind === "vector" && vectorGrayLevelsEnabled}
                    vectorGrayScaleSelection={vectorGrayLevelsEnabled ? vectorGrayRange : null}
                    vectorGrayScaleSkipped={vectorGrayLevelsEnabled ? vectorGrayScaleSkipped : null}
                    onScanRunStart={setActiveScanType}
                  />
                </div>
              </div>
              {kind === "vector" && (
                <div className="card dac-check-card">
                  <div className="card__header">
                    <span className="card__title">
                      {t("card.dacCheck")}
                      <DacCheckHelp />
                    </span>
                    <button
                      type="button"
                      className="card__collapse-btn"
                      aria-expanded={!dacCheckCollapsed}
                      aria-label={dacCheckCollapsed ? t("dacRamp.expand") : t("dacRamp.collapse")}
                      title={dacCheckCollapsed ? t("dacRamp.expand") : t("dacRamp.collapse")}
                      onClick={() => setDacCheckCollapsed((collapsed) => !collapsed)}
                    >
                      <Icon name="chevronDown" />
                    </button>
                  </div>
                  {!dacCheckCollapsed && (
                    <div className="card__body">
                      <DacRampPanel disabled={panelDisabled} />
                    </div>
                  )}
                </div>
              )}
              <div className="card">
                <div className="card__header">
                  <span className="card__title">{t("card.runReport")}</span>
                </div>
                <ValidationPanel
                  disabled={panelDisabled}
                  mergedFigureUrl={
                    actionScanKind === "vector" ? mergedFigureByKind.vector : mergedFigureByKind.raster
                  }
                  kindOverride={actionScanKind}
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
              <div className={`card__header image-panel-card__header${scanPathToggle ? " image-panel-card__header--scan-path" : ""}${kind === "roi" ? " image-panel-card__header--roi" : ""}`}>
                <div className="image-panel-card__header-main">
                  <span className="card__title">{t(
                    activeTopTab === "adcTest"
                      ? "card.adcTimeline"
                      : kind === "roi" && roiActionCanvasVisible && !roiActionGrayFilterActive
                      ? "card.vectorPattern"
                      : imagePanelTitleKey
                  )}</span>
                  {activeTopTab !== "adcTest" && gridLineToggle}
                  {activeTopTab !== "adcTest" && scanPathToggle}
                  {activeTopTab !== "adcTest" && kind === "vector" && (
                    <label className="checkbox vacuum-switch app-switch canvas-grid-toggle vector-gray-level-toggle">
                      <input
                        type="checkbox"
                        checked={vectorGrayLevelsEnabled}
                        disabled={panelDisabled}
                        onChange={(event) => handleVectorGrayLevelsToggle(event.target.checked)}
                      />
                      <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
                      {t("vector.grayLevels")}
                      <VectorGrayLevelHelp />
                    </label>
                  )}
                  {activeTopTab !== "adcTest" && <div
                    id="image-panel-toolbar-slot"
                    className={`card__header-toolbar-slot image-panel-card__toolbar-slot${kind === "vector" ? " image-panel-card__toolbar-slot--vector" : ""}`}
                  >
                    {kind === "vector" ? (
                      vectorGrayLevelsEnabled && (
                        <VectorGrayLevelSelector
                          enabled={vectorGrayLevelsEnabled}
                          range={vectorGrayRange}
                          disabled={panelDisabled}
                          onRangeChange={handleVectorGrayRangeChange}
                          onRangeCommit={handleVectorGrayRangeSelect}
                          onSelect={handleVectorGrayRangeSelect}
                        />
                      )
                    ) : showGraySpectrum &&
                      !(kind === "roi" && roiActionCanvasVisible && !roiActionGrayFilterActive) ? (
                      <GrayScaleSpectrum
                        selectedGrayScale={displayedROIGrayScaleSelection}
                        selectionAnchor={pendingGrayScaleAnchor}
                        levels={grayScaleLevels}
                        stepDelta={grayScaleStepDelta}
                        sourceLabel={grayScaleSourceLabel}
                        scopeNote={grayScaleScopeNote}
                        onSelect={handleGrayScaleSelect}
                        onStepDeltaChange={handleGrayScaleStepDeltaChange}
                      />
                    ) : null}
                    {shouldShowROIGrayScaleClear({
                      kind,
                      hasConfirmedGrayRange: committedGrayScaleSelection !== null,
                    }) && !(roiActionCanvasVisible && !roiActionGrayFilterActive) && (
                      <button
                        type="button"
                        className="btn btn--ghost image-panel-card__header-action"
                        disabled={panelDisabled}
                        onClick={handleClearROIGrayScaleValues}
                        title={t("scan.clear")}
                      >
                        {t("scan.clear")}
                      </button>
                    )}
                  </div>}
                </div>
            </div>
            <div className="card__body">
                {activeTopTab === "adcTest" ? (
                  <AdcTimelineCanvas state={adcTest.state} />
                ) : kind === "roi" ? (
                  roiActionCanvasVisible &&
                  !roiActionGrayFilterActive &&
                  roiState.scanImageDataUrl === null ? (
                    <ImageCanvas
                      kind="vector"
                      onRenderedImageChange={handleRenderedImageChange}
                      onMergedFigureChange={handleMergedFigureChange}
                    />
                  ) : (
                    <ROIEditor
                      disabled={panelDisabled}
                      variant="canvas"
                      backgroundImageUrl={activeROIScanImageUrl}
                      grayScaleSelection={displayedROIGrayScaleSelection}
                      grayScaleSkipped={displayedROIGrayScaleSkipped}
                      liveVectorPreview={roiActionCanvasVisible && roiActionGrayFilterActive}
                      hideSelectionOverlay={roiActionCanvasVisible && !roiActionGrayFilterActive}
                      graySelectionResetToken={roiGraySelectionResetToken}
                    />
                  )
              ) : kind === "mag" ? (
                <MagCalibrationChart />
              ) : (
                <ImageCanvas
                  kind={kind as ScanKind}
                  onRenderedImageChange={handleRenderedImageChange}
                  onMergedFigureChange={handleMergedFigureChange}
                  vectorGrayScaleSelection={vectorGrayLevelsEnabled ? vectorGrayRange : null}
                  vectorGrayScaleSkipped={vectorGrayLevelsEnabled ? vectorGrayScaleSkipped : null}
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
                <ROIScanPreview backgroundImageUrl={activeROIScanImageUrl} />
              </div>
            </div>
          </section>
        )}
      </main>
      )}

      <SettingsDialog targetAccountId={settingsTarget.accountId} targetLogin={settingsTarget.login} />
      {vacuumEnabled && (
        <VacuumDashboard
          open={route === "vacuum"}
          minimized={vacuumMinimized}
          onActivityChange={handleVacuumActivityChange}
          onMinimizedChange={setVacuumMinimized}
          onClose={() => {
            setVacuumMinimized(true);
            navigateTo("control");
          }}
        />
      )}
      <SampleStageDashboard
        open={sampleStageOpen}
        minimized={sampleStageMinimized}
        onActivityChange={setSampleStageControllerBusy}
        onMinimizedChange={setSampleStageMinimized}
        onClose={() => {
          setSampleStageOpen(false);
          setSampleStageMinimized(false);
        }}
      />
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
  selection: GrayScaleSelection;
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
          <p>{t("roi.grayScale.confirm.body", { selection: formatGrayScaleSelection(selection) })}</p>
          <div className="gray-scale-confirm__mode-group" role="radiogroup" aria-label={t("roi.grayScale.confirm.mode.label")}>
            <label className="gray-scale-confirm__mode-option">
              <input
                type="radio"
                name="gray-scale-skip-mode"
                checked={isSkipped === false}
                onChange={() => onIsSkippedChange(false)}
              />
              <span>
                <strong>{t("roi.grayScale.confirm.mode.spot")}</strong>
                <small>{t("roi.grayScale.confirm.mode.spot.help")}</small>
              </span>
            </label>
            <label className="gray-scale-confirm__mode-option">
              <input
                type="radio"
                name="gray-scale-skip-mode"
                checked={isSkipped === true}
                onChange={() => onIsSkippedChange(true)}
              />
              <span>
                <strong>{t("roi.grayScale.confirm.mode.skip")}</strong>
                <small>{t("roi.grayScale.confirm.mode.skip.help")}</small>
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

function VectorGrayLevelSelector({
  enabled,
  range,
  disabled,
  onRangeChange,
  onRangeCommit,
  onSelect,
}: {
  enabled: boolean;
  range: [number, number];
  disabled: boolean;
  onRangeChange: (range: [number, number]) => void;
  onRangeCommit: () => void;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const min = Math.min(range[0], range[1]);
  const max = Math.max(range[0], range[1]);
  const majorTicks = useMemo(() => {
    const ticks: number[] = [];
    for (let value = 0; value <= 240; value += 20) ticks.push(value);
    ticks.push(255);
    return ticks;
  }, []);
  const minorTicks = useMemo(() => {
    const ticks: number[] = [];
    for (let value = 5; value <= 255; value += 5) {
      if (value % 20 !== 0 && value !== 255) ticks.push(value);
    }
    return ticks;
  }, []);

  function setMin(value: number) {
    const next = clampVectorGrayLevel(value);
    onRangeChange([Math.min(next, max), max]);
  }

  function setMax(value: number) {
    const next = clampVectorGrayLevel(value);
    onRangeChange([min, Math.max(next, min)]);
  }

  return (
    <div className="vector-gray-levels">
      {enabled && (
        <div className="vector-gray-levels__panel">
          <div className="vector-gray-levels__actions">
            <div className="vector-gray-levels__slider-shell">
              <div className="vector-gray-levels__values">
                <span
                  className="vector-gray-levels__value vector-gray-levels__value--min"
                  style={{ left: `${(min / 255) * 100}%` }}
                >
                  {min}
                </span>
                <span
                  className="vector-gray-levels__value vector-gray-levels__value--max"
                  style={{ left: `${(max / 255) * 100}%` }}
                >
                  {max}
                </span>
              </div>
              <div className="vector-gray-levels__slider" aria-label={t("vector.grayLevels.range")}>
                <div className="vector-gray-levels__track" />
                <div
                  className="vector-gray-levels__selection"
                  style={{
                    left: `${(min / 255) * 100}%`,
                    width: `${((max - min) / 255) * 100}%`,
                  }}
                />
                <div className="vector-gray-levels__ticks vector-gray-levels__ticks--minor">
                  {minorTicks.map((value) => (
                    <span key={value} style={{ left: `${(value / 255) * 100}%` }} />
                  ))}
                </div>
                <div className="vector-gray-levels__ticks vector-gray-levels__ticks--major">
                  {majorTicks.map((value) => (
                    <span key={value} style={{ left: `${(value / 255) * 100}%` }}>
                      <i>{value}</i>
                    </span>
                  ))}
                </div>
                <input
                  className="vector-gray-levels__range vector-gray-levels__range--min"
                  type="range"
                  min={0}
                  max={255}
                  step={1}
                  value={min}
                  disabled={disabled}
                  aria-label={t("vector.grayLevels.min")}
                  onChange={(event) => setMin(Number(event.target.value))}
                  onPointerUp={onRangeCommit}
                  onKeyUp={onRangeCommit}
                />
                <input
                  className="vector-gray-levels__range vector-gray-levels__range--max"
                  type="range"
                  min={0}
                  max={255}
                  step={1}
                  value={max}
                  disabled={disabled}
                  aria-label={t("vector.grayLevels.max")}
                  onChange={(event) => setMax(Number(event.target.value))}
                  onPointerUp={onRangeCommit}
                  onKeyUp={onRangeCommit}
                />
              </div>
            </div>
            <button type="button" className="btn btn--primary vector-gray-levels__select" disabled={disabled} onClick={onSelect}>
              {t("vector.grayLevels.select")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function GrayScaleSpectrum({
  selectedGrayScale,
  selectionAnchor,
  levels,
  stepDelta,
  sourceLabel,
  scopeNote,
  onSelect,
  onStepDeltaChange,
}: {
  selectedGrayScale: GrayScaleSelection;
  selectionAnchor: number | null;
  levels: number[];
  stepDelta: number;
  sourceLabel: string | null;
  scopeNote: string | null;
  onSelect: (grayScale: number) => void;
  onStepDeltaChange: (stepDelta: number) => void;
}) {
  const boxes = buildGrayScaleBoxes(levels, stepDelta, selectedGrayScale);
  const hasPendingSelection = selectedGrayScale !== null && selectionAnchor === null;
  const selectedMin = selectedGrayScale ? Math.min(selectedGrayScale[0], selectedGrayScale[1]) : null;
  const selectedMax = selectedGrayScale ? Math.max(selectedGrayScale[0], selectedGrayScale[1]) : null;

  return (
    <div className="roi-spectrum" aria-label="Grayscale spectrum">
      <div className="roi-spectrum__topline">
        <div className="roi-spectrum__chain" role="list" aria-label="Gray levels">
          {boxes.map((grayScale) => {
            const selected =
              selectedMin !== null &&
              selectedMax !== null &&
              grayScale >= selectedMin &&
              grayScale <= selectedMax;
            const endpoint =
              selectedMin !== null && selectedMax !== null
                ? grayScale === selectedMin && grayScale === selectedMax
                  ? "both"
                  : grayScale === selectedMin
                  ? "start"
                  : grayScale === selectedMax
                  ? "end"
                  : null
                : null;
            const textTone = grayScale < 140 ? "#f8fafc" : "#101820";
            return (
              <button
                key={grayScale}
                type="button"
                role="listitem"
                className="roi-spectrum__box"
                data-selected={selected ? "true" : "false"}
                data-endpoint={endpoint ?? undefined}
                data-pending={selectionAnchor !== null && grayScale === selectionAnchor ? "true" : "false"}
                aria-pressed={selected}
                title={
                  endpoint === "start"
                    ? `Start gray level ${grayScale}`
                    : endpoint === "end"
                    ? `End gray level ${grayScale}`
                    : endpoint === "both"
                    ? `Gray level ${grayScale} (start and end)`
                    : `Gray level ${grayScale}`
                }
                style={{
                  backgroundColor: `rgb(${grayScale}, ${grayScale}, ${grayScale})`,
                  color: textTone,
                }}
                onClick={() => onSelect(grayScale)}
              >
                <span className="roi-spectrum__box-value">{grayScale}</span>
              </button>
            );
          })}
        </div>
        <div className="roi-spectrum__meta">
          {sourceLabel && <span className="roi-spectrum__source-pill">{sourceLabel}</span>}
        </div>
      </div>
      {scopeNote && <span className="roi-spectrum__context">{scopeNote}</span>}
      <div className="roi-spectrum__controls">
        <div className="roi-spectrum__stepper-wrap">
          <NumberStepperInput
            value={stepDelta}
            min={1}
            max={255}
            step={1}
            inputMode="numeric"
            ariaLabel="Gray level box count"
            onValueChange={(next) => onStepDeltaChange(Number(next))}
          />
        </div>
        <div className="roi-spectrum__help">
          <GrayScaleHelp />
        </div>
      </div>
    </div>
  );
}

function buildGrayScaleBoxes(levels: number[], stepDelta: number, selectedGrayScale: GrayScaleSelection): number[] {
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
  if (selectedGrayScale !== null) {
    const start = Math.max(0, Math.min(255, Math.min(selectedGrayScale[0], selectedGrayScale[1])));
    const end = Math.max(0, Math.min(255, Math.max(selectedGrayScale[0], selectedGrayScale[1])));
    boxes.push(start, end);
  }
  return [...new Set(boxes)].sort((a, b) => a - b);
}

function clampGrayScaleStepDelta(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 10;
  return Math.max(1, Math.min(255, Math.round(n)));
}

function clampVectorGrayLevel(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
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
  if (path === "/report") return "report";
  if (path === "/vacuum") return "vacuum";
  return "control";
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
