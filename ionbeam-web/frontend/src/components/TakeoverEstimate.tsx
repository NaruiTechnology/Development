/**
 * The calculated takeover for the scan Run would start: how long external
 * control will be held (frames x frame time + relay switching), and what
 * Frame blank does between frames. Only scans that use the hardware take
 * over (IsProduction=true, or simulation switched off); a simulated scan
 * says so instead.
 *
 * The scan itself is not timed by this: it takes control when it starts and
 * hands back when its last frame ends (lib/takeoverTiming.ts).
 */
import { useAppSelector } from "../store";
import { useTranslation } from "../i18n";
import { formatDuration } from "../lib/scanTiming";
import {
  estimateTakeover,
  scansUseHardware,
  takeoverPlanForScan,
  type TakeoverEstimate,
  type TakeoverPlan,
} from "../lib/takeoverTiming";

export function useScanTakeoverPlan(kind: "raster" | "vector", repeat: number): TakeoverPlan {
  const raster = useAppSelector((s) => s.scan.raster);
  const vector = useAppSelector((s) => s.scan.vector);
  const defaults = useAppSelector((s) => s.status.defaults);
  const switchDelay = Number(defaults?.takeover?.ext_switch_delay_ms);
  const adcHalfPeriod = Number((defaults?.adc as Record<string, unknown> | undefined)?.adcHalfPeriod);
  const defaultFrameBlank = (defaults?.raster_params as Record<string, unknown> | undefined)?.frame_blank;
  return takeoverPlanForScan({
    kind,
    raster: { resolution: raster.resolution, dwell: raster.dwell, frame_blank: raster.frame_blank },
    vector: {
      pattern: vector.pattern,
      vector_resolution: vector.vector_resolution,
      scan_path: vector.scan_path,
      points: vector.points,
      dwell: vector.dwell,
    },
    repeat,
    defaultFrameBlank: typeof defaultFrameBlank === "boolean" ? defaultFrameBlank : raster.frame_blank,
    switchDelayMs: Number.isFinite(switchDelay) ? switchDelay : undefined,
    adcHalfPeriod: Number.isFinite(adcHalfPeriod) ? adcHalfPeriod : undefined,
  });
}

/** The browser's session simulation override, else the service default. */
export function useSimulationSettings(): Record<string, unknown> | null {
  const session = useAppSelector((s) => s.status.sessionSimulation);
  const defaults = useAppSelector((s) => s.status.defaults?.simulation ?? null);
  return session ?? defaults;
}

/** Scans (and so the takeover) use the hardware: the service's rule. */
export function useScansUseHardware(): boolean {
  const isProduction = useAppSelector((s) => s.status.defaults?.is_production);
  return scansUseHardware(isProduction, useSimulationSettings());
}

export function TakeoverEstimateLine({
  estimate,
  usesHardware,
  infinite = false,
}: {
  estimate: TakeoverEstimate;
  usesHardware: boolean;
  infinite?: boolean;
}) {
  const { t } = useTranslation();
  const frames = estimate.frames ?? 1;
  const blank = t(estimate.frameBlank ? "takeover.frameBlank.on" : "takeover.frameBlank.off");
  const total = estimate.totalSeconds == null ? null : formatDuration(estimate.totalSeconds);
  const text = !usesHardware
    ? t("takeover.simulation", { total: total ?? t("takeover.untilStop") })
    : infinite || estimate.totalSeconds == null
      ? t("takeover.infinite", { frame: formatDuration(estimate.frameSeconds), blank })
      : t("takeover.estimate", {
        total: total as string,
        frames,
        frame: formatDuration(estimate.frameSeconds),
        blank,
      });
  return (
    <p className="takeover-estimate" data-hardware={usesHardware ? "true" : "false"}>
      {text}
    </p>
  );
}

/** Takeover line for the scan controls (Raster / Vector). */
export function ScanTakeoverEstimate({ kind, repeat }: { kind: "raster" | "vector"; repeat: number }) {
  const plan = useScanTakeoverPlan(kind, repeat);
  const usesHardware = useScansUseHardware();
  return <TakeoverEstimateLine estimate={estimateTakeover(plan)} usesHardware={usesHardware} />;
}
