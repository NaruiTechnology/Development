/**
 * Simplified Chinese (zh-CN) translation table.
 *
 * Typed as Partial<TranslationTable> so adding new keys to en.ts
 * doesn't break the build here — but missing keys WILL fall through
 * to English at runtime, which is the loud failure mode we want.
 *
 * Translation conventions for this codebase:
 *   - Technical terms in common SEM/FIB usage stay in English when
 *     they're widely used as proper nouns in Chinese semiconductor
 *     labs: "DAC", "ADC", "FPGA", "USB", "ROI", "CSV", "PNG", "OBI".
 *   - "Raster" → 光栅 (standard), "Vector" → 矢量, "dwell" → 驻留时间
 *     (when used as a noun); the form field label stays the short
 *     "驻留" since it appears next to a number input.
 *   - "Chunk" → 数据块, "stride" → 步长 / 跨距 — stride context-
 *     dependent; we use 步长 throughout since the codebase uses it
 *     for sampling-density semantics.
 *   - Brand strings ("Ion Beam Technology", "Glasgow rev C3") stay
 *     in English — they're product / build identifiers, not prose.
 */
import type { TranslationTable } from "./en";

export const zhCN: Partial<TranslationTable> = {
  /* ===== app chrome ================================================ */
  "app.documentTitle": "Ion Beam Technology — 控制面板",
  "app.brand.name": "Ion Beam Technology",
  "app.brand.tagline": "束流控制台",
  "app.footer.copyright": "© Ion Beam Technology Ltd",
  "app.footer.build": "Glasgow rev C3 · 基于 OBI 的 FPGA 流水线",

  /* ===== header =================================================== */
  "header.theme.label": "主题",
  "header.theme.navy": "深蓝",
  "header.theme.black": "纯黑",
  "header.theme.light": "浅色",
  "header.theme.navy.title": "Ion Beam 默认深蓝主题",
  "header.theme.black.title": "适用于低环境光实验室的 OLED 友好纯黑主题",
  "header.theme.light.title": "适用于日光下显示器的浅色主题",
  "header.language.label": "语言",
  "header.language.title": "界面语言",
  "header.state.idle": "空闲",
  "header.state.busy": "扫描中",
  "header.state.connecting": "连接中",
  "header.state.error": "错误",
  "header.state.disconnected": "已断开",
  "header.scans": "扫描次数：{count}",
  "header.reconnect": "重新连接",
  "header.reconnect.title": "断开并重新建立 USB 连接（POST /admin/reconnect）",

  /* ===== top-level tabs =========================================== */
  "tabs.aria": "扫描类型",
  "tabs.roi": "ROI",
  "tabs.raster": "光栅",
  "tabs.vector": "矢量",
  "tabs.roi.title": "编辑 ROI",
  "tabs.roi.title.disabled": "扫描运行期间 ROI 不可用",

  /* ===== card titles ============================================== */
  "card.controls": "控制",
  "card.runReport": "运行报告",
  "card.rasterImage": "光栅图像",
  "card.vectorPattern": "矢量图样",
  "card.roiPreview": "ROI 预览",
  "card.validatedRunOptions": "验证运行选项",

  /* ===== scan controls (buttons) ================================== */
  "scan.run": "运行",
  "scan.pause": "暂停",
  "scan.pausing": "正在暂停…",
  "scan.stop": "停止",
  "scan.runValidated": "验证运行",
  "scan.clear": "清除",
  "scan.busy.title": "扫描进行中",
  "scan.run.title.start": "打开 WebSocket 并实时传输数据块",
  "scan.run.title.paused": "开始新的扫描（保留的图像将被替换）",
  "scan.pause.title": "结束扫描但保留画布上的部分图像",
  "scan.stop.title": "结束扫描并清空画布",
  "scan.runValidated.title": "POST /scan/{kind}/run — 返回耗时与验证报告",

  /* ===== raster parameter form ==================================== */
  "raster.resolution": "分辨率",
  "raster.dwell": "驻留",
  "raster.latencyBytes": "延迟（字节）",
  "raster.cookie": "Cookie",
  "raster.outputMode": "输出模式",
  "raster.frameBlank": "帧消隐（开始与结束时消隐）",
  "raster.doValidate": "执行数据块计数 / 大小 / 填充检查",
  "raster.footnote": "验证仅对<验证运行>生效。扫描完成后，请使用运行报告中的<下载 CSV> / <下载图像>按钮导出数据。",

  /* ===== vector parameter form ==================================== */
  "vector.pattern": "图样",
  "vector.pattern.default": "默认扫描（覆盖整个 DAC 范围）",
  "vector.pattern.custom": "自定义点列",
  "vector.resolution": "分辨率（每轴采样数）",
  "vector.resolution.option.2048": "2048 × 2048 — 原生（步长 1）",
  "vector.resolution.option.1024": "1024 × 1024 — 步长 2",
  "vector.resolution.option.512": "512 × 512 — 步长 4",
  "vector.resolution.option.256": "256 × 256 — 步长 8",
  "vector.resolution.help": "分辨率越小 → 扫描越快、采样越稀疏。覆盖范围始终是完整的 0..2047 DAC 范围。",
  "vector.resolution.title.native": "原生：采样每个 DAC 码值。",
  "vector.resolution.title.stride": "步长 {stride}：每 {stride} 个 DAC 码值采样一次。仍覆盖完整的 DAC 范围。",
  "vector.latencyBytes": "延迟（字节）",
  "vector.outputMode": "输出模式",
  "vector.cookie": "Cookie",
  "vector.customPoints.label": "自定义点列（每行一个 x,y,驻留）",
  "vector.customPoints.error.tooMany": "点数过多：{count} > {max}",
  "vector.customPoints.error.format": "第 {line} 行：应为 \"x,y,驻留\"",
  "vector.customPoints.count": "{count} 个点",
  "vector.customPoints.empty": "0 个点",
  "vector.preProcess": "预处理数据块（单独计入 process_time_s 时间）",
  "vector.doValidate": "执行非空 / 填充检查",

  /* ===== ROI editor =============================================== */
  "roi.select": "选择文件",
  "roi.clearImage": "清除图像",
  "roi.clearRegion": "清除区域",
  "roi.xOrigin": "X 起点",
  "roi.xEnd": "X 终点",
  "roi.yOrigin": "Y 起点",
  "roi.yEnd": "Y 终点",
  "roi.start": "起点 (x, y)",
  "roi.end": "终点 (x, y)",
  "roi.showGrid": "显示网格线",
  "roi.keepBitmap": "扫描后保留已加载位图",
  "roi.scaleUnit": "刻度单位",
  "roi.dacEquivalent": "对应 DAC：",
  "roi.dacMappingNote": "（范围 0..16383；整个 DAC 范围覆盖您所设的 {xRange} × {yRange} {unit} 视野）",
  "roi.imageName.lastScan": "上次扫描图像",
  "roi.error.rangeXLessThanEnd": "0 到 {max}（小于 X 终点）",
  "roi.error.rangeXGreaterThanOrigin": "{min} 到 16383（大于 X 起点）",
  "roi.error.rangeYLessThanEnd": "0 到 {max}（小于 Y 终点）",
  "roi.error.rangeYGreaterThanOrigin": "{min} 到 16383（大于 Y 起点）",
  "roi.error.numericRange": "！{label} 必须介于 {range} 之间。",
  "roi.error.pointFormat": "！{label} 必须使用 x, y 数字，最多 1 位小数。",
  "roi.error.startXBounds": "起点 x 必须介于 X 起点 {origin} 与 X 终点 {end} 之间。",
  "roi.error.startYBounds": "起点 y 必须介于 Y 起点 {origin} 与 Y 终点 {end} 之间。",
  "roi.error.endXBounds": "终点 x 必须介于 X 起点 {origin} 与 X 终点 {end} 之间。",
  "roi.error.endYBounds": "终点 y 必须介于 Y 起点 {origin} 与 Y 终点 {end} 之间。",
  "roi.error.startXLessThanEnd": "起点 x 必须小于终点 x {end}。",
  "roi.error.startYLessThanEnd": "起点 y 必须小于终点 y {end}。",
  "roi.error.endXGreaterThanStart": "终点 x 必须大于起点 x {start}。",
  "roi.error.endYGreaterThanStart": "终点 y 必须大于起点 y {start}。",
  "roi.canvas.start": "起点 {point} {unit}",
  "roi.canvas.end": "终点 {point} {unit}",

  /* ===== image canvas / meta ====================================== */
  "canvas.view": "视图",
  "canvas.view.decimated": "抽稀（{edge}×{edge}）",
  "canvas.view.native": "原生（{edge}×{edge}）",
  "canvas.view.decimated.title": "稠密 {edge}×{edge} 图像 — 像素 = 采样索引",
  "canvas.view.native.title": "原生 {edge}×{edge}，按步长 {stride} 块填充 — 像素 = DAC 码值",
  "canvas.view.identical": "步长 1 — 两种视图一致",
  "canvas.serverFigure.rendering": "正在渲染服务端图像…",
  "canvas.serverFigure.unavailable": "服务端图像不可用：{detail}",
  "canvas.serverFigure.livePreview": "正在显示实时预览。",
  "canvas.serverFigure.alt": "由 glasgow_service 渲染的 {kind} 扫描",
  "canvas.meta.phase": "阶段",
  "canvas.meta.chunks": "数据块",
  "canvas.meta.bytes": "字节数",
  "canvas.meta.resolution": "分辨率",
  "canvas.meta.pixels": "像素",
  "canvas.meta.samples": "样本",
  "canvas.meta.roi": "ROI",
  "canvas.meta.beam": "束流位置",
  "canvas.meta.adcNow": "当前 ADC",
  "canvas.meta.adcRange": "ADC",
  "canvas.meta.roi.title": "来自 ROI 编辑器的有效二维 DUT 映射扫描区域。",
  "canvas.meta.beam.title": "根据最近接收的 ADC 样本索引推算出的束流当前位置。",
  "canvas.meta.adcNow.title": "束流当前位置的 ADC 数值。",
  "canvas.meta.adcRange.title": "已接收样本的原始 ADC 范围。画布将此范围自动缩放为可见灰度。",

  /* ===== phase enum =============================================== */
  "phase.idle": "空闲",
  "phase.running": "运行中",
  "phase.stopping": "停止中",
  "phase.paused": "已暂停",
  "phase.completed": "已完成",
  "phase.error": "错误",

  /* ===== validation panel ========================================= */
  "validation.empty": "尚无已完成的扫描。点击<运行>开始实时流，或点击<验证运行>获取耗时 + 检查报告。任一方式完成后，即可在此下载 CSV 与 PNG 图像。",
  "validation.streamCompleted": "实时流已完成。验证报告仅由<验证运行>生成 — 但数据仍可下载。",
  "validation.deviceError": "设备连接错误",
  "validation.autoDownload": "自动下载",
  "validation.selectFolder": "选择文件夹",
  "validation.folder.default": "~/Downloads",
  "validation.folder.unavailable": "此浏览器不支持文件夹选择；将使用浏览器默认的下载文件夹。",
  "validation.autoDownload.error": "自动下载：{detail}",
  "validation.downloadCsv": "下载 CSV",
  "validation.downloadCsv.fetching": "正在获取 CSV…",
  "validation.downloadCsv.title": "将最近扫描的数据下载为 CSV",
  "validation.downloadFigure": "下载图像 (PNG)",
  "validation.downloadFigure.rendering": "正在渲染…",
  "validation.downloadFigure.title": "将最近扫描渲染为 matplotlib PNG 并下载",
  "validation.csvError": "CSV：{detail}",
  "validation.figureError": "图像：{detail}",
  "validation.title": "验证",
  "validation.allPassed": "全部检查通过",
  "validation.failures": "存在失败项",
  "validation.check.pass": "通过",
  "validation.check.fail": "失败",
  "validation.meta.kind": "类型",
  "validation.meta.chunks": "数据块",
  "validation.meta.bytes": "字节数",
  "validation.meta.pixelsPerChunk": "像素/块",
  "validation.meta.send": "发送",
  "validation.meta.process": "处理",

  /* ===== error wedge ============================================== */
  "error.label": "错误",

  /* ===== help popover chrome ====================================== */
  "help.close": "关闭",
  "help.ariaSuffix": "打开帮助",

  /* ===== help popovers — titles & aria labels ===================== */
  "help.dwell.title": "驻留 — 超采样控制",
  "help.dwell.aria": "驻留字段的作用是什么？",
  "help.resolution.title": "分辨率 — 像素网格大小",
  "help.resolution.aria": "分辨率字段的作用是什么？",
  "help.latency.title": "延迟 — USB 流水线上的数据块大小",
  "help.latency.aria": "延迟字段的作用是什么？",
  "help.cookie.title": "Cookie — 同步标记",
  "help.cookie.aria": "Cookie 字段的作用是什么？",
  "help.outputMode.title": "输出模式 — 样本位深",
  "help.outputMode.aria": "输出模式字段的作用是什么？",
  "help.frameBlank.title": "帧消隐 — 帧间束流状态",
  "help.frameBlank.aria": "帧消隐字段的作用是什么？",
  "help.validation.title": "验证 — 扫描后完整性检查",
  "help.validation.aria": "验证字段的作用是什么？",
  "help.pattern.title": "图样 — 默认扫描与自定义点列",
  "help.pattern.aria": "图样字段的作用是什么？",
  "help.vectorResolution.title": "矢量分辨率 — 默认扫描密度",
  "help.vectorResolution.aria": "矢量分辨率字段的作用是什么？",
  "help.customPoints.title": "自定义点列 — 输入格式",
  "help.customPoints.aria": "自定义点列使用何种格式？",
  "help.preProcess.title": "预处理数据块 — 提前编码与按需编码",
  "help.preProcess.aria": "预处理数据块字段的作用是什么？",
};
