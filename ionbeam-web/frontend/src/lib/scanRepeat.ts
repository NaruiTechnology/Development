import { ScanType } from "../types/scanType.js";

export function repeatCountdownDisplay(
  configuredRepeat: number,
  cyclesRemaining: number,
  loopActive: boolean,
): number {
  const configured = Math.max(1, Math.trunc(configuredRepeat));
  if (!loopActive) return configured;
  return Math.max(1, Math.trunc(cyclesRemaining));
}

export function shouldClearROIFeedbackBeforeRepeat(
  scanType: ScanType,
  cyclesRemaining: number,
): boolean {
  return scanType === ScanType.CUSTOM_GRAY_FEEDBACK_BLANK && cyclesRemaining > 0;
}

export function shouldRetainROIFeedbackOnComplete(
  scanType: ScanType,
  cyclesRemaining: number,
): boolean {
  return scanType !== ScanType.CUSTOM_GRAY_FEEDBACK_BLANK || cyclesRemaining <= 1;
}

/** Most passes one Repeat session may run (the Repeat field's limit). */
export const MAX_REPEAT_FRAMES = 50;

/**
 * Repeat N as ONE live session: `continuous` + `frames = N`, so external
 * control is taken once at Run, held for every pass and handed back after
 * the last. N may be computed by the caller at Run time; it is clamped to
 * 1..MAX_REPEAT_FRAMES. Returns null for a single pass (a plain run).
 */
export function repeatSessionRequest<T extends object>(
  req: T,
  repeat: number,
): { req: T & { continuous: true; frames: number }; frames: number } | null {
  const frames = Math.max(1, Math.min(MAX_REPEAT_FRAMES, Math.trunc(Number(repeat) || 1)));
  if (frames <= 1) return null;
  return { req: { ...req, continuous: true, frames }, frames };
}
