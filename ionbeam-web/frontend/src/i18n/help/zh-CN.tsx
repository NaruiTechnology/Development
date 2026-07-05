/**
 * Simplified Chinese (zh-CN) help body content.
 *
 * Translation notes specific to the help bodies:
 *   - Technical terms inside <code> stay in English unchanged
 *     (the value is the literal API field name).
 *   - "SNR" stays as the English acronym; common in Chinese SEM
 *     literature it's also written 信噪比 but 文中已用 "SNR增益".
 *   - Numbers and table values stay as-is (these are physical
 *     constants of the hardware).
 *   - "Boustrophedon" is rendered as 牛耕式 (literally "ox-plough
 *     style"), the standard technical Chinese rendering.
 */
import type { ReactNode } from "react";

import type { HelpKey } from "./en";

export const helpBodies: Record<HelpKey, () => ReactNode> = {
  dwell: () => (
    <>
      <div className="dwell-help__rule">
        <strong>请选择 2 的幂次。</strong>如果每像素的有效采样数不是 2 的幂次，
        门级电路只会对最后 2 的幂次个采样取平均，多余的采样会被丢弃。
        例如 7 个采样的像素只会平均其中 4 个；9 个采样只会平均其中 8 个。
        所以请始终选择能使每像素采样数为 2、4、8、16、32、64…… 的{" "}
        <code>dwell_time</code>。
      </div>

      <p><code>dwell</code> 字段是超采样控制。各取值含义：</p>

      <ul className="dwell-help__list">
        <li><code>"dwell": 1</code> → 超采样器不工作，扫描最快，像素率为完整的 8 MSPS</li>
        <li><code>"dwell": 2</code> → 2 倍平均，像素率减半（4 Mpix/s），SNR 增益 √2</li>
        <li><code>"dwell": 4</code> → 4 倍平均（2 Mpix/s），SNR 增益 2 倍</li>
        <li><code>"dwell": 8</code> → 8 倍平均（1 Mpix/s），SNR 增益约 2.8 倍</li>
        <li><code>"dwell": 16</code> → 16 倍平均（500 kpix/s），SNR 增益 4 倍</li>
        <li>…… 直至 <code>dwell = 65535</code>（约每像素 8.19 ms）</li>
      </ul>

      <div className="dwell-help__table-wrap">
        <table className="dwell-help__table">
          <thead>
            <tr>
              <th>dwell</th><th>每像素采样数</th><th>像素率</th>
              <th>SNR 增益<br /><span className="muted">（相对 dwell=1）</span></th>
              <th>1024² 帧时长</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>1</td><td>1</td><td>8.0 MPix/s</td><td>1.00×</td><td>131 ms</td></tr>
            <tr><td>2</td><td>2</td><td>4.0 MPix/s</td><td>1.41×</td><td>262 ms</td></tr>
            <tr><td>4</td><td>4</td><td>2.0 MPix/s</td><td>2.00×</td><td>524 ms</td></tr>
            <tr><td>8</td><td>8</td><td>1.0 MPix/s</td><td>2.83×</td><td>1.05 s</td></tr>
            <tr><td>16</td><td>16</td><td>500 kPix/s</td><td>4.00×</td><td>2.10 s</td></tr>
            <tr><td>32</td><td>32</td><td>250 kPix/s</td><td>5.66×</td><td>4.19 s</td></tr>
          </tbody>
        </table>
      </div>
    </>
  ),

  resolution: () => (
    <>
      <p>
        将光栅网格设置为 <code>N × N</code> 像素。无论选择何值，束流始终在相同的物理 DAC
        范围内扫描；分辨率越小，每个轴向上的采样点就越少。DAC 共有 16 384 个码值（0..16383）；
        当 <code>N = 2048</code> 时，每隔 8 个 DAC 码值采样一次；
        当 <code>N = 256</code> 时，每隔 64 个采样一次。
      </p>

      <div className="dwell-help__rule">
        <strong>仅限 2 的幂次。</strong> DACCodeRange 辅助类以整数运算将 16 384 个 DAC
        码值范围除以 <code>N</code>；非 2 的幂次的分辨率会产生不均匀的步长以及图像伪影。
        请仅使用 256、512、1024、2048。
      </div>

      <p>分辨率会影响通常关心的三个量：</p>

      <ul className="dwell-help__list">
        <li><strong>帧时长</strong> — 按 <code>N² × dwell × 125 ns</code> 缩放。分辨率加倍，时间变为四倍。</li>
        <li><strong>CSV / 图像的像素数</strong> — <code>N²</code> 个值。2048² 的 16 位光栅在传输线上为 8 MB，展开成 CSV 后约为 32 MB。</li>
        <li><strong>空间采样率</strong> — 网格越细可分辨越小的特征，但在总驻留预算相同的情况下，分辨率越高意味着每像素时间越短，除非同时增大 dwell。</li>
      </ul>

      <div className="dwell-help__table-wrap">
        <table className="dwell-help__table">
          <thead>
            <tr>
              <th>分辨率</th><th>DAC 步长</th><th>总像素数</th>
              <th>帧时长<br /><span className="muted">（dwell = 16）</span></th>
              <th>16 位输出</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>256</td><td>64</td><td>65 536</td><td>16 ms</td><td>128 KB</td></tr>
            <tr><td>512</td><td>32</td><td>262 144</td><td>66 ms</td><td>512 KB</td></tr>
            <tr><td>1024</td><td>16</td><td>1 048 576</td><td>262 ms</td><td>2 MB</td></tr>
            <tr><td>2048</td><td>8</td><td>4 194 304</td><td>1.05 s</td><td>8 MB</td></tr>
          </tbody>
        </table>
      </div>

      <p>
        上述帧时长假设以超采样器的 8 MSPS 采样率连续流式传输。实际数值会略长，
        因为每个数据块都有 USB 开销，并且每次扫描末尾还有用于排空流水线的填充。
      </p>
    </>
  ),

  grayScale: () => (
    <>
      <p>
        灰度光谱条会显示当前实时图像或已加载位图中存在的灰度值。
        每个方框代表一个采样到的灰度值，步进旋钮用于控制在可用范围内显示多少个方框。
      </p>

      <div className="dwell-help__rule">
        <strong>选中某个方框本身不会改变图像。</strong>它只会标记下一次扫描操作在确认后要使用的灰度区间。
      </div>

      <ul className="dwell-help__list">
        <li><strong>Skip</strong> 会在选中 ROI 子区域内，对高亮灰度对应的像素发送显式消隐矢量点，因此这些像素会在下一次扫描中被跳过。</li>
        <li><strong>Spot</strong> 会在选中 ROI 子区域内，对高亮灰度对应的像素发送显式取消消隐矢量点，并对同一 ROI 子区域内的其他像素进行消隐。</li>
        <li>该选择仅作用于已定义的 ROI 子区域；区域外像素仍按正常扫描方式处理。</li>
      </ul>

      <p>
        使用 <strong>Select</strong> 确认当前模式，并将其持久化到扫描 store 中，供下一步扫描使用。
      </p>
    </>
  ),

  vectorGrayLevelFilter: () => (
    <>
      <p>
        这个开关控制仅用于矢量扫描的灰度备用路径。我们最先尝试过“同像素即时消隐”，
        但在当前主机流里这是做不到的，因为 ADC 采样到达时，束流已经移动到下一个点。
      </p>

      <p>
        当前的备用行为是预先计算消隐：把位图或灰阶滤波数据展开为带消隐标志的点，
        然后发送整段流，FPGA 执行，ADC 采样再稍后返回。
      </p>

      <p>
        启用后且灰度范围已确认时，后端会把矢量扫描切换为
        <code>adaptive_gray_feedback</code>，强制使用 <code>SixteenBit</code> 输出，
        发送很小的点/窗口批次，等待返回的 ADC 采样，将其与选定范围比较，并根据结果发出下一条{" "}
        <code>BlankCommand</code>。
      </p>

      <ul className="dwell-help__list">
        <li>光柵不在此范围内。这个帮助只针对矢量扫描。</li>
        <li>灰度范围与 ROI / 灰度选择流程中确认的区间比较。</li>
        <li>流水线延迟补偿仍然可配置，因为“下一个物理点”未必等于“下一个逻辑点”。</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>最终行为：</strong>这条主机侧闭环是备用方案，不是同像素实时闭环。
        它比直接消隐更慢，但把灰度过滤和备用消隐绑定在同一条矢量扫描路径上。
      </div>

      <div className="dwell-help__rule">
        <strong>建议的备用模式：</strong>增加一个 <code>adaptive_gray_feedback</code> 矢量模式，
        在 14 位阈值比较时强制使用 <code>output_mode = SixteenBit</code>，发送非常小的命令批次，
        等待 ADC 取样，和灰阶范围比较，并在下一个点/窗口之前发出 <code>BlankCommand</code>；
        同时加入流水线延迟补偿，因为“下一个逻辑点”未必就是“下一个物理点”。
      </div>

      <p>
        这个方案的代价是速度会明显慢于当前的流式矢量扫描。USB 往返和 FPGA 缓冲会成为主要开销。
        作为软件备用方案，它在技术上是合理的，但不会快。
      </p>
    </>
  ),

  scanModes: () => (
    <>
      <p>
        <strong>光栅</strong>按行/列顺序扫描固定的矩形网格。束流沿完整画面或 ROI 边界移动，
        因此它最适合规则成像、整块 ROI 覆盖以及简单且可重复的采集。
      </p>

      <p>
        <strong>矢量</strong>扫描的是显式的点列表。束流只访问你发送的坐标，
        因此它更适合稀疏图样、不规则形状、标注式工作，以及像灰度 skip/spot 这样的选择性束流控制。
      </p>

      <ul className="dwell-help__list">
        <li><strong>使用光栅</strong>：当你需要常规图像、可预测的网格间距，或者不想编写自定义点脚本但仍要扫完整个 ROI 时。</li>
        <li><strong>使用矢量</strong>：当你需要跳过或突出某些像素、绘制非矩形图样，或者只对 ROI 的一部分做更精细的束流控制时。</li>
        <li>两种模式在屏幕上都可以显示相同的实时图像，但发送到硬件的主机命令不同。</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>经验法则：</strong>光栅偏重覆盖，矢量偏重选择性。
      </div>
    </>
  ),

  latency: () => (
    <>
      <p>
        设置 USB OUT 路径上每个数据块的大小（字节）。宏发送器将扫描按此大小切分成若干数据块，
        并等待接收方排空后再排队发送下一批。&ldquo;延迟&rdquo;这一名称沿袭自历史 — FPGA
        固件用同一字段表示&ldquo;在停下等待更多输入之前最多回传这么多字节的结果&rdquo;，
        而这正是最坏情况下端到端延迟的上限。
      </p>

      <div className="dwell-help__rule">
        <strong>必须是像素大小的整数倍。</strong>每个 16 位（SixteenBit）输出像素 2 字节；
        每个 8 位像素 1 字节。无法整除的大小会产生截断的数据块，并触发验证检查。
      </div>

      <p>
        每块像素数 = <code>latency_bytes / sample_size</code>，其中 SixteenBit 的{" "}
        <code>sample_size</code> 为 2，EightBit 为 1。在默认 16 384 字节、16 位输出下，
        每块为 8 192 像素。
      </p>

      <p>权衡：</p>

      <ul className="dwell-help__list">
        <li><strong>较小的延迟（如 4 096）</strong> — 数据块更多，每次扫描 USB 往返次数更多，吞吐量较低。中止与扫描中的 UI 更新响应更快，因为接收方在两块之间会检查中止标志。</li>
        <li><strong>较大的延迟（如 32 768）</strong> — 数据块更少，吞吐量更高，传输中峰值主机内存略高。扫描中的中止响应可能延后最多一块的时间。</li>
        <li><strong>发送器流水线</strong> — OUT 端点上同一时刻最多可以有 <code>max_pipeline</code> 个数据块在传输中（光栅 32，矢量 4）。当延迟与 max_pipeline 都很大时，传输中窗口可能超过 FX2 OUT FIFO 并卡死 — 宏已为此做了预调整，通常无需手动改动 max_pipeline。</li>
      </ul>

      <div className="dwell-help__table-wrap">
        <table className="dwell-help__table">
          <thead>
            <tr>
              <th>latency_bytes</th>
              <th>每块像素数<br /><span className="muted">（SixteenBit）</span></th>
              <th>每 1024² 帧的块数</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>4 096</td><td>2 048</td><td>512</td><td>中止响应最快</td></tr>
            <tr><td>8 192</td><td>4 096</td><td>256</td><td>矢量近似默认</td></tr>
            <tr><td>16 384</td><td>8 192</td><td>128</td><td>光栅默认</td></tr>
            <tr><td>32 768</td><td>16 384</td><td>64</td><td>吞吐量最高</td></tr>
          </tbody>
        </table>
      </div>
    </>
  ),

  cookie: () => (
    <>
      <p>
        16 位标记（0..65535），宏在每次扫描开始时将其嵌入 <code>SynchronizeCommand</code>。
        FPGA 在响应流的前 4 字节将其回传：<code>0xFFFF</code> 后接 cookie。
        主机在消费像素数据之前会读取并丢弃这 4 字节。
      </p>

      <div className="dwell-help__rule">
        <strong>用于流卫生，与安全无关。</strong> Cookie 与认证或会话状态毫无关系。
        它的存在只是为了让主机能检测出&ldquo;我正在读取错误扫描的数据&rdquo;的情况 —
        例如，上次中止的扫描在 FX2 IN FIFO 中残留了未排空的字节，而下次扫描已经开始。
      </div>

      <p>实用建议：</p>

      <ul className="dwell-help__list">
        <li><strong>惯例使用 123。</strong>本代码库历史上一直如此；保留即可。</li>
        <li><strong>更改它</strong>的场景：怀疑扫描间存在残留数据污染时；或在多工具流水线中希望为不同的扫描类型打指纹（例如校准扫描使用 0xCA11，生产扫描使用 0xFAB0），以便后处理依据回传的 cookie 进行分流。</li>
        <li><strong>按请求覆盖。</strong>若 JSON 默认值与 UI 表单都设置了 cookie，则 UI 的值优先 — 详见服务中的 <code>RasterParams.override(…)</code>。</li>
      </ul>

      <p>
        如果扫描返回乱码且第一块数据并非以 <code>0xFFFF &lt;cookie&gt;</code> 开头，
        说明读取到的字节来源不对 — 要么上次扫描没有排空完毕，要么传输过程中发生了 USB 复位。
        这两种情况都应当重新连接，而不是在同一连接上重试。
      </p>
    </>
  ),

  outputMode: () => (
    <>
      <p>
        选择 FPGA 在 USB IN 路径上将每个 ADC 采样回传给主机的序列化方式。两种模式始终使用完整的
        14 位 ADC；区别仅在于这些位如何在线路上打包。
      </p>

      <ul className="dwell-help__list">
        <li><strong>SixteenBit</strong> — 每像素 2 字节。原始 14 位 ADC 读数零扩展到 uint16，小端序。这是唯一能在后处理中恢复完整 ADC 动态范围的模式。</li>
        <li><strong>EightBit</strong> — 每像素 1 字节。FPGA 丢弃低 6 位，只回传高 8 位。USB 带宽减半，但损失 6 位动态范围 — 依赖那些低位的微弱特征将无法恢复。</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>带宽与数据块计算随此字段变化。</strong>在 <code>latency_bytes = 16 384</code> 下，
        SixteenBit 每块 8 192 像素；EightBit 每块 16 384 像素 — 是前者的两倍。比较&ldquo;预期块数&rdquo;
        与&ldquo;实际接收块数&rdquo;的验证检查已计入此因素；如果您自行核算，
        请记得：EightBit 时字节数除以 1，SixteenBit 时除以 2。
      </div>

      <p>如何选择：</p>

      <ul className="dwell-help__list">
        <li><strong>SixteenBit（默认）</strong> — 任何关心图像质量的场合。定量 SEM、EBIC，以及任何需要后期做对比度调整或噪声分析的工作。</li>
        <li><strong>EightBit</strong> — 当 USB 带宽是瓶颈、只需预览时。大型矢量扫描（数百万点）且驻留率较高，会超出 480 Mbps USB 2.0 链路时使用。屏幕显示效果仍然良好；只是无法定量恢复微弱信号。</li>
      </ul>

      <div className="dwell-help__table-wrap">
        <table className="dwell-help__table">
          <thead>
            <tr><th>模式</th><th>每像素字节数</th><th>1024² 帧大小</th><th>动态范围</th></tr>
          </thead>
          <tbody>
            <tr><td>SixteenBit</td><td>2</td><td>2 MB</td><td>14 位（16 384 级）</td></tr>
            <tr><td>EightBit</td><td>1</td><td>1 MB</td><td>8 位（256 级）</td></tr>
          </tbody>
        </table>
      </div>
    </>
  ),

  frameBlank: () => (
    <>
      <p>
        控制电子 / 离子束在一帧结束到下一帧开始之间的空闲时段内的行为。
      </p>

      <ul className="dwell-help__list">
        <li><strong>未勾选（false，默认）</strong> — 帧间束流保持不消隐。重启延迟最低：下一帧可立即开始。适合需要连续扫描并实时观测结果的实时聚焦 / 成像场景。</li>
        <li><strong>勾选（true）</strong> — 宏在帧的最后一个像素之后追加 <code>BlankCommand(enable=True)</code>，在回扫期间以及到下次扫描之前的任何空闲期消隐束流。当扫描在帧内被中止时也会消隐。适合束流敏感样品（辐射敏感样品、光刻过程中的抗蚀剂）或任何不希望在拍摄之间持续曝光的场景。</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>不影响帧内消隐。</strong>帧内的像素始终不消隐；此复选框只控制边界状态。
        如果需要在扫描内部进行逐像素或逐区域的消隐，请构建矢量图样并在点列中嵌入{" "}
        <code>BlankCommand</code>。
      </div>

      <p>
        中止时的细微差别：若在帧内点击<strong>停止</strong>且帧消隐<strong>关闭</strong>，
        则束流停留在最后完成的像素位置，直到下次扫描开始。若帧消隐<strong>开启</strong>，
        宏会在下一个数据块边界注入 BlankCommand，在中止后数十毫秒内消隐束流。
      </p>
    </>
  ),

  validation: () => (
    <>
      <p>
        启用时，服务会在扫描完成后、返回结果前，对捕获的字节流执行一组轻量级检查。
        典型扫描下耗时 &lt; 100 ms，不会触碰设备 — 只检查内存中的数据块列表。
      </p>

      <p>光栅检查：</p>

      <ul className="dwell-help__list">
        <li><strong>数据块计数</strong> — 接收方收到了由 <code>ceil(resolution² / pixels_per_chunk)</code> 预测的数据块数量。不匹配通常表示 FPGA 发生了背压停顿，或排空填充被截短。</li>
        <li><strong>数据块大小</strong> — 除最后一块外，每一块恰好为 <code>latency_bytes / sample_size</code> 个样本。截断的数据块通常意味着 output_mode 与 latency_bytes 对齐不匹配。</li>
        <li><strong>填充存在</strong> — 末尾用于排空流水线的填充（至少约 128 像素，外加帧大小的 0.5 %）由发送方正确发出。缺少填充会导致最后几个真实像素被困在 FPGA 流水线中。</li>
      </ul>

      <p>矢量检查：</p>

      <ul className="dwell-help__list">
        <li><strong>非空</strong> — 每一块都至少包含一个样本。全空的流通常意味着扫描从未真正触发（例如 FPGA 没有看到 SynchronizeCommand）。</li>
        <li><strong>填充存在</strong> — 与光栅相同的排空填充检查。这对矢量尤为重要，因为其排空底线高得多（默认设置下约 21 000 像素）。</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>验证报告驱动结果面板。</strong>禁用时，运行报告仍包含数据块计数与耗时，
        但会省略逐项的通过 / 失败列表，运行面板仅显示&ldquo;validation: off&rdquo;。
      </div>

      <p>何时关闭：</p>

      <ul className="dwell-help__list">
        <li><strong>高速率重复扫描</strong>：已确认环境正常、无需每次运行都查看报告时。</li>
        <li><strong>极致吞吐量的流式传输</strong> — 尽管检查很轻量（&lt; 100 ms），仍需在内存中保留结果以便扫描。禁用可跳过这一保留时段。</li>
      </ul>

      <p>
        在首次部署、排查松动的 USB 线缆或验证新比特流时，请保持开启。这些检查正是为捕获
        &ldquo;扫描完成但数据悄然出错&rdquo;这类成本高昂、否则难以察觉的失败模式而设计的。
      </p>
    </>
  ),

  runValidated: () => (
    <>
      <p>
        当您需要的是<strong>阻塞式扫描结果</strong>而不是实时串流时，请使用
        <strong>验证运行</strong>。它在光栅和矢量两种模式下都可用，会等待扫描完成，
        然后一次性返回耗时数据和验证报告。
      </p>

      <div className="dwell-help__rule">
        <strong>需要报告时用这个。</strong>普通的 <code>Run</code> 只负责实时发送数据块，
        不会等待验证结果。<code>验证运行</code> 才是生成 Run report 面板中那些后扫描检查的路径。
      </div>

      <p>
        光栅或矢量参数表里的验证复选框，仍然决定结果里是否包含逐项的通过 / 失败清单。
        这个按钮只是选择返回扫描结果对象的阻塞端点。
      </p>
    </>
  ),

  pattern: () => (
    <>
      <p>
        矢量模式允许主机向 FPGA 发送显式的点列 — 每个像素一个 <code>(x, y, dwell)</code> 三元组 —
        而不是让门级电路在内部自行生成光栅扫描。此字段决定该点列的来源。
      </p>

      <ul className="dwell-help__list">
        <li><strong>默认扫描</strong> — 宏按<strong>分辨率</strong>设定的密度，在完整 DAC 范围内逐行生成扫描。等同于光栅扫描，但走的是矢量命令路径。适合需要在相同覆盖范围内对比光栅与矢量的 A/B 测试，或某些门级原因导致光栅模式不可用的情形。</li>
        <li><strong>自定义点列</strong> — 您在下方文本框中提供点列。访问顺序与书写顺序完全一致。所有非光栅扫描都走此模式：纯 ROI 扫描、稀疏成像、光刻路径、校准点，以及任何带有定制访问顺序的场景。</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>矢量的每像素速度慢于光栅。</strong>每个矢量像素都携带一个显式的 (x, y, dwell) 三元组 —
        OUT 路径上 6 字节 — 而光栅像素使用游程编码（RasterPixelRunCommand），
        约每整行 5 字节。在 2048² 下，默认图样的矢量发送速度大约比同覆盖范围的光栅慢一个数量级。
        请仅在需要矢量的灵活性时使用，而不要在光栅同样适用时使用。
      </div>

      <p>
        两种模式都经过相同的 SynchronizeCommand cookie 握手、相同的 SixteenBit/EightBit 输出路径，
        以及扫描末尾相同的排空填充。会话内随时切换是无成本的；FPGA 无需重新配置。
      </p>
    </>
  ),

  vectorResolution: () => (
    <>
      <p>
        当<strong>图样</strong>为 <code>default</code> 时，此项决定内建扫描对 DAC 范围采样的稠密程度。
        覆盖范围<em>始终</em>是完整 DAC 范围 — 分辨率越小只是亚采样。
      </p>

      <ul className="dwell-help__list">
        <li><strong>2048 — 原生（步长 1）</strong>：访问每个 DAC 码值。等同于 2048 分辨率的光栅，但走矢量路径。</li>
        <li><strong>1024 — 步长 2</strong>：每隔 2 个 DAC 码值访问一次。点数为 ¼，扫描时间也为 ¼。</li>
        <li><strong>512 — 步长 4</strong>：每隔 4 个 DAC 码值。点数与时间为 1/16。</li>
        <li><strong>256 — 步长 8</strong>：每隔 8 个 DAC 码值。点数为 1/64；适用于快速预览扫描。</li>
        <li><strong>自定义值 1..2048</strong>：仍覆盖完整 DAC 范围，但采样间距会尽量均匀分布，而不是严格的整数步长。</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>允许范围为 1..2048。</strong> 2 的幂预设能在 2048 x 2048 DAC 预览网格上保持整齐映射；
        自定义值则用于更细地控制总点数。
      </div>

      <p>
        与光栅分辨率不同，此字段<em>对自定义图样扫描无任何影响</em>。
        当将图样设为 <code>custom</code> 时，访问列表完全来自下方文本框 — 此字段被忽略。
      </p>

      <div className="dwell-help__table-wrap">
        <table className="dwell-help__table">
          <thead>
            <tr><th>分辨率</th><th>步长</th><th>总点数</th><th>大致扫描时间<br /><span className="muted">（dwell=1）</span></th></tr>
          </thead>
          <tbody>
            <tr><td>256</td><td>8</td><td>65 536</td><td>~8 ms</td></tr>
            <tr><td>512</td><td>4</td><td>262 144</td><td>~33 ms</td></tr>
            <tr><td>1024</td><td>2</td><td>1 048 576</td><td>~131 ms</td></tr>
            <tr><td>2048</td><td>1</td><td>4 194 304</td><td>~524 ms</td></tr>
          </tbody>
        </table>
      </div>

      <p>
        扫描时间为数量级估计；矢量模式每像素都有 USB 开销（每点携带一条 6 字节命令，
        而光栅使用游程编码），因此实际数值会略长一些。
      </p>
    </>
  ),

  customPoints: () => (
    <>
      <p>
        每行一个 <code>(x, y, dwell)</code> 三元组。各值可用逗号或空白分隔；两者都可。空行会被忽略。
      </p>

      <pre style={{
        padding: "8px 10px", margin: "8px 0",
        background: "var(--c-bg-input)",
        border: "1px solid var(--c-border-soft)",
        borderRadius: "var(--r-md)",
        fontFamily: "var(--font-mono)", fontSize: 12,
        whiteSpace: "pre",
      }}>
{`# 合法：
0,0,2
100,100,2
200 100 2
8192,8192,8

# 非法（提交时会被拒绝）：
1.5,2.0,2      # 小数会被截断为整数
0,0            # 缺少 dwell`}
      </pre>

      <ul className="dwell-help__list">
        <li><strong><code>x</code>、<code>y</code></strong> — DAC 码值，闭区间 0..16383。超范围的值会在设备上被截断，但无法产生有用输出。</li>
        <li><strong><code>dwell</code></strong> — 单位与光栅 dwell 一致：125 ns 采样周期的个数。1 最快（无超采样）；2/4/8/16/…… 是 SNR 平均的实用值。最大可至 65535（约每像素 8.19 ms）。</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>硬性上限：1 000 000 个点。</strong>与 API 请求上 Pydantic 的{" "}
        <code>max_length</code> 一致。后端会在触碰设备之前以 422 拒绝过大的点列。
      </div>

      <p>大点列的性能建议：</p>

      <ul className="dwell-help__list">
        <li>启用下方的<strong>预处理数据块</strong> — 对于超过约 100k 点的点列，可将总扫描时间减少 50 % 或更多。</li>
        <li>对点列排序以减少相邻像素之间的束流移动 — 大的 DAC 跳变会在模拟通路上耗费整定时间。如无更具体的方案，牛耕式（之字形）顺序是个不错的默认。</li>
        <li>访问顺序被严格保留。宏不会重排、去重或优化。若两个连续点的 <code>(x, y)</code> 相同，束流在该处的驻留时间为两段 dwell 之和。</li>
      </ul>

      <p>
        如需程序化生成，可从任何能输出 CSV 的来源粘贴：电子表格、Python 脚本、Jupyter 笔记本均可。
        在浏览器开始卡顿之前，文本框约可承载 50 MB 的文本，远高于 100 万点上限。
      </p>
    </>
  ),

  preProcess: () => (
    <>
      <p>
        每个矢量像素在 OUT 路径上以一条 6 字节命令发送：<code>x</code>（2 B）+ <code>y</code>（2 B）
        + <code>dwell</code>（2 B），大端序。宏将其按<strong>延迟</strong>大小批量打包成数据块。
        本复选框控制的是<em>何时</em>进行这一批量打包。
      </p>

      <ul className="dwell-help__list">
        <li><strong>未勾选（按需，流式默认）</strong> — 数据块在发送协程内随传输消费而按需编码。内存占用最低：同一时刻 RAM 中只有传输中窗口（max_pipeline × latency_bytes）这么多。但主机 CPU 需要跟上 USB；若产生点列的迭代器较慢，设备就会因等待下一块而停滞。</li>
        <li><strong>勾选（预处理）</strong> — 宏的 <code>_pre_process_chunks()</code> 在扫描开始时执行一次，将每个数据块物化为命令对象持有的 memoryview。此时传输只受 USB 吞吐量限制，与主机端编码速度无关。代价：峰值 RAM 约为 <code>6 × total_pixels</code> 字节（即百万点扫描约 6 MB）。</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>实际运行的预处理时间会单独报告。</strong>运行报告中的 <code>process_time_s</code>{" "}
        显示预处理耗时；<code>send_time_s</code> 只显示 USB 传输耗时。
        旧版 UI 曾将两者混为一谈。
      </div>

      <p>何时启用：</p>

      <ul className="dwell-help__list">
        <li><strong>建议启用：</strong>任何超过约 100k 点的自定义点列，尤其是点列迭代器需要做大量工作时（计算路径、基于图像的光栅化等）。</li>
        <li><strong>建议启用：</strong>关心总吞吐量时，高分辨率（1024+）下的默认扫描。</li>
        <li><strong>不建议：</strong>非常长的扫描中，峰值 RAM 比总耗时更重要时（≥ 1000 万点且运行在内存受限的主机上）。</li>
        <li><strong>不建议：</strong>低于约 10k 点的小扫描 — 预处理开销与节省的时间相当。</li>
      </ul>
    </>
  ),

  canvasView: () => (
    <>
      <p>
        这个控件只改变当前矢量缓冲区在画布上的绘制方式，不会改变实际扫描本身。
      </p>

      <ul className="dwell-help__list">
        <li>
          <strong>抽稀</strong> — 以当前采样网格大小显示实时矢量图像。每个像素对应矢量缓冲区中的一个样本索引。
        </li>
        <li>
          <strong>原生</strong> — 将矢量图像展开到 DAC 网格。当前矢量分辨率低于 2048 时，每个采样单元会按 DAC 步长进行块填充，便于在原生坐标网格上检查覆盖情况。
        </li>
      </ul>

      <div className="dwell-help__rule">
        <strong>步长 1 时两种视图完全一致。</strong>当矢量分辨率为 2048 时，没有抽稀，因此切换视图只会改变标签。
      </div>

      <p>
        当您想分析采样顺序和图像稀疏度时，使用<strong>抽稀</strong>。
        当您想检查较低矢量网格在 DAC 空间中的占用范围时，使用<strong>原生</strong>。
      </p>
    </>
  ),

  magCalibration: () => (
    <>
      <p>
        放大倍率校准用于把显微镜放大倍率映射到所选束流的完整水平视场（HFOV，单位米）。
      </p>

      <div className="dwell-help__rule">
        <strong>HFOV 公式。</strong>{" "}
        <code>HFOV_m = measured_length_m × (image_resolution_px / measured_line_px)</code>。
        measured length 是测量线对应的真实物理长度；measured pixels 是该测量线在图像中的像素长度。
      </div>

      <ul className="dwell-help__list">
        <li><strong>Magnification</strong> 是当前校准点的显微镜放大倍率。</li>
        <li><strong>Image resolution</strong> 应匹配校准所用完整图像轴，通常为 <code>max(width_px, height_px)</code>。</li>
        <li><strong>Update curve</strong> 会把当前放大倍率下计算得到的 HFOV 写入曲线。</li>
        <li><strong>Save</strong> 会按束流保存到 <code>magCalibration.beams[beam].m_per_fov</code>。</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>X/Y 关系。</strong>放大倍率校准只保存 HFOV。ROI 的 X/Y 校准负责视口到 DUT
        坐标的映射。如果像素为正方形，VFOV 可由 HFOV 按图像宽高比推导；否则 X 和 Y
        需要分别通过 ROI 校准。
      </div>

      <p>
        <strong>导入 CSV</strong> 需要的是从本面板导出的放大倍率校准 CSV：
        <code>Magnification,FOV (m)</code>。它不是普通扫描输出 CSV。扫描结果 CSV
        包含采样图像数据，不会被解析为放大倍率校准曲线。
      </p>

      <p>
        保存结果会写入 stream 配置，并通过 <code>/api/admin/mag-calibration</code> 返回。
        其他扫描逻辑可从 defaults/config 读取该按束流保存的映射；导入按钮本身只替换当前的校准点表。
      </p>

      <p>
        曲线使用 log-log 坐标，因为 FOV 通常近似与放大倍率成反比。CSV 导入/导出使用两列数据：magnification 与 FOV meters。
      </p>
    </>
  ),
};
