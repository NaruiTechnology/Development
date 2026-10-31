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
import { HelpPopover } from "./components/HelpPopover";
import type { SignedInUser } from "./components/AuthDialog";
import { apiUrl } from "./lib/backendUrl";
import { readJsonResponse } from "./lib/readJsonResponse";
import { vacuumWindowState, type VacuumWindowState, vacuumIsReadyForControls, shouldDisableScanPanel, shouldShowVacuumControllerError } from "./lib/vacuumPolicy";
import { dimensionBoundsFromGeometry, geometryFromConfig, toAppliedGeometry } from "./lib/scanGeometry";
import { fetchScanGeometry } from "./lib/scanGeometryApi";
import { fetchDimensionCalibrationRemote } from "./lib/dimensionCalibrationApi";
import { selectedEquipmentId } from "./lib/adminActivity";
import { placeCompletedScan, replaceCompletedScanPane, type ImagePanelLayout } from "./lib/imagePanelLayout";
import { setScanGeometry, setStreamTransforms } from "./store/scanSlice";
import { saveDimensionCalibration } from "./store/dimensionCalibrationSlice";
import { Footer } from "./components/Footer";
import { ScanControls } from "./components/ScanControls";
import { RasterParameters } from "./components/RasterParameters";
import { ScanModeHelp } from "./components/ScanModeHelp";
import { VectorParameters } from "./components/VectorParameters";
import { VectorScanExecutionSettings } from "./components/VectorScanExecutionSettings";
import { RasterScanExecutionSettings } from "./components/RasterScanExecutionSettings";
import { ImageCanvas, type CapturedScanImage } from "./components/ImageCanvas";
import { ValidationPanel } from "./components/ValidationPanel";
import { ROIEditor } from "./components/ROIEditor";
import { ROIScanPreview } from "./components/ROIScanPreview";
import { ROICalibrationCard } from "./components/ROICalibrationCard";
import { SimulationImageCard } from "./components/SimulationImageCard";
import { MagCalibrationChart, MagCalibrationControls } from "./components/MagCalibration";
import { GrayScaleHelp } from "./components/GrayScaleHelp";
import { VectorGrayLevelHelp } from "./components/VectorGrayLevelHelp";
import { Icon } from "./components/Icon";
import { SettingsDialog } from "./components/SettingsDialog";
import { ManagementReport } from "./components/ManagementReport";
import { VacuumDashboard } from "./components/VacuumDashboard";
import { SampleStageDashboard } from "./components/SampleStageDashboard";
import { AdcTestControls, AdcTimelineCanvas } from "./components/AdcTest";
import { DacRampPanel } from "./components/DacRampTest";
import { BeamHoldPanel } from "./components/BeamHoldPanel";
import { DacCheckHelp } from "./components/DacCheckHelp";
import { useAdcTestStream } from "./hooks/useAdcTestStream";
import { clearBitmapSelectionCache, grayScaleSpectrumLevelsForSelection } from "./lib/bitmapVector";
import { targetGrayFilter } from "./lib/roiTargetGray";
import {
  formatGrayScaleSelection,
  normalizeGrayScaleSelection,
  type GrayScaleSelection,
} from "./lib/grayScaleSelection";
import {
  grayScaleScopeNoteForKind,
  grayScaleSourceLabelForKind,
  grayControlAvailability,
  shouldConfirmVectorGrayRange,
  shouldShowROIGrayScaleClear,
  resolveGrayScaleSourceKind,
} from "./lib/grayScaleUI";

import {
  beginDimensionCalibration,
  applyPersistedDimensionCalibration,
  clearROISelection,
  clearROIScanImage,
  setKind,
  setROIGrayScaleSelection,
  setSelectedTargetGray,
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
  setActiveTab,
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
type LeftTopTab = "scan" | "calibrate";
type ScanSubTab = "raster" | "vector";
type CalibrateSubTab = "dimension" | "mag";

function CollapsibleScanParameters({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(true);
  const { t } = useTranslation();
  return (
    <div className="card scan-parameters-card">
      <div className="card__header">
        <span className="card__title">{t("card.scanParameters")}</span>
        <button
          type="button"
          className="card__collapse-btn"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("scanParameters.expand") : t("scanParameters.collapse")}
          title={collapsed ? t("scanParameters.expand") : t("scanParameters.collapse")}
          onClick={() => setCollapsed((value) => !value)}
        >
          <Icon name="chevronDown" />
        </button>
      </div>
      <div hidden={collapsed}>{children}</div>
    </div>
  );
}

export function App() {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const mainRef = useRef<HTMLElement | null>(null);
  const route = useAppRoute();
  // Both hardware controllers start docked. Their header buttons restore the
  // corresponding popup without requiring an initial open/close cycle.
  const [vacuumMinimized, setVacuumMinimized] = useState(true);
  const [vacuumControllerBusy, setVacuumControllerBusy] = useState(false);
  const [vacuumControllerError, setVacuumControllerError] = useState(true);
  const [sampleStageOpen, setSampleStageOpen] = useState(true);
  const [sampleStageMinimized, setSampleStageMinimized] = useState(true);
  const [sampleStageDocked, setSampleStageDocked] = useState(true);
  const [sampleStageControllerBusy, setSampleStageControllerBusy] = useState(false);
  // DAC check card starts collapsed — it's an occasional diagnostic,
  // not part of the normal vector-scan flow, so it shouldn't compete
  // with Controls/Run report for attention by default.
  const [dacCheckCollapsed, setDacCheckCollapsed] = useState(true);
  const [beamHoldCollapsed, setBeamHoldCollapsed] = useState(true);
  // Save results card starts collapsed. Collapsing only hides it —
  // ValidationPanel stays mounted so the filename insert, chosen folder
  // and auto-download keep working.
  const [saveResultsCollapsed, setSaveResultsCollapsed] = useState(true);
  // ADC test card (replaces the old ADC Test top tab). Starts collapsed;
  // while expanded, the right-hand panel shows the ADC timeline instead
  // of the scan canvas — the same view the old tab switched to.
  const [adcTestCollapsed, setAdcTestCollapsed] = useState(true);
  // Controls card (nested in the scan panel card) starts expanded.
  const [controlsCollapsed, setControlsCollapsed] = useState(false);
  // Slot at the bottom of the scan parameters card (under Validated run
  // options) that ScanControls portals Run validated + Clear into.
  const [validatedActionsHost, setValidatedActionsHost] = useState<HTMLDivElement | null>(null);
  const [validationSummaryHost, setValidationSummaryHost] = useState<HTMLDivElement | null>(null);
  const handleVacuumActivityChange = useCallback((active: boolean) => {
    setVacuumControllerBusy(active);
  }, []);
  const previousVacuumWindowState = useRef<VacuumWindowState | null>(null);
  const serviceStatus = useAppSelector((s) => s.status.service);
  const vacuumEnabled = serviceStatus?.vacuum_enabled === true;
  const [isVacuumSystemReady, setIsVacuumSystemReady] = useState(false);
  const [highVoltagePower, setHighVoltagePower] = useState(false);
  const [highVoltagePending, setHighVoltagePending] = useState(false);
  const [highVoltageError, setHighVoltageError] = useState<string | null>(null);
  const kind = useAppSelector((s) => s.scan.kind);
  const phase = useAppSelector((s) => s.scan.phase);
  const streamRestarting = useAppSelector((s) => s.scan.streamRestarting);
  const previewMode = useAppSelector((s) => s.scan.preview);
  useEffect(() => {
    setSaveResultsCollapsed(previewMode);
  }, [previewMode]);
  // "<kind>:<scanId>" of the scan whose image currently occupies the target pane.
  const completedImageRecordedScanRef = useRef<string | null>(null);
  const completedImagePaneRef = useRef<Record<"raster" | "vector", number>>({ raster: 0, vector: 0 });
  // Filled by ImageCanvas: snapshots the result shown in the live pane.
  const captureTargetImageRef = useRef<(() => Promise<string | null>) | null>(null);
  const splitInFlightRef = useRef(false);
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
  const selectedTargetGray = useAppSelector((s) => s.scan.selectedTargetGray);
  const [targetGrayDraft, setTargetGrayDraft] = useState(
    selectedTargetGray === null ? "" : String(selectedTargetGray)
  );
  const [targetGrayDraftInvalid, setTargetGrayDraftInvalid] = useState(false);
  const [targetGraySkipped, setTargetGraySkipped] = useState(true);
  const targetGrayRunning = useAppSelector((s) => s.scan.roiTargetGrayRun.status === "running");
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
  const dimensionCalNavigationRequest = useAppSelector((s) => s.settings.dimensionCalNavigationRequest);
  const [lastScanKind, setLastScanKind] = useState<Extract<ScanKind, "raster" | "vector">>("vector");
  const [lastLiveScanImage, setLastLiveScanImage] = useState<{
    kind: Extract<ScanKind, "raster" | "vector">;
    imageUrl: string;
  } | null>(null);
  const captureScanImageRef = useRef<(() => CapturedScanImage | null) | null>(null);
  // Each scan kind keeps its own pane layout: splitting the vector view must not
  // open empty panes on the raster view (and vice versa). Once any view has
  // been split, the other one splits itself after its first completed scan.
  const [imagePanelLayoutByKind, setImagePanelLayoutByKind] = useState<
    Record<"raster" | "vector", ImagePanelLayout>
  >({ raster: 1, vector: 1 });
  const imagePanelLayout: ImagePanelLayout =
    kind === "raster" || kind === "vector" ? imagePanelLayoutByKind[kind] : 1;
  const imagePanelSplitActive =
    imagePanelLayoutByKind.raster > 1 || imagePanelLayoutByKind.vector > 1;
  const [imagePanelLocked, setImagePanelLocked] = useState(true);
  const [singlePaneImages, setSinglePaneImages] = useState<Record<"raster" | "vector", string | null>>({ raster: null, vector: null });
  const savedSplitRef = useRef<{
    layouts: Record<"raster" | "vector", ImagePanelLayout>;
    selected: Record<"raster" | "vector", number>;
    targets: Record<"raster" | "vector", number>;
    completed: Record<"raster" | "vector", number>;
  } | null>(null);
  const [selectedImagePane, setSelectedImagePane] = useState<
    Record<"raster" | "vector", number>
  >({ raster: 0, vector: 0 });
  const [scanTargetImagePane, setScanTargetImagePane] = useState<
    Record<"raster" | "vector", number>
  >({ raster: 0, vector: 0 });
  const previousScanPhaseRef = useRef(phase);
  const [, setCompletedImageHistory] = useState<
    Record<"raster" | "vector", string[]>
  >({ raster: [], vector: [] });
  const [imagePanelSlots, setImagePanelSlots] = useState<
    Record<"raster" | "vector", Array<string | null>>
  >({ raster: [], vector: [] });

  useEffect(() => {
    if (streamRestarting) return;
    const scanStarted = phase === "running" && previousScanPhaseRef.current !== "running";
    previousScanPhaseRef.current = phase;
    if (scanStarted && (kind === "raster" || kind === "vector")) {
      setSinglePaneImages((current) => ({ ...current, [kind]: null }));
    }
    if (!scanStarted || imagePanelLayout === 1 || (kind !== "raster" && kind !== "vector")) return;
    const targetPane = imagePanelLocked ? selectedImagePane[kind] : imagePanelLayout - 1;
    setScanTargetImagePane((current) =>
      current[kind] === targetPane ? current : { ...current, [kind]: targetPane }
    );
  }, [imagePanelLayout, imagePanelLocked, kind, phase, selectedImagePane, streamRestarting]);
  const suppressedROIScanImageUrlRef = useRef<string | null>(null);
  const previousROIImageRef = useRef({
    imageDataUrl: roiState.imageDataUrl,
  });
  const [suppressedROIScanImageUrl, setSuppressedROIScanImageUrl] = useState<string | null>(null);
  const [pendingGrayScaleSelection, setPendingGrayScaleSelection] = useState<GrayScaleSelection>(committedGrayScaleSelection);
  const [pendingGrayScaleAnchor, setPendingGrayScaleAnchor] = useState<number | null>(null);
  const [pendingGrayScaleSkipped, setPendingGrayScaleSkipped] = useState<boolean | null>(committedGrayScaleSkipped);
  const [grayScaleLevels, setGrayScaleLevels] = useState<number[]>([]);
  const [grayScaleConfirmOpen, setGrayScaleConfirmOpen] = useState(false);
  const [grayScaleConfirmTarget, setGrayScaleConfirmTarget] = useState<"roi" | "vector" | "target">("roi");
  const [pendingTargetGrayPoint, setPendingTargetGrayPoint] = useState<{ x: number; y: number } | null>(null);
  const [grayScaleCommitCount, setGrayScaleCommitCount] = useState(0);
  const [vectorGrayLevelsEnabled, setVectorGrayLevelsEnabled] = useState(false);
  const [vectorGrayFilterApplied, setVectorGrayFilterApplied] = useState(false);
  const [vectorGrayRange, setVectorGrayRange] = useState<[number, number]>([0, 255]);
  const [vectorGrayScaleSkipped, setVectorGrayScaleSkipped] = useState<boolean | null>(null);
  const [appliedVectorGrayRange, setAppliedVectorGrayRange] = useState<[number, number]>([0, 255]);
  const vectorGrayRangeEditedRef = useRef(false);
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
  const showROIPreviewSideCardBase =
    kind === "roi" &&
    (hasPartialROI || Boolean(roiState.imageDataUrl)) &&
    !roiState.calibration_enabled;
  const isSignedIn = Boolean(signedInUser);
  const [activeTopTab, setActiveTopTab] = useState<LeftTopTab>("scan");
  const [scanSubTab, setScanSubTab] = useState<ScanSubTab>("vector");
  const [calibrateSubTab, setCalibrateSubTab] = useState<CalibrateSubTab>(
    kind === "mag" ? "mag" : "dimension"
  );
  const adcTest = useAdcTestStream();
  const adcActive = adcTest.state.phase === "connecting" || adcTest.state.phase === "running";
  const adcView = adcTestEnabled && !adcTestCollapsed;
  const sampleStageDockTargetAvailable =
    route === "control" && (kind === "roi" || kind === "raster" || kind === "vector");
  const showInlineSampleStage =
    sampleStageDockTargetAvailable && sampleStageDocked && sampleStageOpen && !sampleStageMinimized;
  const showROIPreviewSideCard = showROIPreviewSideCardBase && !adcView && !showInlineSampleStage;
  const showROIThirdColumn = showROIPreviewSideCard || showInlineSampleStage;

  useEffect(() => {
    dispatch(fetchDefaults());
  }, [dispatch]);

  useEffect(() => {
    if (!adcTestEnabled) setAdcTestCollapsed(true);
  }, [adcTestEnabled]);

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
        dispatch(setScanGeometry(toAppliedGeometry(geometry, config.profile_revision, config.magnification_calibration)));
        dispatch(applyPersistedDimensionCalibration({ ...dimensionCalibration, ...dimensionBoundsFromGeometry(geometry) }));
      })
      .catch((err) => console.warn(`[scan-geometry] not loaded: ${err instanceof Error ? err.message : String(err)}`));
  }, [dispatch, dimensionCalibration]);

  useEffect(() => {
    if (route !== "vacuum" || serviceStatus === null || vacuumEnabled) return;
    navigateTo("control");
  }, [route, serviceStatus, vacuumEnabled]);

  useEffect(() => {
    if (!vacuumEnabled) {
      previousVacuumWindowState.current = null;
      setVacuumControllerError(false);
      setIsVacuumSystemReady(false);
      setHighVoltagePower(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    setVacuumControllerError(true);

    async function refreshVacuumReadiness() {
      try {
        const response = await fetch(apiUrl("/api/vacuum"), {
          cache: "no-store",
          headers: scanAuthHeaders(),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
        });
        if (!response.ok) throw new Error(`vacuum status: HTTP ${response.status}`);
        const status = await readJsonResponse<VacuumSystemStatus>(response, "vacuum status");
        if (!cancelled) {
          const invalid = shouldShowVacuumControllerError(status, null, null);
          const windowState = vacuumWindowState(status);
          if (windowState !== null && windowState !== previousVacuumWindowState.current) {
            previousVacuumWindowState.current = windowState;
            if (windowState === "pumping") {
              setVacuumMinimized(false);
              navigateTo("vacuum");
            } else if (windowState === "ready") {
              setVacuumMinimized(true);
            }
          }
          setIsVacuumSystemReady(vacuumIsReadyForControls(status));
          setVacuumControllerError(invalid);
          setHighVoltagePower(!invalid && status.high_voltage_power === true);
        }
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        if (!cancelled) {
          setIsVacuumSystemReady(false);
          setVacuumControllerError(true);
          setHighVoltagePower(false);
        }
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
      setIsVacuumSystemReady(vacuumIsReadyForControls(status));
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
        const responseUserLogin = String(data.user?.login_name ?? "").toLowerCase();
        const sameAccount =
          currentLogin === signedInLogin || responseUserLogin === signedInLogin;

        if (sameAccount && (!data.registered || data.session_expired === true)) {
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
        rect.width - MIN_LEFT_PANEL_WIDTH - SPLITTER_SPACE - (showROIThirdColumn ? 236 : 0)
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
  }, [isResizing, showROIThirdColumn]);

  const scanActive = phase === "running" || phase === "stopping";
  const scanControlsSafetyDisabled = shouldDisableScanPanel({
    scanActive: adcActive,
    signedIn: isSignedIn,
    vacuumEnabled: serviceStatus === null ? null : vacuumEnabled,
    vacuumReady: isVacuumSystemReady,
  });
  const panelDisabled = scanActive || scanControlsSafetyDisabled;
  // A scan started while the ADC test card is open would draw behind the
  // ADC timeline, so collapse the card to bring the scan canvas back.
  useEffect(() => {
    if (scanActive) setAdcTestCollapsed(true);
  }, [scanActive]);
  const vacuumControlsLocked = serviceStatus === null || (vacuumEnabled && !isVacuumSystemReady);
  const rasterVectorTabsDisabled = panelDisabled;
  const vectorGrayFilterActive = vectorGrayFilterApplied && selectedTargetGray === null;
  const grayControls = grayControlAvailability({
    locked: scanControlsSafetyDisabled || targetGrayRunning || phase === "stopping",
    scanActive,
    hasTarget: selectedTargetGray !== null,
  });
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
  const sampleStagePreviewImageUrl =
    roiState.scanImageDataUrl ??
    (roiState.imageKind === "lastScan"
      ? activeROIScanImageUrl ?? roiState.imageDataUrl
      : roiState.imageDataUrl ?? activeROIScanImageUrl);
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
  const roiGrayFilterActive =
    committedGrayScaleSelection !== null && committedGrayScaleSkipped !== null;
  const displayedROIGrayScaleSelection = pendingGrayScaleSelection ?? committedGrayScaleSelection;
  const displayedROIGrayScaleSkipped = pendingGrayScaleSkipped ?? committedGrayScaleSkipped;
  const targetGrayControl = (
    <div className="canvas-target-gray scan-target-gray">
      <span className="canvas-target-gray__label">
        {t("roi.targetGray")}<br />
        <small>{t("roi.targetGray.hint")}</small>
      </span>
      <HelpPopover title={t("roi.targetGray.help.title")} ariaLabel={t("roi.targetGray.help.aria")}>
        <p>{t("roi.targetGray.help.body")}</p>
      </HelpPopover>
      <span className="canvas-target-gray__value">
        <input
          type="text"
          className={`input canvas-target-gray__input${targetGrayDraftInvalid ? " input--invalid" : ""}`}
          inputMode="numeric"
          value={targetGrayDraft}
          placeholder={t("roi.targetGray.empty")}
          aria-label={t("roi.targetGray")}
          aria-invalid={targetGrayDraftInvalid}
          title={targetGrayDraftInvalid ? t("roi.targetGray.invalid") : t("roi.targetGray.title")}
          disabled={grayControls.targetDisabled}
          onChange={(event) => {
            setTargetGrayDraft(event.target.value);
            setTargetGrayDraftInvalid(false);
          }}
          onBlur={commitTargetGrayDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          data-empty={selectedTargetGray === null ? "true" : "false"}
        />
        {selectedTargetGray !== null && (
          <button
            type="button"
            className="canvas-target-gray__clear"
            aria-label={t("roi.targetGray.clear")}
            title={t("roi.targetGray.clear")}
            disabled={grayControls.targetDisabled}
            onClick={() => dispatch(setSelectedTargetGray({ value: null }))}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
          </button>
        )}
      </span>
    </div>
  );
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
    kind === "vector" || kind === "raster" || (kind === "roi" && hasPartialROI) ? (
    <label className="checkbox vacuum-switch app-switch canvas-grid-toggle canvas-scan-path-toggle">
      <input
        type="checkbox"
        checked={kind === "raster" ? roiState.raster_show_scan_path : roiState.vector_show_scan_path}
        onChange={(e) =>
          dispatch(updateROI(kind === "raster"
            ? { raster_show_scan_path: e.target.checked }
            : { vector_show_scan_path: e.target.checked }))
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

  const resetROIContext = useCallback(
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
  }, [clearCommittedGrayScaleSelection]);

  useEffect(() => {
    setPendingGrayScaleSelection(committedGrayScaleSelection);
    setPendingGrayScaleAnchor(null);
  }, [committedGrayScaleSelection]);

  useEffect(() => {
    setTargetGrayDraft(selectedTargetGray === null ? "" : String(selectedTargetGray));
    setTargetGrayDraftInvalid(false);
  }, [selectedTargetGray]);

  useEffect(() => {
    if (selectedTargetGray === null) return;
    setVectorGrayLevelsEnabled(false);
    setVectorGrayFilterApplied(false);
  }, [selectedTargetGray]);

  function commitTargetGrayDraft() {
    const text = targetGrayDraft.trim();
    if (text === "") {
      setTargetGrayDraftInvalid(false);
      if (selectedTargetGray !== null) dispatch(setSelectedTargetGray({ value: null }));
      return;
    }
    const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      setTargetGrayDraftInvalid(true);
      return;
    }
    setTargetGrayDraftInvalid(false);
    dispatch(setSelectedTargetGray({ value, point: null }));
  }

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

  const previousROISelectionKeyRef = useRef(roiSelectionKey);
  useEffect(() => {
    if (previousROISelectionKeyRef.current === roiSelectionKey) return;
    previousROISelectionKeyRef.current = roiSelectionKey;
    if (roiState.scanImageDataUrl) {
      dispatch(
        updateROI({
          imageName: t("roi.imageName.lastScan"),
          imageDataUrl: roiState.scanImageDataUrl,
          roiScanResultUrl: roiState.scanImageDataUrl,
          imageKind: "lastScan",
          scanImageDataUrl: null,
        })
      );
      resetROIContext({ preserveScanImage: true });
      return;
    }
    resetROIContext();
  }, [dispatch, resetROIContext, roiSelectionKey, roiState.scanImageDataUrl, t]);

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
    (scanKind: Extract<ScanKind, "raster" | "vector">, imageUrl: string | null, scanId: number) => {
      if (imageUrl) {
        // A later image of the same scan (final chunks, a re-render) replaces
        // that scan's entry; only a new scan pushes the previous result into
        // a "Previous scan" pane.
        const scanKey = `${scanKind}:${scanId}`;
        const sameScan = completedImageRecordedScanRef.current === scanKey;
        completedImageRecordedScanRef.current = scanKey;
        setCompletedImageHistory((current) => {
          const earlier = sameScan ? current[scanKind].slice(1) : current[scanKind];
          return {
            ...current,
            [scanKind]: [imageUrl, ...earlier.filter((item) => item !== imageUrl)].slice(0, 4),
          };
        });
        const scanKindLayout = imagePanelLayoutByKind[scanKind];
        if (scanKindLayout > 1 && sameScan) {
          // Address the scan by pane identity, never by identical PNG pixels.
          const recordedPane = completedImagePaneRef.current[scanKind];
          setImagePanelSlots((current) => ({
            ...current,
            [scanKind]: current[scanKind][recordedPane] === null
              ? current[scanKind]
              : replaceCompletedScanPane(current[scanKind], recordedPane, imageUrl),
          }));
        } else if (scanKindLayout === 1 && imagePanelSplitActive) {
          // Split mode is on (another view was split) but this view has not
          // been split yet: its first completed scan fills pane 1 and opens
          // pane 2 as the empty target for the next scan.
          completedImagePaneRef.current[scanKind] = 0;
          setImagePanelSlots((current) => ({ ...current, [scanKind]: [imageUrl, null] }));
          setImagePanelLayoutByKind((current) => ({ ...current, [scanKind]: 2 }));
          setSelectedImagePane((current) => ({ ...current, [scanKind]: 1 }));
          setScanTargetImagePane((current) => ({ ...current, [scanKind]: 1 }));
        } else if (scanKindLayout > 1) {
          // After the split, each completed scan opens the next empty pane
          // automatically unless the operator locked the current layout.
          completedImagePaneRef.current[scanKind] = imagePanelLocked
            ? scanTargetImagePane[scanKind]
            : scanKindLayout - 1;
          const placement = placeCompletedScan({
            slots: imagePanelSlots[scanKind],
            layout: scanKindLayout,
            selectedPane: scanTargetImagePane[scanKind],
            locked: imagePanelLocked,
            imageUrl,
          });
          setImagePanelSlots((current) => ({
            ...current,
            [scanKind]: placement.slots,
          }));
          setImagePanelLayoutByKind((current) => ({ ...current, [scanKind]: placement.layout }));
          setSelectedImagePane((current) => ({
            ...current,
            [scanKind]: placement.selectedPane,
          }));
          setScanTargetImagePane((current) => ({
            ...current,
            [scanKind]: placement.selectedPane,
          }));
        }
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
      imagePanelLayoutByKind,
      imagePanelLocked,
      imagePanelSlots,
      imagePanelSplitActive,
      scanTargetImagePane,
      selectedImagePane,
      t,
    ]
  );

  // Image the current target pane is showing right now. It must come from the
  // live canvas: an older scan kept in the history does not count once the
  // live image has been cleared (new scan started, resolution changed, reload).
  const liveScanImage =
    lastLiveScanImage && lastLiveScanImage.kind === kind ? lastLiveScanImage.imageUrl : null;
  const currentTargetImage =
    (kind === "raster" || kind === "vector") && liveScanImage
      ? imagePanelLayout === 1
        ? liveScanImage
        : imagePanelSlots[kind][imagePanelLayout - 1] ?? null
      : null;
  // Split is available before the first scan; an empty image opens empty panes.
  const showSplitButton = kind === "raster" || kind === "vector";
  const canSplitImagePanel = imagePanelLayout === 1;

  const splitImagePanel = useCallback(async () => {
    if (!canSplitImagePanel || (kind !== "raster" && kind !== "vector")) return;
    if (splitInFlightRef.current) return;
    setImagePanelLocked(true);
    const saved = savedSplitRef.current;
    if (saved) {
      setImagePanelLayoutByKind(saved.layouts);
      setSelectedImagePane(saved.selected);
      setScanTargetImagePane(saved.targets);
      completedImagePaneRef.current = saved.completed;
      setSinglePaneImages({ raster: null, vector: null });
      savedSplitRef.current = null;
      return;
    }
    completedImagePaneRef.current[kind] = 0;
    // Capture before moving the live canvas to the second pane. Acquisition
    // continues there while the first pane keeps this snapshot.
    const captured = captureScanImageRef.current?.();
    let imageUrl = captured?.kind === kind ? captured.imageUrl : currentTargetImage;
    splitInFlightRef.current = true;
    try {
      // The existing synchronous path preserves raw samples and scan identity.
      // Server/blob figures also need the patch's persistent image conversion.
      if (!captured || captured.kind !== kind || !captured.imageUrl.startsWith("data:")) {
        imageUrl = (await captureTargetImageRef.current?.()) ?? imageUrl;
      }
    } catch {
      // Keep the existing rendered result if a server figure cannot be read.
    } finally {
      splitInFlightRef.current = false;
    }
    if (captured?.kind === kind && !scanActive) {
      completedImageRecordedScanRef.current = `${kind}:${captured.scanId}`;
    }
    if (imageUrl) setLastLiveScanImage({ kind, imageUrl });
    // Preserve an existing image when available; otherwise open two empty panes.
    const targetPane = imageUrl === null ? 0 : 1;
    setImagePanelSlots((current) => ({ ...current, [kind]: [imageUrl, null] }));
    setImagePanelLayoutByKind((current) => ({ ...current, [kind]: 2 }));
    setSelectedImagePane((current) => ({ ...current, [kind]: targetPane }));
    setScanTargetImagePane((current) => ({ ...current, [kind]: targetPane }));
  }, [canSplitImagePanel, currentTargetImage, kind, scanActive]);

  const handleMergedFigureChange = useCallback(
    (scanKind: Extract<ScanKind, "raster" | "vector">, imageUrl: string | null) => {
      setMergedFigureByKind((current) =>
        current[scanKind] === imageUrl ? current : { ...current, [scanKind]: imageUrl }
      );
    },
    []
  );

  const handleImagePaneChange = useCallback(
    (scanKind: Extract<ScanKind, "raster" | "vector">, pane: number, imageUrl: string) => {
      setImagePanelSlots((current) => {
        const slots = [...current[scanKind]];
        slots[pane] = imageUrl;
        return { ...current, [scanKind]: slots };
      });
    },
    []
  );

  const handleImagePaneRecycle = useCallback(
    (scanKind: "raster" | "vector", pane: number) => {
      setImagePanelSlots((current) => ({
        ...current,
        [scanKind]: current[scanKind].map((image, index) => index === pane ? null : image),
      }));
      setSelectedImagePane((current) => ({ ...current, [scanKind]: pane }));
      setScanTargetImagePane((current) => ({ ...current, [scanKind]: pane }));
    },
    [],
  );

  const handleImagePaneSelect = useCallback(
    (scanKind: Extract<ScanKind, "raster" | "vector">, pane: number) => {
      setSelectedImagePane((current) =>
        current[scanKind] === pane ? current : { ...current, [scanKind]: pane }
      );
    },
    []
  );

  const handleSimulationImageChange = useCallback(
    (imageUrl: string | null) => {
      if (kind !== "raster" && kind !== "vector") return;
      const scanKind = kind;
      const pane = selectedImagePane[scanKind];

      // The picker also supplies the bitmap used by simulated scans through
      // ROI state. Mirror it into the active scan pane so selecting a source
      // never sends the operator to the ROI view to see what they just chose.
      setSinglePaneImages((current) => ({ ...current, [scanKind]: imageUrl }));
      setLastLiveScanImage((current) => current?.kind === scanKind ? null : current);
      if (imagePanelLayoutByKind[scanKind] > 1) {
        setImagePanelSlots((current) => {
          const slots = [...current[scanKind]];
          slots[pane] = imageUrl;
          return { ...current, [scanKind]: slots };
        });
        setScanTargetImagePane((current) => ({ ...current, [scanKind]: pane }));
      }
    },
    [imagePanelLayoutByKind, kind, selectedImagePane],
  );

  const handleTargetGrayPick = useCallback((gray: number, point: { x: number; y: number }) => {
    if (scanControlsSafetyDisabled || targetGrayRunning || phase === "stopping") return;
    setPendingTargetGrayPoint(point);
    setGrayScaleConfirmTarget("target");
    setPendingGrayScaleSelection([gray, gray]);
    setPendingGrayScaleAnchor(null);
    setPendingGrayScaleSkipped(false);
    setGrayScaleConfirmOpen(true);
  }, [scanControlsSafetyDisabled, targetGrayRunning, phase]);

  const handleGrayScaleSelect = useCallback((grayScale: number) => {
    setGrayScaleConfirmTarget("roi");
    setPendingGrayScaleSkipped(false);
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
  }, [grayScaleCommitCount, pendingGrayScaleAnchor, pendingGrayScaleSelection]);

  const handleGrayScaleConfirm = useCallback(() => {
    if (pendingGrayScaleSelection === null || pendingGrayScaleAnchor !== null) return;
    setPendingGrayScaleSkipped(false);
    setGrayScaleConfirmOpen(true);
  }, [pendingGrayScaleAnchor, pendingGrayScaleSelection]);

  const handleGrayScaleConfirmAccept = useCallback(() => {
    if (pendingGrayScaleSelection === null || pendingGrayScaleAnchor !== null) return;
    if (!scanActive) {
      dispatch(updateVector({ dwell: 2 }));
    }
    if (grayScaleConfirmTarget === "target") {
      dispatch(setSelectedTargetGray({ value: pendingGrayScaleSelection[0], point: pendingTargetGrayPoint }));
      setTargetGraySkipped(pendingGrayScaleSkipped ?? false);
      setPendingTargetGrayPoint(null);
    } else if (grayScaleConfirmTarget === "vector") {
      setVectorGrayLevelsEnabled(true);
      setVectorGrayFilterApplied(true);
      setAppliedVectorGrayRange([pendingGrayScaleSelection[0], pendingGrayScaleSelection[1]]);
      setVectorGrayScaleSkipped(pendingGrayScaleSkipped ?? false);
      vectorGrayRangeEditedRef.current = false;
      dispatch(setSelectedTargetGray({ value: null }));
      dispatch(updateVector({ pattern: "default", points: null }));
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
    pendingTargetGrayPoint,
    scanActive,
    roiState.imageKind,
    roiState.scanImageDataUrl,
  ]);

  const handleVectorGrayLevelsToggle = useCallback((checked: boolean) => {
    vectorGrayRangeEditedRef.current = false;
    setVectorGrayRange(appliedVectorGrayRange);
    setVectorGrayLevelsEnabled(checked);
    // Switching on only arms the sliders. A range becomes active exclusively
    // in the confirmation handler; switching off removes the current filter.
    if (!checked) setVectorGrayFilterApplied(false);
  }, [appliedVectorGrayRange]);

  useEffect(() => {
    if (!vectorGrayFilterActive || vectorLatencyBytes >= 8196) return;
    dispatch(updateVector({ latency_bytes: 8196 }));
  }, [dispatch, vectorGrayFilterActive, vectorLatencyBytes]);

  const handleVectorGrayRangeChange = useCallback((nextRange: [number, number]) => {
    const normalized = normalizeGrayScaleSelection(nextRange) ?? [0, 255];
    setVectorGrayRange((current) => {
      if (current[0] !== normalized[0] || current[1] !== normalized[1]) {
        vectorGrayRangeEditedRef.current = true;
      }
      return normalized;
    });
  }, []);

  const handleVectorGrayRangeSelect = useCallback((explicit = false) => {
    if (!shouldConfirmVectorGrayRange({
      enabled: vectorGrayLevelsEnabled,
      explicit,
      edited: vectorGrayRangeEditedRef.current,
      applied: vectorGrayFilterApplied,
      range: vectorGrayRange,
      appliedRange: appliedVectorGrayRange,
    })) return;
    vectorGrayRangeEditedRef.current = false;
    setGrayScaleConfirmTarget("vector");
    setPendingGrayScaleSelection(vectorGrayRange);
    setPendingGrayScaleAnchor(null);
    setPendingGrayScaleSkipped(false);
    setGrayScaleConfirmOpen(true);
  }, [vectorGrayLevelsEnabled, vectorGrayFilterApplied, vectorGrayRange, appliedVectorGrayRange]);

  const handleLoadLastScan = useCallback(() => {
    if (!roiScanImageUrl) return;
    suppressedROIScanImageUrlRef.current = null;
    setSuppressedROIScanImageUrl(null);
    resetROIContext({ clearSelection: true });
    dispatch(
      updateROI({
        imageName: t("roi.imageName.lastScan"),
        imageDataUrl: roiScanImageUrl,
        imageKind: "lastScan",
        imageBounds: null,
      })
    );
  }, [dispatch, resetROIContext, roiScanImageUrl, t]);

  function selectKind(nextKind: ScanKind) {
    if (nextKind === kind) return;
    if (scanActive) return;

    const nextScanKind = nextKind === "raster" || nextKind === "vector" ? nextKind : null;
    const currentScanKind = kind === "raster" || kind === "vector" ? kind : null;

    resetROIContext({ preserveScanImage: true, preserveGraySelection: true });

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
    dispatch(updateROI({ calibration_enabled: false }));
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

  function handleImagePanelLockChange(locked: boolean) {
    setImagePanelLocked(locked);
    if (locked) return;
    savedSplitRef.current = {
      layouts: imagePanelLayoutByKind,
      selected: selectedImagePane,
      targets: scanTargetImagePane,
      completed: { ...completedImagePaneRef.current },
    };
    // Keep the live scan pane as the single-pane source. The selected pane
    // may be an archived image, which has no live scan target for controls.
    setSinglePaneImages({ raster: null, vector: null });
    setImagePanelLayoutByKind({ raster: 1, vector: 1 });
    setSelectedImagePane({ raster: 0, vector: 0 });
    setScanTargetImagePane({ raster: 0, vector: 0 });
  }

  // Unlocked layouts keep their original navigation behavior. A locked layout
  // remains available while the operator visits another tab or route.
  function closeImagePanelSplit() {
    if (imagePanelLocked || savedSplitRef.current) return;
    setImagePanelLayoutByKind({ raster: 1, vector: 1 });
    completedImagePaneRef.current = { raster: 0, vector: 0 };
    setImagePanelSlots({ raster: [], vector: [] });
    setSelectedImagePane({ raster: 0, vector: 0 });
    setScanTargetImagePane({ raster: 0, vector: 0 });
  }

  function activateScanTopTab() {
    closeImagePanelSplit();
    setActiveTopTab("scan");
    activateScanSubTab(scanSubTab);
  }

  function activateCalibrateTopTab() {
    setActiveTopTab("calibrate");
    activateCalibrateSubTab(calibrateSubTab);
  }

  function handleSampleStageDockedChange(docked: boolean) {
    setSampleStageDocked(docked);
    setSampleStageMinimized(false);
    if (!docked) return;
    if (route !== "control") navigateTo("control");
    activateScanTopTab();
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
      rect.width - MIN_LEFT_PANEL_WIDTH - SPLITTER_SPACE - (showROIThirdColumn ? 236 : 0)
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

  // Raster and vector put the toolbar slot (gray level filter slider and
  // Select, or the annotation toolbox) and the Split button on a second
  // header row below the switches; ROI keeps its own header grid.
  const headerSecondRow =
    !adcView && (kind === "raster" || kind === "vector");
  const toolbarSlot = (
    <div
      id="image-panel-toolbar-slot"
      className={`card__header-toolbar-slot image-panel-card__toolbar-slot${kind === "vector" ? " image-panel-card__toolbar-slot--vector" : ""}`}
    >
      {(kind === "raster" || kind === "vector") && (
        <div className="scan-header-feature-panel scan-header-feature-panel--target-gray">
          {targetGrayControl}
        </div>
      )}
      {kind === "vector" ? (
        <section className="scan-header-feature-panel scan-header-feature-panel--gray-range">
          <div className="scan-header-feature-panel__heading">
            <label className="checkbox vacuum-switch app-switch canvas-grid-toggle vector-gray-level-toggle">
              <input
                type="checkbox"
                checked={vectorGrayLevelsEnabled}
                disabled={grayControls.filterDisabled}
                onChange={(event) => handleVectorGrayLevelsToggle(event.target.checked)}
              />
              <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
              {t("vector.grayLevels")}
            </label>
            <VectorGrayLevelHelp />
          </div>
          <VectorGrayLevelSelector
            enabled={vectorGrayLevelsEnabled}
            range={vectorGrayRange}
            disabled={grayControls.filterDisabled || !vectorGrayLevelsEnabled}
            onRangeChange={handleVectorGrayRangeChange}
            onRangeCommit={() => handleVectorGrayRangeSelect(false)}
            onSelect={() => handleVectorGrayRangeSelect(true)}
          />
        </section>
      ) : showGraySpectrum ? (
        <GrayScaleSpectrum
          selectedGrayScale={displayedROIGrayScaleSelection}
          selectionAnchor={pendingGrayScaleAnchor}
          levels={grayScaleLevels}
          sourceLabel={grayScaleSourceLabel}
          scopeNote={grayScaleScopeNote}
          onSelect={handleGrayScaleSelect}
        />
      ) : null}
      {shouldShowROIGrayScaleClear({ kind, grayFilterActive: roiGrayFilterActive }) && (
        <button
          type="button"
          className="btn btn--accent-solid image-panel-card__header-action"
          disabled={
            panelDisabled ||
            (pendingGrayScaleSelection === null &&
              committedGrayScaleSelection === null &&
              pendingGrayScaleAnchor === null)
          }
          onClick={handleClearROIGrayScaleValues}
          title={t("scan.clear")}
        >
          {t("scan.clear")}
        </button>
      )}
    </div>
  );

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
        vacuumControllerError={vacuumControllerError}
        onOpenSampleStage={() => {
          setSampleStageOpen(true);
          setSampleStageMinimized(false);
          if (kind === "raster" || kind === "vector") {
            setSampleStageDocked(false);
          }
          if (kind === "roi" && route !== "control") navigateTo("control");
        }}
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
            setPendingTargetGrayPoint(null);
            setGrayScaleCommitCount(0);
            if (grayScaleConfirmTarget === "vector") setVectorGrayRange(appliedVectorGrayRange);
            vectorGrayRangeEditedRef.current = false;
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
          showROIThirdColumn ? " app-main--with-roi-preview" : ""
        }`}
        style={layoutStyle}
      >
        {/* left column */}
        <section
          aria-disabled={vacuumControlsLocked}
          {...(vacuumControlsLocked ? { inert: "" } : {})}
          style={vacuumControlsLocked ? { opacity: 0.55 } : undefined}
        >
          <div
            className={`card scan-panel-card${activeScanColor ? " scan-panel-card--active" : ""}`}
            style={scanPanelStyle}
          >
            <div className="tabs tabs--top" role="tablist" aria-label={t("tabs.top.aria")}>
              <div className="tab-group tab-group--scan">
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
                <ScanModeHelp />
              </div>
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
            </div>
            {activeTopTab === "scan" ? (
              <div className="tabs tabs--sub" role="tablist" aria-label={t("tabs.scan.aria")}>
                <button
                  role="tab"
                  className="tab tab--sub"
                  aria-selected={scanSubTab === "raster"}
                  disabled={rasterVectorTabsDisabled}
                  onClick={() => {
                    closeImagePanelSplit();
                    activateScanSubTab("raster");
                  }}
                >
                  <Icon name="grid" tone="tab" />
                  {t("tabs.raster")}
                </button>
                <button
                  role="tab"
                  className="tab tab--sub"
                  aria-selected={scanSubTab === "vector"}
                  disabled={rasterVectorTabsDisabled}
                  onClick={() => {
                    closeImagePanelSplit();
                    activateScanSubTab("vector");
                  }}
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
              {activeTopTab === "scan" ? (
                scanSubTab === "raster" ? (
                  <>
                    <SimulationImageCard
                      disabled={panelDisabled}
                      lastScanImageUrl={roiScanImageUrl}
                      onLoadLastScan={handleLoadLastScan}
                      onImageChange={handleSimulationImageChange}
                    />
                    <CollapsibleScanParameters>
                      <div className="card__body">
                        <RasterParameters disabled={panelDisabled} />
                        <div ref={setValidatedActionsHost} className="validated-run-actions" />
                        <div ref={setValidationSummaryHost} className="validated-run-summary" />
                      </div>
                    </CollapsibleScanParameters>
                  </>
                ) : (
                  <>
                    <SimulationImageCard
                      disabled={panelDisabled}
                      lastScanImageUrl={roiScanImageUrl}
                      onLoadLastScan={handleLoadLastScan}
                      onImageChange={handleSimulationImageChange}
                    />
                    <CollapsibleScanParameters>
                      <div className="card__body">
                        <VectorParameters
                          disabled={panelDisabled}
                          grayLevelFilterActive={vectorGrayFilterActive}
                          showScanPathSettings={false}
                        />
                        <div ref={setValidatedActionsHost} className="validated-run-actions" />
                        <div ref={setValidationSummaryHost} className="validated-run-summary" />
                      </div>
                    </CollapsibleScanParameters>
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
              {activeTopTab === "scan" && (
                <>
                  <div className={`card scan-controls-card${activeScanColor ? " scan-controls-card--active" : ""}`}>
                      <div className="card__header">
                        <span className="card__title">{t("card.controls")}</span>
                        <button
                          type="button"
                          className="card__collapse-btn"
                          aria-expanded={!controlsCollapsed}
                          aria-label={controlsCollapsed ? t("controls.expand") : t("controls.collapse")}
                          title={controlsCollapsed ? t("controls.expand") : t("controls.collapse")}
                          onClick={() => setControlsCollapsed((collapsed) => !collapsed)}
                        >
                          <Icon name="chevronDown" />
                        </button>
                      </div>
                      {/* hidden, not unmounted: ScanControls owns the live scan stream */}
                      <div className="card__body" hidden={controlsCollapsed}>
                        <ScanControls
                          kind={scanSubTab}
                          disabled={panelDisabled}
                          scanActive={scanActive}
                          zoomDisabled={scanControlsSafetyDisabled}
                          vectorGrayScaleSelection={selectedTargetGray !== null
                            ? targetGrayFilter(selectedTargetGray).selection
                            : vectorGrayFilterActive ? appliedVectorGrayRange : null}
                          vectorGrayScaleSkipped={selectedTargetGray !== null
                            ? targetGraySkipped
                            : vectorGrayFilterActive ? vectorGrayScaleSkipped : null}
                          firstRowContent={(
                            <>
                              {scanSubTab === "vector" ? (
                                <VectorScanExecutionSettings disabled={panelDisabled} grayLevelFilterActive={vectorGrayFilterActive} />
                              ) : <RasterScanExecutionSettings disabled={panelDisabled} />}
                            </>
                          )}
                          onScanRunStart={setActiveScanType}
                          validatedActionsHost={validatedActionsHost}
                        />
                      </div>
                    </div>
                  <div className="card save-results-card">
                    <div className="card__header">
                      <span className="card__title">{t("card.runReport")}</span>
                      <button
                        type="button"
                        className="card__collapse-btn"
                        disabled={previewMode}
                        aria-expanded={!saveResultsCollapsed}
                        aria-label={saveResultsCollapsed ? t("saveResults.expand") : t("saveResults.collapse")}
                        title={saveResultsCollapsed ? t("saveResults.expand") : t("saveResults.collapse")}
                        onClick={() => setSaveResultsCollapsed((collapsed) => !collapsed)}
                      >
                        <Icon name="chevronDown" />
                      </button>
                    </div>
                    <div hidden={saveResultsCollapsed}>
                      <ValidationPanel
                        disabled={panelDisabled}
                        previewMode={previewMode}
                        mergedFigureUrl={
                          scanSubTab === "vector" ? mergedFigureByKind.vector : mergedFigureByKind.raster
                        }
                        liveFigureUrl={
                          lastLiveScanImage && lastLiveScanImage.kind === scanSubTab
                            ? lastLiveScanImage.imageUrl
                            : null
                        }
                        kindOverride={scanSubTab}
                        validationSummaryHost={validationSummaryHost}
                      />
                    </div>
                  </div>
                </>
              )}
              {adcTestEnabled && activeTopTab === "scan" && scanSubTab === "vector" && (
                <div className="card adc-test-card">
                  <div className="card__header">
                    <span className="card__title">{t("card.adcTest")}</span>
                    <button
                      type="button"
                      className="card__collapse-btn"
                      aria-expanded={!adcTestCollapsed}
                      aria-label={adcTestCollapsed ? t("adcTest.expand") : t("adcTest.collapse")}
                      title={adcTestCollapsed ? t("adcTest.expand") : t("adcTest.collapse")}
                      // Same locks as the old tab: can't open during a scan,
                      // can't close while the ADC stream is running.
                      disabled={adcTestCollapsed ? scanActive : adcActive}
                      onClick={() => setAdcTestCollapsed((collapsed) => !collapsed)}
                    >
                      <Icon name="chevronDown" />
                    </button>
                  </div>
                  {!adcTestCollapsed && (
                    <div className="card__body">
                      <AdcTestControls
                        state={adcTest.state}
                        onStart={adcTest.start}
                        onStop={adcTest.stop}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

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
              <div className={`card__header image-panel-card__header${scanPathToggle ? " image-panel-card__header--scan-path" : ""}${kind === "roi" ? " image-panel-card__header--roi" : ""}${headerSecondRow ? " image-panel-card__header--two-row" : ""}`}>
                <div className="image-panel-card__header-main">
                  <span className="card__title">{t(
                    adcView
                      ? "card.adcTimeline"
                      : imagePanelTitleKey
                  )}</span>
                  {headerSecondRow && (
                    // The vector View selector (Decimated / Native) is drawn
                    // here by the image canvas, next to the title.
                    <div id="image-panel-view-slot" className="image-panel-card__view-slot" />
                  )}
                  {!adcView && gridLineToggle}
                  {!adcView && kind === "roi" && roiState.calibration_enabled && (
                    <HelpPopover title={t("roi.calibration.helpTitle")} ariaLabel={t("roi.calibration.helpTitle")}>
                      <ol>
                        <li>{t("roi.calibration.helpImage")}</li>
                        <li>{t("roi.calibration.helpBounds")}</li>
                        <li>{t("roi.calibration.helpCoordinates")}</li>
                        <li>{t("roi.calibration.helpGrid")}</li>
                        <li>{t("roi.calibration.helpConfirm")}</li>
                      </ol>
                    </HelpPopover>
                  )}
                  {!adcView && scanPathToggle}
                  {!adcView && !headerSecondRow && toolbarSlot}
                </div>
                {headerSecondRow && (
                  // Second header row, below the switches: the gray level
                  // filter slider + Select (vector), the annotation toolbox,
                  // and the Split button.
                  <div className="image-panel-card__header-row">
                    {toolbarSlot}
                    {!adcView && activeTopTab === "scan" && showSplitButton && imagePanelSplitActive && (
                      <label className="checkbox vacuum-switch app-switch image-panel-card__layout-lock">
                        <input
                          type="checkbox"
                          checked={imagePanelLocked}
                          onChange={(event) => handleImagePanelLockChange(event.target.checked)}
                        />
                        <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
                        {t("canvas.layout.lock")}
                      </label>
                    )}
                    {!adcView && activeTopTab === "scan" && showSplitButton && (
                      <button
                        type="button"
                        className="btn btn--primary image-panel-card__layout-button"
                        aria-label={t("canvas.layout.cycle", { count: imagePanelLayout })}
                        aria-pressed={imagePanelLayout > 1}
                        aria-controls="image-panel-grid"
                        disabled={!canSplitImagePanel}
                        title={t("canvas.layout.cycle", { count: imagePanelLayout })}
                        onClick={splitImagePanel}
                      >
                        <Icon name="quad" tone="accent" />
                        <span>{t("canvas.layout.splitScreen")}</span>
                      </button>
                    )}
                  </div>
                )}
            </div>
            <div className="card__body">
                {adcView ? (
                  <AdcTimelineCanvas state={adcTest.state} />
              ) : kind === "roi" ? (
                  <ROIEditor
                    disabled={panelDisabled}
                    variant="canvas"
                    backgroundImageUrl={activeROIScanImageUrl}
                    grayScaleSelection={displayedROIGrayScaleSelection}
                    grayScaleSkipped={displayedROIGrayScaleSkipped}
                  />
              ) : kind === "mag" ? (
                <MagCalibrationChart />
              ) : (
                  <ImageCanvas
                    kind={kind as ScanKind}
                    captureRef={captureScanImageRef}
                    onTargetGrayPick={kind === "raster" || kind === "vector" ? handleTargetGrayPick : undefined}
                    onRenderedImageChange={handleRenderedImageChange}
                    onMergedFigureChange={handleMergedFigureChange}
                    onPaneImageChange={handleImagePaneChange}
                    onPaneRecycle={handleImagePaneRecycle}
                    captureTargetImageRef={captureTargetImageRef}
                  vectorGrayScaleSelection={selectedTargetGray !== null
                    ? targetGrayFilter(selectedTargetGray).selection
                    : vectorGrayFilterActive ? appliedVectorGrayRange : null}
                  vectorGrayScaleSkipped={selectedTargetGray !== null
                    ? targetGraySkipped
                    : vectorGrayFilterActive ? vectorGrayScaleSkipped : null}
                  singlePaneSourceIndex={
                    imagePanelLayout > 1
                      ? scanTargetImagePane[kind as "raster" | "vector"]
                      : savedSplitRef.current?.selected[kind as "raster" | "vector"] ?? 0
                  }
                  singlePaneImage={singlePaneImages[kind as "raster" | "vector"]}
                  imageLayout={imagePanelLayout}
                  imageSlots={imagePanelSlots[kind as "raster" | "vector"]}
                  selectedPane={selectedImagePane[kind as "raster" | "vector"]}
                  scanTargetPane={scanTargetImagePane[kind as "raster" | "vector"]}
                  onSelectedPaneChange={handleImagePaneSelect}
                />
              )}
            </div>
          </div>
        </section>

        {showROIThirdColumn && (
          <section className="roi-preview-column">
            {showROIPreviewSideCard && (
              <div className="card roi-preview-card">
                <div className="card__header">
                  <span className="card__title">{t("card.roiPreview")}</span>
                </div>
                <div className="card__body">
                  <ROIScanPreview backgroundImageUrl={activeROIScanImageUrl} />
                </div>
              </div>
            )}
            {showInlineSampleStage && (
              <SampleStageDashboard
                open
                minimized={false}
                variant="inline"
                previewImageUrl={sampleStagePreviewImageUrl}
                onDockedChange={handleSampleStageDockedChange}
                onActivityChange={setSampleStageControllerBusy}
                onMinimizedChange={setSampleStageMinimized}
                onClose={() => {
                  setSampleStageOpen(false);
                  setSampleStageMinimized(false);
                }}
              />
            )}
          </section>
        )}
      </main>
      )}

      <SettingsDialog
        targetAccountId={settingsTarget.accountId}
        targetLogin={settingsTarget.login}
        vectorGrayLevelsEnabled={vectorGrayFilterActive}
      />
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
      {!sampleStageDocked && (
        <SampleStageDashboard
          open={sampleStageOpen}
          minimized={sampleStageMinimized}
          onDockedChange={handleSampleStageDockedChange}
          onActivityChange={setSampleStageControllerBusy}
          onMinimizedChange={setSampleStageMinimized}
          onClose={() => {
            setSampleStageOpen(false);
            setSampleStageMinimized(false);
          }}
        />
      )}
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
            <button type="button" className="btn btn--cancel" onClick={onClose}>
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
    <div className={`vector-gray-levels${enabled ? "" : " vector-gray-levels--off"}`} aria-disabled={disabled}>
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
    </div>
  );
}

function GrayScaleSpectrum({
  selectedGrayScale,
  selectionAnchor,
  levels,
  sourceLabel,
  scopeNote,
  onSelect,
}: {
  selectedGrayScale: GrayScaleSelection;
  selectionAnchor: number | null;
  levels: number[];
  sourceLabel: string | null;
  scopeNote: string | null;
  onSelect: (grayScale: number) => void;
}) {
  const { t } = useTranslation();
  const boxes = buildGrayScaleBoxes(levels, selectedGrayScale);
  const hasPendingSelection = selectedGrayScale !== null && selectionAnchor === null;
  const selectedMin = selectedGrayScale ? Math.min(selectedGrayScale[0], selectedGrayScale[1]) : null;
  const selectedMax = selectedGrayScale ? Math.max(selectedGrayScale[0], selectedGrayScale[1]) : null;

  return (
    <div className="roi-spectrum" aria-label="Grayscale spectrum">
      <div className="roi-spectrum__topline">
        <span className="roi-spectrum__label">{t("roi.grayScale.rangeSelect")}</span>
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
        <div className="roi-spectrum__help">
          <GrayScaleHelp />
        </div>
      </div>
    </div>
  );
}

function buildGrayScaleBoxes(levels: number[], selectedGrayScale: GrayScaleSelection): number[] {
  if (!levels.length) return [];
  const min = levels[0];
  const max = levels[levels.length - 1];
  const boxes = [min];
  for (let value = min + 10; value < max; value += 10) boxes.push(value);
  if (max !== min) boxes.push(max);
  if (selectedGrayScale !== null) {
    const start = Math.max(0, Math.min(255, Math.min(selectedGrayScale[0], selectedGrayScale[1])));
    const end = Math.max(0, Math.min(255, Math.max(selectedGrayScale[0], selectedGrayScale[1])));
    boxes.push(start, end);
  }
  return [...new Set(boxes)].sort((a, b) => a - b);
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
