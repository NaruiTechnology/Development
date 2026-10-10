export function clampGrayScale(value) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return 0;
    return Math.max(0, Math.min(255, Math.round(n)));
}
export function normalizeGrayScaleSelection(selection) {
    if (!selection)
        return null;
    const lo = clampGrayScale(Math.min(selection[0], selection[1]));
    const hi = clampGrayScale(Math.max(selection[0], selection[1]));
    return [lo, hi];
}
export function grayScaleSelectionContains(selection, value) {
    if (!selection)
        return false;
    const n = clampGrayScale(value);
    return n >= selection[0] && n <= selection[1];
}
export function formatGrayScaleSelection(selection) {
    if (!selection)
        return "";
    return selection[0] === selection[1] ? String(selection[0]) : `${selection[0]}-${selection[1]}`;
}
