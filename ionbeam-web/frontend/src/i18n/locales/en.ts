/**
 * English translation table — canonical schema.
 *
 * Every other locale is typed as Partial<TranslationTable> and merged
 * over this object at module load, so:
 *   - missing keys in a non-English file fall back to English (loud
 *     but harmless — better than a blank UI cell)
 *   - new keys added here become a TS compile error in zh-CN / zh-TW
 *     if you forget to translate them (the partial gets a fresh
 *     optional field that the IDE flags via the missing-translation
 *     audit script in i18n/audit.ts — see the integration guide)
 *
 * Naming convention: `area.subarea.purpose`, all lowercase, dot-
 * separated. Keep keys stable; translators reuse them across changes.
 *
 * Placeholder syntax: `{name}` — see translate() in ../index.ts. Always
 * use named placeholders, never positional, because Chinese sentence
 * order differs from English for compound values (e.g. "{count} chunks
 * of {bytes} bytes" → "每块 {bytes} 字节，共 {count} 块").
 */

export const en = {
  /* ===== app chrome ================================================ */
  "app.documentTitle": "Ion Beam Technology — Control Panel",
  "app.brand.name": "Ion Beam Technology",
  "app.brand.tagline": "Beam Control Console",
  "app.footer.copyright": "© Ion Beam Technology Ltd",
  "app.footer.build": "Glasgow rev C3 · OBI-derived FPGA pipeline",

  /* ===== header =================================================== */
  "header.theme.label": "Theme",
  "header.theme.navy": "Navy",
  "header.theme.black": "Black",
  "header.theme.light": "Light",
  "header.theme.navy.title": "Default Ion Beam navy theme",
  "header.theme.black.title": "OLED-friendly black theme for low-ambient labs",
  "header.theme.light.title": "Light theme for daylight monitors",
  "header.language.label": "Language",
  "header.language.title": "Interface language",
  "header.state.idle": "Idle",
  "header.state.busy": "Scanning",
  "header.state.connecting": "Connecting",
  "header.state.error": "Error",
  "header.state.disconnected": "Disconnected",
  "header.scans": "scans: {count}",
  "header.reconnect": "Reconnect",
  "header.reconnect.title": "Drop and re-establish the USB connection (POST /admin/reconnect)",

  /* ===== top-level tabs =========================================== */
  "tabs.aria": "Scan kind",
  "tabs.roi": "ROI",
  "tabs.raster": "Raster",
  "tabs.vector": "Vector",
  "tabs.roi.title": "Edit ROI",
  "tabs.roi.title.disabled": "ROI is inactive while a scan is running",

  /* ===== card titles ============================================== */
  "card.controls": "Controls",
  "card.runReport": "Run report",
  "card.rasterImage": "Raster image",
  "card.vectorPattern": "Vector pattern",
  "card.roiPreview": "ROI preview",
  "card.validatedRunOptions": "Validated run options",

  /* ===== scan controls (buttons) ================================== */
  "scan.run": "Run",
  "scan.pause": "Pause",
  "scan.pausing": "Pausing...",
  "scan.stop": "Stop",
  "scan.runValidated": "Run validated",
  "scan.clear": "Clear",
  "scan.busy.title": "Scan in progress",
  "scan.run.title.start": "Open a WebSocket and stream chunks live",
  "scan.run.title.paused": "Start a fresh scan (the kept image will be replaced)",
  "scan.pause.title": "End the scan but keep the partial image on the canvas",
  "scan.stop.title": "End the scan and clear the canvas",
  "scan.runValidated.title": "POST /scan/{kind}/run — returns timing + validation report",

  /* ===== raster parameter form ==================================== */
  "raster.resolution": "Resolution",
  "raster.dwell": "Dwell",
  "raster.latencyBytes": "Latency (bytes)",
  "raster.cookie": "Cookie",
  "raster.outputMode": "Output mode",
  "raster.frameBlank": "Frame blank (start and end blanked)",
  "raster.doValidate": "Run chunk-count / size / padding checks",
  "raster.footnote": "Validation applies to <Run validated>. After any scan completes, use the <Download CSV> / <Download figure> buttons in the Run report to export the data.",

  /* ===== vector parameter form ==================================== */
  "vector.pattern": "Pattern",
  "vector.pattern.default": "Default sweep (full DAC range)",
  "vector.pattern.custom": "Custom points",
  "vector.resolution": "Resolution (samples per axis)",
  "vector.resolution.option.2048": "2048 × 2048 — native (stride 1)",
  "vector.resolution.option.1024": "1024 × 1024 — stride 2",
  "vector.resolution.option.512": "512 × 512 — stride 4",
  "vector.resolution.option.256": "256 × 256 — stride 8",
  "vector.resolution.help": "Smaller resolution → faster scan, sparser sampling. Coverage is always the full 0..2047 DAC range.",
  "vector.resolution.title.native": "Native: every DAC code is sampled.",
  "vector.resolution.title.stride": "Stride {stride}: every {stride}th DAC code is sampled. Full DAC range still covered.",
  "vector.latencyBytes": "Latency (bytes)",
  "vector.outputMode": "Output mode",
  "vector.cookie": "Cookie",
  "vector.customPoints.label": "Custom points (x,y,dwell per line)",
  "vector.customPoints.error.tooMany": "too many points: {count} > {max}",
  "vector.customPoints.error.format": "line {line}: expected \"x,y,dwell\"",
  "vector.customPoints.count": "{count} points",
  "vector.customPoints.empty": "0 points",
  "vector.preProcess": "Pre-process chunks (timed separately as process_time_s)",
  "vector.doValidate": "Run non-empty / padding checks",

  /* ===== ROI editor =============================================== */
  "roi.select": "SELECT",
  "roi.clearImage": "Clear image",
  "roi.clearRegion": "Clear region",
  "roi.xOrigin": "X origin",
  "roi.xEnd": "X end",
  "roi.yOrigin": "Y origin",
  "roi.yEnd": "Y end",
  "roi.start": "Start (x, y)",
  "roi.end": "End (x, y)",
  "roi.showGrid": "Display grid line",
  "roi.keepBitmap": "Keep loaded bitmap after scan",
  "roi.scaleUnit": "Scale unit",
  "roi.dacEquivalent": "DAC equivalent:",
  "roi.dacMappingNote": "(out of 0..16383; the full DAC range covers your {xRange} × {yRange} {unit} field of view)",
  "roi.imageName.lastScan": "Last scan image",
  "roi.error.rangeXLessThanEnd": "0 and {max} (less than X end)",
  "roi.error.rangeXGreaterThanOrigin": "{min} and 16383 (greater than X origin)",
  "roi.error.rangeYLessThanEnd": "0 and {max} (less than Y end)",
  "roi.error.rangeYGreaterThanOrigin": "{min} and 16383 (greater than Y origin)",
  "roi.error.numericRange": "! {label} must be between {range}.",
  "roi.error.pointFormat": "! {label} must use x, y numbers with up to 1 decimal place.",
  "roi.error.startXBounds": "Start x must be between X origin {origin} and X end {end}.",
  "roi.error.startYBounds": "Start y must be between Y origin {origin} and Y end {end}.",
  "roi.error.endXBounds": "End x must be between X origin {origin} and X end {end}.",
  "roi.error.endYBounds": "End y must be between Y origin {origin} and Y end {end}.",
  "roi.error.startXLessThanEnd": "Start x must be less than End x {end}.",
  "roi.error.startYLessThanEnd": "Start y must be less than End y {end}.",
  "roi.error.endXGreaterThanStart": "End x must be greater than Start x {start}.",
  "roi.error.endYGreaterThanStart": "End y must be greater than Start y {start}.",
  "roi.canvas.start": "Start {point} {unit}",
  "roi.canvas.end": "End {point} {unit}",

  /* ===== image canvas / meta ====================================== */
  "canvas.view": "View",
  "canvas.view.decimated": "Decimated ({edge}×{edge})",
  "canvas.view.native": "Native ({edge}×{edge})",
  "canvas.view.decimated.title": "Dense {edge}×{edge} image — pixels = sample indices",
  "canvas.view.native.title": "Native {edge}×{edge} with stride {stride} block-fill — pixels = DAC codes",
  "canvas.view.identical": "stride 1 — both views are identical",
  "canvas.serverFigure.rendering": "Rendering server figure...",
  "canvas.serverFigure.unavailable": "Server figure unavailable: {detail}",
  "canvas.serverFigure.livePreview": "Using live preview.",
  "canvas.serverFigure.alt": "{kind} scan rendered by glasgow_service",
  "canvas.meta.phase": "phase",
  "canvas.meta.chunks": "chunks",
  "canvas.meta.bytes": "bytes",
  "canvas.meta.resolution": "resolution",
  "canvas.meta.pixels": "pixels",
  "canvas.meta.samples": "samples",
  "canvas.meta.roi": "ROI",
  "canvas.meta.beam": "beam",
  "canvas.meta.adcNow": "ADC now",
  "canvas.meta.adcRange": "ADC",
  "canvas.meta.roi.title": "Active 2-D DUT-mapped scan region from the ROI editor.",
  "canvas.meta.beam.title": "Current beam position derived from the latest received ADC sample index.",
  "canvas.meta.adcNow.title": "ADC value at the current beam position.",
  "canvas.meta.adcRange.title": "Raw ADC range in the received samples. Canvas auto-scales this range into visible grayscale.",

  /* ===== phase enum (displayed verbatim today; localised here) ==== */
  "phase.idle": "idle",
  "phase.running": "running",
  "phase.stopping": "stopping",
  "phase.paused": "paused",
  "phase.completed": "completed",
  "phase.error": "error",

  /* ===== validation panel ========================================= */
  "validation.empty": "No completed scan yet. Press <Run> for a live stream, or <Run validated> for timing + checks. After either, you'll be able to download CSV and PNG figure here.",
  "validation.streamCompleted": "Live stream completed. Validation report is only generated by <Run validated> — but the data is still downloadable.",
  "validation.deviceError": "Device connection error",
  "validation.autoDownload": "Auto download",
  "validation.selectFolder": "Select folder",
  "validation.folder.default": "~/Downloads",
  "validation.folder.unavailable": "Folder selection is unavailable in this browser; using the browser Downloads folder.",
  "validation.autoDownload.error": "Auto download: {detail}",
  "validation.downloadCsv": "Download CSV",
  "validation.downloadCsv.fetching": "Fetching CSV...",
  "validation.downloadCsv.title": "Download the most recent scan's data as CSV",
  "validation.downloadFigure": "Download figure (PNG)",
  "validation.downloadFigure.rendering": "Rendering...",
  "validation.downloadFigure.title": "Render the most recent scan as a matplotlib PNG and download",
  "validation.csvError": "CSV: {detail}",
  "validation.figureError": "Figure: {detail}",
  "validation.title": "Validation",
  "validation.allPassed": "All checks passed",
  "validation.failures": "Failures",
  "validation.check.pass": "PASS",
  "validation.check.fail": "FAIL",
  "validation.meta.kind": "kind",
  "validation.meta.chunks": "chunks",
  "validation.meta.bytes": "bytes",
  "validation.meta.pixelsPerChunk": "pixels/chunk",
  "validation.meta.send": "send",
  "validation.meta.process": "process",

  /* ===== error wedge ============================================== */
  "error.label": "Error",

  /* ===== help popover chrome ====================================== */
  "help.close": "Close",
  "help.ariaSuffix": "open help",

  /* ===== help popovers — titles & aria labels ===================== *
   * Bodies live in i18n/help/<locale>.tsx as JSX (too markup-heavy
   * for flat strings). These are the modal headers and the
   * "What does X do?" tooltip on the trigger button.                */
  "help.dwell.title": "Dwell — supersampler control",
  "help.dwell.aria": "What does the dwell field do?",
  "help.resolution.title": "Resolution — pixel grid size",
  "help.resolution.aria": "What does the resolution field do?",
  "help.latency.title": "Latency — chunk size on the USB pipeline",
  "help.latency.aria": "What does the latency field do?",
  "help.cookie.title": "Cookie — synchronization tag",
  "help.cookie.aria": "What does the cookie field do?",
  "help.outputMode.title": "Output mode — sample bit depth",
  "help.outputMode.aria": "What does the output mode field do?",
  "help.frameBlank.title": "Frame blank — beam state between frames",
  "help.frameBlank.aria": "What does the frame blank field do?",
  "help.validation.title": "Validation — post-scan integrity checks",
  "help.validation.aria": "What does the validation field do?",
  "help.pattern.title": "Pattern — default sweep vs custom points",
  "help.pattern.aria": "What does the pattern field do?",
  "help.vectorResolution.title": "Vector resolution — default-sweep density",
  "help.vectorResolution.aria": "What does the vector resolution field do?",
  "help.customPoints.title": "Custom points — input format",
  "help.customPoints.aria": "What format do custom points use?",
  "help.preProcess.title": "Pre-process chunks — encode up-front vs lazily",
  "help.preProcess.aria": "What does the pre-process chunks field do?",
} as const;

/** Type derived from the canonical table — `keyof TranslationTable` is
 *  the union of all valid keys, so `t("typo")` fails the build. */
export type TranslationTable = Record<keyof typeof en, string>;
