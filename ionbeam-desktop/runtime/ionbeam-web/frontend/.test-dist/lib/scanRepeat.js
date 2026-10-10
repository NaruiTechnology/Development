import { ScanType } from "../types/scanType.js";
export function repeatCountdownDisplay(configuredRepeat, cyclesRemaining, loopActive) {
    const configured = Math.max(1, Math.trunc(configuredRepeat));
    if (!loopActive)
        return configured;
    return Math.max(1, Math.trunc(cyclesRemaining));
}
export function shouldClearROIFeedbackBeforeRepeat(scanType, cyclesRemaining) {
    return scanType === ScanType.CUSTOM_GRAY_FEEDBACK_BLANK && cyclesRemaining > 0;
}
export function shouldRetainROIFeedbackOnComplete(scanType, cyclesRemaining) {
    return scanType !== ScanType.CUSTOM_GRAY_FEEDBACK_BLANK || cyclesRemaining <= 1;
}
