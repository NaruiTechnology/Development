/**
 * A single AG Grid Theming-API theme shared by every admin data grid (Equipment, Calibration matrix, ...).
 *
 * Values are CSS `var(--c-*)` references into styles/theme.css rather than literal colors, so the grid
 * automatically follows the active [data-theme] (navy / black / light) with no extra wiring.
 */
import { ModuleRegistry, AllCommunityModule, themeQuartz } from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);

export const adminGridTheme = themeQuartz.withParams({
  backgroundColor: "var(--c-bg-elev)",
  foregroundColor: "var(--c-text)",
  headerBackgroundColor: "var(--c-bg-elev-2)",
  headerTextColor: "var(--c-text)",
  headerFontWeight: 700,
  borderColor: "var(--c-border)",
  rowBorder: true,
  wrapperBorder: true,
  rowHoverColor: "var(--c-btn-hover)",
  chromeBackgroundColor: "var(--c-bg-elev-2)",
  fontFamily: "var(--font-sans)",
  fontSize: 12.5,
  cellHorizontalPadding: 10,
  headerHeight: 34,
  rowHeight: 38,
  accentColor: "var(--c-accent)",
  inputBackgroundColor: "var(--c-bg-input)",
  inputBorder: { color: "var(--c-border)", style: "solid", width: 1 },
  inputFocusBorder: { color: "var(--c-accent)", style: "solid", width: 1 },
  spacing: 6,
  borderRadius: 6,
  wrapperBorderRadius: 8,
});
