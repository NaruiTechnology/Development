import { ScanType } from "../types/scanType.js";

export function shouldClearROIFeedbackBeforeRepeat(
  scanType: ScanType,
  cyclesRemaining: number,
): boolean {
  return scanType === ScanType.CUSTOM_GRAY_FEEDBACK_BLANK && cyclesRemaining > 0;
}
