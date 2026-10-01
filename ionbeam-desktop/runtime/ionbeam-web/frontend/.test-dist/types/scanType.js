export var ScanType;
(function (ScanType) {
    ScanType["RASTER"] = "RASTER";
    ScanType["VECTOR"] = "VECTOR";
    ScanType["VECTOR_ADAPTIVE_GRAN_FEED_BLANK"] = "VECTOR_ADAPTIVE_GRAN_FEED_BLANK";
    ScanType["CUSTOM_RASTER"] = "CUSTOM_RASTER";
    ScanType["CUSTOM_GRAY_FEEDBACK_BLANK"] = "CUSTOM_GRAY_FEEDBACK_BLANK";
})(ScanType || (ScanType = {}));
export const SCAN_TYPE_COLORS = {
    [ScanType.RASTER]: "lawngreen",
    [ScanType.VECTOR]: "yellow",
    [ScanType.VECTOR_ADAPTIVE_GRAN_FEED_BLANK]: "pink",
    [ScanType.CUSTOM_RASTER]: "green",
    [ScanType.CUSTOM_GRAY_FEEDBACK_BLANK]: "red",
};
