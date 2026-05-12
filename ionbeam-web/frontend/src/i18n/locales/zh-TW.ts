/**
 * Traditional Chinese (zh-TW) translation table.
 *
 * Differs from zh-CN in two ways:
 *   1) Character set — uses traditional forms throughout (光柵 not 光栅,
 *      矢量 not 矢量 [same], 數據 / 資料 etc.). We use Taiwan-Mandarin
 *      conventions, which are also broadly intelligible to Hong Kong
 *      and Macau operators.
 *   2) Terminology — Taiwan / Hong Kong technical Chinese often
 *      differs lexically from mainland conventions even when the
 *      character forms would otherwise overlap:
 *
 *         zh-CN              zh-TW              English
 *         ─────              ─────              ───────
 *         数据 / 数据块      資料 / 資料區塊    data / chunk
 *         分辨率             解析度             resolution
 *         默认               預設               default
 *         有效               有效 / 啟用        active / enabled
 *         视频               視訊               video (n/a here)
 *         运行               執行               run
 *         编辑               編輯               edit
 *         连接               連線 / 連接        connect
 *         位图               點陣圖             bitmap
 *         流                 串流               stream
 *         字节               位元組             byte
 *
 * Brand strings and acronyms (Ion Beam Technology, DAC, ADC, FPGA,
 * USB, ROI, CSV, PNG, OBI) stay in English as in zh-CN.
 */
import type { TranslationTable } from "./en";

export const zhTW: Partial<TranslationTable> = {
  /* ===== app chrome ================================================ */
  "app.documentTitle": "Ion Beam Technology — 控制面板",
  "app.brand.name": "Ion Beam Technology",
  "app.brand.tagline": "束流控制台",
  "app.footer.copyright": "© Ion Beam Technology Ltd",
  "app.footer.build": "Glasgow rev C3 · 基於 OBI 的 FPGA 流水線",

  /* ===== header =================================================== */
  "header.theme.label": "主題",
  "header.theme.navy": "海軍藍",
  "header.theme.black": "純黑",
  "header.theme.light": "淺色",
  "header.theme.navy.title": "Ion Beam 預設海軍藍主題",
  "header.theme.black.title": "適用於低環境光實驗室的 OLED 友善純黑主題",
  "header.theme.light.title": "適用於日光下螢幕的淺色主題",
  "header.language.label": "語言",
  "header.language.title": "介面語言",
  "header.state.idle": "閒置",
  "header.state.busy": "掃描中",
  "header.state.connecting": "連線中",
  "header.state.error": "錯誤",
  "header.state.disconnected": "已中斷連線",
  "header.scans": "掃描次數：{count}",
  "header.reconnect": "重新連線",
  "header.reconnect.title": "中斷並重新建立 USB 連線（POST /admin/reconnect）",

  /* ===== top-level tabs =========================================== */
  "tabs.aria": "掃描類型",
  "tabs.roi": "ROI",
  "tabs.raster": "光柵",
  "tabs.vector": "矢量",
  "tabs.roi.title": "編輯 ROI",
  "tabs.roi.title.disabled": "掃描執行期間 ROI 無法使用",

  /* ===== card titles ============================================== */
  "card.controls": "控制",
  "card.runReport": "執行報告",
  "card.rasterImage": "光柵影像",
  "card.vectorPattern": "矢量圖樣",
  "card.roiPreview": "ROI 預覽",
  "card.validatedRunOptions": "驗證執行選項",

  /* ===== scan controls (buttons) ================================== */
  "scan.run": "執行",
  "scan.pause": "暫停",
  "scan.pausing": "正在暫停…",
  "scan.stop": "停止",
  "scan.runValidated": "驗證執行",
  "scan.clear": "清除",
  "scan.busy.title": "掃描進行中",
  "scan.run.title.start": "開啟 WebSocket 並即時串流資料區塊",
  "scan.run.title.paused": "開始新的掃描（保留的影像將被取代）",
  "scan.pause.title": "結束掃描但保留畫布上的部分影像",
  "scan.stop.title": "結束掃描並清空畫布",
  "scan.runValidated.title": "POST /scan/{kind}/run — 回傳耗時與驗證報告",

  /* ===== raster parameter form ==================================== */
  "raster.resolution": "解析度",
  "raster.dwell": "駐留",
  "raster.latencyBytes": "延遲（位元組）",
  "raster.cookie": "Cookie",
  "raster.outputMode": "輸出模式",
  "raster.frameBlank": "畫面消隱（開始與結束時消隱）",
  "raster.doValidate": "執行資料區塊計數 / 大小 / 填充檢查",
  "raster.footnote": "驗證僅對<驗證執行>生效。掃描完成後，請使用執行報告中的<下載 CSV> / <下載影像>按鈕匯出資料。",

  /* ===== vector parameter form ==================================== */
  "vector.pattern": "圖樣",
  "vector.pattern.default": "預設掃描（涵蓋整個 DAC 範圍）",
  "vector.pattern.custom": "自訂點列",
  "vector.resolution": "解析度（每軸取樣數）",
  "vector.resolution.option.2048": "2048 × 2048 — 原生（步長 1）",
  "vector.resolution.option.1024": "1024 × 1024 — 步長 2",
  "vector.resolution.option.512": "512 × 512 — 步長 4",
  "vector.resolution.option.256": "256 × 256 — 步長 8",
  "vector.resolution.help": "解析度越小 → 掃描越快、取樣越稀疏。涵蓋範圍始終為完整的 0..2047 DAC 範圍。",
  "vector.resolution.title.native": "原生：取樣每個 DAC 碼值。",
  "vector.resolution.title.stride": "步長 {stride}：每 {stride} 個 DAC 碼值取樣一次。仍涵蓋完整的 DAC 範圍。",
  "vector.latencyBytes": "延遲（位元組）",
  "vector.outputMode": "輸出模式",
  "vector.cookie": "Cookie",
  "vector.customPoints.label": "自訂點列（每行一個 x,y,駐留）",
  "vector.customPoints.error.tooMany": "點數過多：{count} > {max}",
  "vector.customPoints.error.format": "第 {line} 行：應為 \"x,y,駐留\"",
  "vector.customPoints.count": "{count} 個點",
  "vector.customPoints.empty": "0 個點",
  "vector.preProcess": "預先處理資料區塊（單獨計入 process_time_s 時間）",
  "vector.doValidate": "執行非空 / 填充檢查",

  /* ===== ROI editor =============================================== */
  "roi.select": "選擇檔案",
  "roi.clearImage": "清除影像",
  "roi.clearRegion": "清除區域",
  "roi.xOrigin": "X 起點",
  "roi.xEnd": "X 終點",
  "roi.yOrigin": "Y 起點",
  "roi.yEnd": "Y 終點",
  "roi.start": "起點 (x, y)",
  "roi.end": "終點 (x, y)",
  "roi.showGrid": "顯示格線",
  "roi.keepBitmap": "掃描後保留已載入的點陣圖",
  "roi.scaleUnit": "刻度單位",
  "roi.dacEquivalent": "對應 DAC：",
  "roi.dacMappingNote": "（範圍 0..16383；整個 DAC 範圍涵蓋您所設的 {xRange} × {yRange} {unit} 視野）",
  "roi.imageName.lastScan": "上次掃描影像",
  "roi.error.rangeXLessThanEnd": "0 到 {max}（小於 X 終點）",
  "roi.error.rangeXGreaterThanOrigin": "{min} 到 16383（大於 X 起點）",
  "roi.error.rangeYLessThanEnd": "0 到 {max}（小於 Y 終點）",
  "roi.error.rangeYGreaterThanOrigin": "{min} 到 16383（大於 Y 起點）",
  "roi.error.numericRange": "！{label} 必須介於 {range} 之間。",
  "roi.error.pointFormat": "！{label} 必須使用 x, y 數字，最多 1 位小數。",
  "roi.error.startXBounds": "起點 x 必須介於 X 起點 {origin} 與 X 終點 {end} 之間。",
  "roi.error.startYBounds": "起點 y 必須介於 Y 起點 {origin} 與 Y 終點 {end} 之間。",
  "roi.error.endXBounds": "終點 x 必須介於 X 起點 {origin} 與 X 終點 {end} 之間。",
  "roi.error.endYBounds": "終點 y 必須介於 Y 起點 {origin} 與 Y 終點 {end} 之間。",
  "roi.error.startXLessThanEnd": "起點 x 必須小於終點 x {end}。",
  "roi.error.startYLessThanEnd": "起點 y 必須小於終點 y {end}。",
  "roi.error.endXGreaterThanStart": "終點 x 必須大於起點 x {start}。",
  "roi.error.endYGreaterThanStart": "終點 y 必須大於起點 y {start}。",
  "roi.canvas.start": "起點 {point} {unit}",
  "roi.canvas.end": "終點 {point} {unit}",

  /* ===== image canvas / meta ====================================== */
  "canvas.view": "檢視",
  "canvas.view.decimated": "抽稀（{edge}×{edge}）",
  "canvas.view.native": "原生（{edge}×{edge}）",
  "canvas.view.decimated.title": "稠密 {edge}×{edge} 影像 — 像素 = 取樣索引",
  "canvas.view.native.title": "原生 {edge}×{edge}，依步長 {stride} 塊填充 — 像素 = DAC 碼值",
  "canvas.view.identical": "步長 1 — 兩種檢視一致",
  "canvas.serverFigure.rendering": "正在算繪伺服器端影像…",
  "canvas.serverFigure.unavailable": "伺服器端影像無法使用：{detail}",
  "canvas.serverFigure.livePreview": "正在顯示即時預覽。",
  "canvas.serverFigure.alt": "由 glasgow_service 算繪的 {kind} 掃描",
  "canvas.meta.phase": "階段",
  "canvas.meta.chunks": "資料區塊",
  "canvas.meta.bytes": "位元組數",
  "canvas.meta.resolution": "解析度",
  "canvas.meta.pixels": "像素",
  "canvas.meta.samples": "樣本",
  "canvas.meta.roi": "ROI",
  "canvas.meta.beam": "束流位置",
  "canvas.meta.adcNow": "目前 ADC",
  "canvas.meta.adcRange": "ADC",
  "canvas.meta.roi.title": "來自 ROI 編輯器的有效二維 DUT 映射掃描區域。",
  "canvas.meta.beam.title": "根據最近接收的 ADC 樣本索引推算的束流目前位置。",
  "canvas.meta.adcNow.title": "束流目前位置的 ADC 數值。",
  "canvas.meta.adcRange.title": "已接收樣本的原始 ADC 範圍。畫布會將此範圍自動縮放為可見灰階。",

  /* ===== phase enum =============================================== */
  "phase.idle": "閒置",
  "phase.running": "執行中",
  "phase.stopping": "停止中",
  "phase.paused": "已暫停",
  "phase.completed": "已完成",
  "phase.error": "錯誤",

  /* ===== validation panel ========================================= */
  "validation.empty": "尚未完成任何掃描。請按下<執行>開始即時串流，或按下<驗證執行>取得耗時 + 檢查報告。任一方式完成後，皆可在此下載 CSV 與 PNG 影像。",
  "validation.streamCompleted": "即時串流已完成。驗證報告僅由<驗證執行>產生 — 但資料仍可下載。",
  "validation.deviceError": "裝置連線錯誤",
  "validation.autoDownload": "自動下載",
  "validation.selectFolder": "選擇資料夾",
  "validation.folder.default": "~/Downloads",
  "validation.folder.unavailable": "此瀏覽器不支援選擇資料夾；將使用瀏覽器預設的下載資料夾。",
  "validation.autoDownload.error": "自動下載：{detail}",
  "validation.downloadCsv": "下載 CSV",
  "validation.downloadCsv.fetching": "正在取得 CSV…",
  "validation.downloadCsv.title": "將最近掃描的資料下載為 CSV",
  "validation.downloadFigure": "下載影像 (PNG)",
  "validation.downloadFigure.rendering": "正在算繪…",
  "validation.downloadFigure.title": "將最近掃描算繪為 matplotlib PNG 並下載",
  "validation.csvError": "CSV：{detail}",
  "validation.figureError": "影像：{detail}",
  "validation.title": "驗證",
  "validation.allPassed": "所有檢查通過",
  "validation.failures": "存在失敗項",
  "validation.check.pass": "通過",
  "validation.check.fail": "失敗",
  "validation.meta.kind": "類型",
  "validation.meta.chunks": "資料區塊",
  "validation.meta.bytes": "位元組數",
  "validation.meta.pixelsPerChunk": "像素/區塊",
  "validation.meta.send": "傳送",
  "validation.meta.process": "處理",

  /* ===== error wedge ============================================== */
  "error.label": "錯誤",

  /* ===== help popover chrome ====================================== */
  "help.close": "關閉",
  "help.ariaSuffix": "開啟說明",

  /* ===== help popovers — titles & aria labels ===================== */
  "help.dwell.title": "駐留 — 超取樣控制",
  "help.dwell.aria": "駐留欄位的作用是什麼？",
  "help.resolution.title": "解析度 — 像素網格大小",
  "help.resolution.aria": "解析度欄位的作用是什麼？",
  "help.latency.title": "延遲 — USB 流水線上的資料區塊大小",
  "help.latency.aria": "延遲欄位的作用是什麼？",
  "help.cookie.title": "Cookie — 同步標記",
  "help.cookie.aria": "Cookie 欄位的作用是什麼？",
  "help.outputMode.title": "輸出模式 — 樣本位元深度",
  "help.outputMode.aria": "輸出模式欄位的作用是什麼？",
  "help.frameBlank.title": "畫面消隱 — 畫面間束流狀態",
  "help.frameBlank.aria": "畫面消隱欄位的作用是什麼？",
  "help.validation.title": "驗證 — 掃描後完整性檢查",
  "help.validation.aria": "驗證欄位的作用是什麼？",
  "help.pattern.title": "圖樣 — 預設掃描與自訂點列",
  "help.pattern.aria": "圖樣欄位的作用是什麼？",
  "help.vectorResolution.title": "矢量解析度 — 預設掃描密度",
  "help.vectorResolution.aria": "矢量解析度欄位的作用是什麼？",
  "help.customPoints.title": "自訂點列 — 輸入格式",
  "help.customPoints.aria": "自訂點列使用何種格式？",
  "help.preProcess.title": "預先處理資料區塊 — 提前編碼與按需編碼",
  "help.preProcess.aria": "預先處理資料區塊欄位的作用是什麼？",
};
