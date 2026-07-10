import { ScanType } from "../types/scanType.js";

export function shouldClearROIFeedbackBeforeRepeat(scanType: ScanType): boolean {
  return scanType === ScanType.CUSTOM_GRAY_FEEDBACK_BLANK;
}
