export enum ScanType {
  RASTER = "RASTER",
  VECTOR = "VECTOR",
  VECTOR_ADAPTIVE_GRAN_FEED_BLANK = "VECTOR_ADAPTIVE_GRAN_FEED_BLANK",
  CUSTOM_RASTER = "CUSTOM_RASTER",
  CUSTOM_GRAY_FEEDBACK_BLANK = "CUSTOM_GRAY_FEEDBACK_BLANK",
}

export const SCAN_TYPE_COLORS: Record<ScanType, string> = {
  [ScanType.RASTER]: "lawngreen",
  [ScanType.VECTOR]: "yellow",
  [ScanType.VECTOR_ADAPTIVE_GRAN_FEED_BLANK]: "pink",
  [ScanType.CUSTOM_RASTER]: "green",
  [ScanType.CUSTOM_GRAY_FEEDBACK_BLANK]: "red",
};
