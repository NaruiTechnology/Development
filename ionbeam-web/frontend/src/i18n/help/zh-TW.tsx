/**
 * Traditional Chinese (zh-TW) help body content.
 *
 * As with the locale table: traditional character forms throughout,
 * Taiwan-Mandarin lexical choices (解析度 not 分辨率, 預設 not 默认,
 * 資料 not 数据, 連線 not 连接, 點陣圖 not 位图, etc.). Technical
 * tokens inside <code> stay unchanged. The "boustrophedon" sweep is
 * rendered as 牛耕式 here as well — same loanword reading.
 */
import type { ReactNode } from "react";

import type { HelpKey } from "./en";

export const helpBodies: Record<HelpKey, () => ReactNode> = {
  adcValid: () => (
    <p>啟用後，生產掃描會監視 ADC 資料流中的持續滿量程值，這通常表示 ADC 匯流排斷線或未被驅動。只有在刻意收集原始診斷資料時才關閉。</p>
  ),
  dacCheck: () => (
    <>
      <p>
        開啟開關只會執行<strong>一種</strong>設定：在讓另一軸保持固定於
        <strong>固定值</strong>的同時，掃描所選<strong>軸</strong>的完整
        0–16383 範圍。這就是為什麼預設執行只會顯示一條由 16384 個樣本組成
        的連續斜坡——開關本身不會自動循環其他設定。
      </p>
      <p>若要檢查其他設定，請在開啟開關<em>之前</em>先修改以下欄位：</p>
      <ul>
        <li><strong>軸</strong> — 設為 Y 可改為掃描垂直 DAC 而非 X。未被掃描的那一軸就是被固定在「固定值」上的軸。</li>
        <li><strong>固定值</strong> — 未被掃描的那一軸所停留的 DAC 碼（0–16383）。可嘗試不同數值（例如接近 0、中間值、接近 16383），以確認線性度並非只在中點附近良好。</li>
        <li><strong>停留時間</strong> — 每個 DAC 碼平均的 ADC 取樣數。數值越大波形雜訊越小，但掃描速度越慢；預設值（500）與上游 OBI 的參考測試一致。</li>
      </ul>
      <p>
        每次開關由關閉切換為開啟時，都會以當時設定的軸 / 固定值 / 停留時間
        重新啟動一次完整的 16384 個樣本掃描——關閉開關、修改欄位，再重新開啟
        即可執行下一項檢查。
      </p>
    </>
  ),
  dwell: () => (
    <>
      <div className="dwell-help__rule">
        <strong>revC3 硬體下限：單次 ADC 取樣 125 ns。</strong>48 MHz FPGA 時脈和目前設定的
        6 時脈 ADC/DAC 交易將單次取樣限制為 125 ns（8 MS/s）。dwell 為 N 時每像素取樣 N + 1 次，
        因此介面可請求的最短像素（dwell 1）為 250 ns，即 4 MPix/s。目前閘級電路無法實現
        10 ns 駐留；單一 FPGA 時脈週期也需要 20.833 ns。
      </div>

      <div className="dwell-help__rule">
        <strong>請選擇 dwell = 2^k − 1。</strong>每像素取樣數為 dwell + 1。如果它不是 2 的冪次，
        閘級電路只會對最後 2 的冪次個取樣取平均，多餘的取樣會被捨棄。
        例如 7 個取樣的像素只會平均其中 4 個；9 個取樣只會平均其中 8 個；
        dwell 16 需要 17 個取樣，只平均其中 16 個。
        因此請選擇 <code>dwell</code> = 1、3、7、15、31、63……，使每像素取樣數為 2、4、8、16、32、64……。
      </div>

      <div className="dwell-help__rule">
        <strong>灰階探測/消隱的最小 dwell 為 2。</strong>當 ROI 或向量掃描確認灰階範圍後，
        每像素流程需要一個 dwell 週期探測灰階值，並至少再用一個週期執行束流開啟或消隱決定。
        dwell 為 1 無法完成這兩個階段，因此所選值會自動調整為 2。
      </div>

      <p><code>dwell</code> 欄位是超取樣控制。各取值含義：</p>

      <ul className="dwell-help__list">
        <li><code>"dwell": 1</code> → 介面允許的最快掃描（平均 2 個取樣）（4 MPix/s）</li>
        <li><code>"dwell": 3</code> → 平均 4 個取樣（2 MPix/s），相對 dwell 1 SNR 增益 √2</li>
        <li><code>"dwell": 7</code> → 平均 8 個取樣（1 MPix/s），SNR 增益 2 倍</li>
        <li><code>"dwell": 15</code> → 平均 16 個取樣（500 kPix/s），SNR 增益約 2.8 倍</li>
        <li><code>"dwell": 31</code> → 平均 32 個取樣（250 kPix/s），SNR 增益 4 倍</li>
        <li><code>"dwell": 63</code> → 平均 64 個取樣（125 kPix/s），SNR 增益約 5.7 倍</li>
        <li>…… 直至 <code>dwell = 65535</code>（約每像素 8.19 ms）</li>
      </ul>

      <div className="dwell-help__table-wrap">
        <table className="dwell-help__table">
          <thead>
            <tr>
              <th>dwell</th><th>每像素取樣數</th><th>像素率</th>
              <th>SNR 增益<br /><span className="muted">（相對 dwell=1）</span></th>
              <th>1024² 畫面時長</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>1</td><td>2</td><td>4.0 MPix/s</td><td>1.00×</td><td>262 ms</td></tr>
            <tr><td>3</td><td>4</td><td>2.0 MPix/s</td><td>1.41×</td><td>524 ms</td></tr>
            <tr><td>7</td><td>8</td><td>1.0 MPix/s</td><td>2.00×</td><td>1.05 s</td></tr>
            <tr><td>15</td><td>16</td><td>500 kPix/s</td><td>2.83×</td><td>2.10 s</td></tr>
            <tr><td>31</td><td>32</td><td>250 kPix/s</td><td>4.00×</td><td>4.19 s</td></tr>
            <tr><td>63</td><td>64</td><td>125 kPix/s</td><td>5.66×</td><td>8.39 s</td></tr>
          </tbody>
        </table>
      </div>
    </>
  ),

  resolution: () => (
    <>
      <p>
        將光柵網格設定為 <code>N × N</code> 像素。無論選擇何值，束流始終在相同的實體 DAC
        範圍內掃描；解析度越小，每個軸向上的取樣點就越少。DAC 共有 16 384 個碼值（0..16383）；
        當 <code>N = 2048</code> 時，每隔 8 個 DAC 碼值取樣一次；
        當 <code>N = 256</code> 時，每隔 64 個取樣一次。
      </p>

      <div className="dwell-help__rule">
        <strong>僅限 2 的冪次。</strong> DACCodeRange 輔助類別以整數運算將 16 384 個 DAC
        碼值範圍除以 <code>N</code>；非 2 的冪次的解析度會產生不均勻的步長以及影像偽影。
        請僅使用 256、512、1024、2048。
      </div>

      <p>解析度會影響通常關心的三個量：</p>

      <ul className="dwell-help__list">
        <li><strong>畫面時長</strong> — 目前 revC3 按 <code>N² × (dwell + 1) × 125 ns</code> 縮放。解析度加倍，時間變為四倍。</li>
        <li><strong>CSV / 影像的像素數</strong> — <code>N²</code> 個值。2048² 的 16 位元光柵在傳輸線上為 8 MB，展開為 CSV 後約為 32 MB。</li>
        <li><strong>空間取樣率</strong> — 網格越細可解析越小的特徵，但在總駐留預算相同的情況下，解析度越高代表每像素時間越短，除非同時增大 dwell。</li>
      </ul>

      <div className="dwell-help__table-wrap">
        <table className="dwell-help__table">
          <thead>
            <tr>
              <th>解析度</th><th>DAC 步長</th><th>總像素數</th>
              <th>畫面時長<br /><span className="muted">（dwell = 16）</span></th>
              <th>16 位元輸出</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>256</td><td>64</td><td>65 536</td><td>139 ms</td><td>128 KB</td></tr>
            <tr><td>512</td><td>32</td><td>262 144</td><td>557 ms</td><td>512 KB</td></tr>
            <tr><td>1024</td><td>16</td><td>1 048 576</td><td>2.23 s</td><td>2 MB</td></tr>
            <tr><td>2048</td><td>8</td><td>4 194 304</td><td>8.91 s</td><td>8 MB</td></tr>
          </tbody>
        </table>
      </div>

      <p>
        上述畫面時長假設以 revC3 閘級電路的理論 8 MSPS 取樣率連續串流。實際數值會略長，
        因為每個資料區塊都有 USB 額外開銷，並且每次掃描末尾還有用於排空流水線的填充。
      </p>
    </>
  ),

  grayScale: () => (
    <>
      <p>
        灰階光譜條會顯示目前即時影像或已載入點陣圖中存在的灰階值。
        每個方框代表一個採樣到的灰階值，步進旋鈕用來控制在可用範圍內顯示多少個方框。
      </p>

      <div className="dwell-help__rule">
        <strong>選取某個方框本身不會改變影像。</strong>它只會標記下一次掃描動作在確認後要使用的灰階區間。
      </div>

      <ul className="dwell-help__list">
        <li><strong>Skip</strong> 會在選定 ROI 子區域內，對高亮灰階對應的像素送出顯式消隱向量點，因此這些像素會在下一次掃描中被略過。</li>
        <li><strong>Spot</strong> 會在選定 ROI 子區域內，對高亮灰階對應的像素送出顯式取消消隱向量點，並對同一 ROI 子區域內的其他像素進行消隱。</li>
        <li>此選擇僅作用於已定義的 ROI 子區域；區域外像素仍依正常掃描方式處理。</li>
      </ul>

      <p>
        使用 <strong>Select</strong> 確認目前模式，並將其保存到掃描 store 中，供下一步掃描使用。
      </p>
    </>
  ),

  vectorGrayLevelFilter: () => (
    <>
      <p>
        目前的預計算消隱行為是把點陣圖或灰階濾波資料展開為帶消隱標誌的點，
        然後送出整段串流，FPGA 執行，ADC 取樣稍後回傳。
      </p>

      <p>
        此方案提供一種逐一處理單一邏輯點的方法：啟用後且灰階範圍已確認時，
        後端會把矢量掃描切換為 <code>adaptive_gray_feedback</code>，強制使用
        <code>SixteenBit</code> 輸出，先在 <code>(x, y)</code> 送出 1 個未消隱的探測取樣，
        立即讀取該 ADC 結果，然後回到同一個座標，用剩餘駐留時間執行選定的消隱狀態。
      </p>

      <ul className="dwell-help__list">
        <li>光柵不在此範圍內。這份說明只針對矢量掃描。</li>
        <li>灰階範圍會與灰階選取流程中確認的區間比較。</li>
        <li>自適應模式會強制 <code>dwell = 16</code> 或更高，這樣在初始探測之後，同一座標上的後續動作階段仍然有足夠的駐留時間。</li>
      </ul>

      <p>
        返回的掃描結果仍會透過合併探測/動作取樣，或在消隱時將輸出歸零，
        讓每個請求點仍對應一個邏輯取樣。最終束流關閉仍會在自適應傳輸結束時明確執行。
      </p>

      <p>
        這個方案的代價是速度會明顯慢於目前的串流式矢量掃描。USB 往返與 FPGA 緩衝會成為主要開銷。
        作為軟體路徑，它在技術上是合理的，但不會快。
      </p>
    </>
  ),

  scanModes: () => (
    <>
      <p>
        <strong>光柵</strong>會依照列/欄順序掃描固定的矩形網格。束流沿著完整畫面或 ROI 邊界移動，
        因此最適合規則成像、整塊 ROI 覆蓋，以及簡單且可重複的採集。
      </p>

      <p>
        <strong>矢量</strong>掃描的是明確的點列表。束流只會走訪你送出的座標，
        因此更適合稀疏圖樣、不規則形狀、標註式工作，以及像灰階 skip/spot 這類選擇性束流控制。
      </p>

      <ul className="dwell-help__list">
        <li><strong>使用光柵</strong>：當你需要一般影像、可預測的網格間距，或不想撰寫自訂點腳本但仍要掃完整個 ROI 時。</li>
        <li><strong>使用矢量</strong>：當你需要跳過或強調某些像素、繪製非矩形圖樣，或只針對 ROI 的部分區域做更精細的束流控制時。</li>
        <li>兩種模式在畫面上都可以顯示相同的即時影像，但送往硬體的主機命令不同。</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>經驗法則：</strong>光柵重視覆蓋，矢量重視選擇性。
      </div>
    </>
  ),

  latency: () => (
    <>
      <p>
        設定 USB OUT 路徑上每個資料區塊的大小（位元組）。巨集發送器將掃描按此大小切分成若干資料區塊，
        並等待接收方排空後再排入下一批。&ldquo;延遲&rdquo;這一名稱沿襲自歷史 — FPGA
        韌體用同一欄位表示&ldquo;在停下等待更多輸入之前最多回傳這麼多位元組的結果&rdquo;，
        而這正是最壞情況下端到端延遲的上限。
      </p>

      <div className="dwell-help__rule">
        <strong>必須是像素大小的整數倍。</strong>每個 16 位元（SixteenBit）輸出像素 2 位元組；
        每個 8 位元像素 1 位元組。無法整除的大小會產生截斷的資料區塊，並觸發驗證檢查。
      </div>

      <p>
        每區塊像素數 = <code>latency_bytes / sample_size</code>，其中 SixteenBit 的{" "}
        <code>sample_size</code> 為 2，EightBit 為 1。在預設 16 384 位元組、16 位元輸出下，
        每區塊為 8 192 像素。
      </p>

      <p>取捨：</p>

      <ul className="dwell-help__list">
        <li><strong>較小的延遲（如 4 096）</strong> — 資料區塊更多，每次掃描 USB 往返次數更多，吞吐量較低。中止與掃描中的 UI 更新回應更快，因為接收方在兩區塊之間會檢查中止旗標。</li>
        <li><strong>較大的延遲（如 32 768）</strong> — 資料區塊更少，吞吐量更高，傳輸中峰值主機記憶體略高。掃描中的中止回應可能延後最多一個區塊的時間。</li>
        <li><strong>發送器流水線</strong> — OUT 端點上同一時刻最多可以有 <code>max_pipeline</code> 個資料區塊在傳輸中（光柵 32，矢量 4）。當延遲與 max_pipeline 都很大時，傳輸中視窗可能超過 FX2 OUT FIFO 並停滯 — 巨集已為此做了預先調整，通常無需手動更動 max_pipeline。</li>
      </ul>

      <div className="dwell-help__table-wrap">
        <table className="dwell-help__table">
          <thead>
            <tr>
              <th>latency_bytes</th>
              <th>每區塊像素數<br /><span className="muted">（SixteenBit）</span></th>
              <th>每 1024² 畫面的區塊數</th>
              <th>備註</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>4 096</td><td>2 048</td><td>512</td><td>中止回應最快</td></tr>
            <tr><td>8 192</td><td>4 096</td><td>256</td><td>矢量近似預設</td></tr>
            <tr><td>16 384</td><td>8 192</td><td>128</td><td>光柵預設</td></tr>
            <tr><td>32 768</td><td>16 384</td><td>64</td><td>吞吐量最高</td></tr>
          </tbody>
        </table>
      </div>
    </>
  ),

  cookie: () => (
    <>
      <p>
        16 位元標記（0..65535），巨集在每次掃描開始時將其嵌入 <code>SynchronizeCommand</code>。
        FPGA 在回應串流的前 4 位元組將其回傳：<code>0xFFFF</code> 後接 cookie。
        主機在消耗像素資料之前會讀取並丟棄這 4 位元組。
      </p>

      <div className="dwell-help__rule">
        <strong>用於串流衛生，與安全無關。</strong> Cookie 與身分驗證或工作階段狀態毫無關係。
        它的存在只是為了讓主機能偵測出&ldquo;我正在讀取錯誤掃描的資料&rdquo;的情況 —
        例如，上次中止的掃描在 FX2 IN FIFO 中殘留了未排空的位元組，而下次掃描已經開始。
      </div>

      <p>實用建議：</p>

      <ul className="dwell-help__list">
        <li><strong>慣例使用 123。</strong>本程式碼庫歷史上一直如此；保留即可。</li>
        <li><strong>更改它</strong>的情境：懷疑掃描間存在殘留資料汙染時；或在多工具流水線中希望為不同的掃描類型打指紋（例如校準掃描使用 0xCA11，量產掃描使用 0xFAB0），以便後處理依據回傳的 cookie 進行分流。</li>
        <li><strong>逐請求覆寫。</strong>若 JSON 預設值與 UI 表單都設定了 cookie，則以 UI 的值為準 — 詳見服務中的 <code>RasterParams.override(…)</code>。</li>
      </ul>

      <p>
        如果掃描回傳亂碼且第一個區塊並非以 <code>0xFFFF &lt;cookie&gt;</code> 開頭，
        表示讀取到的位元組來源不對 — 要麼上次掃描沒有排空完畢，要麼傳輸過程中發生了 USB 重置。
        這兩種情況都應當重新連線，而非在同一連線上重試。
      </p>
    </>
  ),

  outputMode: () => (
    <>
      <p>
        選擇 FPGA 在 USB IN 路徑上將每個 ADC 樣本回傳給主機的序列化方式。兩種模式始終使用完整的
        14 位元 ADC；差別僅在於這些位元如何在線路上封裝。
      </p>

      <ul className="dwell-help__list">
        <li><strong>SixteenBit</strong> — 每像素 2 位元組。原始 14 位元 ADC 讀數左對齊至 uint16，大端序（高位元組在前），與 OBI 一致。這是唯一能在後處理中還原完整 ADC 動態範圍的模式。</li>
        <li><strong>EightBit</strong> — 每像素 1 位元組。FPGA 捨棄低 6 位元，僅回傳高 8 位元。USB 頻寬減半，但會損失 6 位元的動態範圍 — 依賴那些低位元的微弱特徵將無法還原。</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>頻寬與資料區塊計算會隨此欄位變化。</strong>在 <code>latency_bytes = 16 384</code> 下，
        SixteenBit 每區塊 8 192 像素；EightBit 每區塊 16 384 像素 — 為前者的兩倍。比較&ldquo;預期區塊數&rdquo;
        與&ldquo;實際接收區塊數&rdquo;的驗證檢查已計入此因素；如果您自行核算，
        請記得：EightBit 時位元組數除以 1，SixteenBit 時除以 2。
      </div>

      <p>如何選擇：</p>

      <ul className="dwell-help__list">
        <li><strong>SixteenBit</strong> — 任何在意影像品質的場合。定量 SEM、EBIC，以及任何需要後期做對比度調整或雜訊分析的工作。</li>
        <li><strong>EightBit</strong> — 當 USB 頻寬成為瓶頸、僅需預覽時。大型矢量掃描（數百萬點）且 dwell 較高，會超出 480 Mbps USB 2.0 連結時使用。螢幕顯示效果仍然良好；只是無法定量還原微弱訊號。</li>
      </ul>

      <div className="dwell-help__table-wrap">
        <table className="dwell-help__table">
          <thead>
            <tr><th>模式</th><th>每像素位元組數</th><th>1024² 畫面大小</th><th>動態範圍</th></tr>
          </thead>
          <tbody>
            <tr><td>SixteenBit</td><td>2</td><td>2 MB</td><td>14 位元（16 384 階）</td></tr>
            <tr><td>EightBit</td><td>1</td><td>1 MB</td><td>8 位元（256 階）</td></tr>
          </tbody>
        </table>
      </div>
    </>
  ),

  frameBlank: () => (
    <>
      <p>
        控制電子 / 離子束在一個畫面結束到下一個畫面開始之間的閒置時段內的行為。
      </p>

      <ul className="dwell-help__list">
        <li><strong>未勾選（false，預設）</strong> — 畫面間束流保持不消隱。重啟延遲最低：下一個畫面可立即開始。適合需要連續掃描並即時觀測結果的即時聚焦 / 成像情境。</li>
        <li><strong>勾選（true）</strong> — 巨集在畫面的最後一個像素之後追加 <code>BlankCommand(enable=True)</code>，在回掃期間以及到下次掃描之前的任何閒置期消隱束流。當掃描在畫面內被中止時也會消隱。適合束流敏感樣品（輻射敏感樣品、光刻過程中的光阻劑），或任何不希望在拍攝之間持續曝光的情境。</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>不影響畫面內消隱。</strong>畫面內的像素始終不消隱；此核取方塊只控制邊界狀態。
        若需要在掃描內部進行逐像素或逐區域的消隱，請建構矢量圖樣並在點列中嵌入{" "}
        <code>BlankCommand</code>。
      </div>

      <p>
        中止時的細微差別：若在畫面內按下<strong>停止</strong>且畫面消隱<strong>關閉</strong>，
        則束流停留在最後完成的像素位置，直到下次掃描開始。若畫面消隱<strong>開啟</strong>，
        巨集會在下一個資料區塊邊界注入 BlankCommand，在中止後數十毫秒內消隱束流。
      </p>
    </>
  ),

  validation: () => (
    <>
      <p>
        啟用時，服務會在掃描完成後、回傳結果前，對擷取的位元組串流執行一組輕量級檢查。
        典型掃描下耗時 &lt; 100 ms，不會觸碰裝置 — 只檢查記憶體中的資料區塊清單。
      </p>

      <p>光柵檢查：</p>

      <ul className="dwell-help__list">
        <li><strong>資料區塊計數</strong> — 接收方收到了由 <code>ceil(resolution² / pixels_per_chunk)</code> 預測的資料區塊數量。不相符通常代表 FPGA 發生了背壓停頓，或排空填充被截短。</li>
        <li><strong>資料區塊大小</strong> — 除最後一個區塊外，每一個皆恰為 <code>latency_bytes / sample_size</code> 個樣本。截斷的資料區塊通常代表 output_mode 與 latency_bytes 對齊不相符。</li>
        <li><strong>填充存在</strong> — 末尾用於排空流水線的填充（至少約 128 像素，外加畫面大小的 0.5 %）已由發送方正確發出。缺少填充會導致最後幾個真實像素被困在 FPGA 流水線中。</li>
      </ul>

      <p>矢量檢查：</p>

      <ul className="dwell-help__list">
        <li><strong>非空</strong> — 每一個區塊都至少包含一個樣本。完全空的串流通常代表掃描從未真正觸發（例如 FPGA 沒有看到 SynchronizeCommand）。</li>
        <li><strong>填充存在</strong> — 與光柵相同的排空填充檢查。這對矢量尤為重要，因為其排空底線高得多（預設設定下約 21 000 像素）。</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>驗證報告驅動結果面板。</strong>停用時，執行報告仍包含資料區塊計數與耗時，
        但會省略逐項的通過 / 失敗清單，執行面板僅顯示&ldquo;validation: off&rdquo;。
      </div>

      <p>何時關閉：</p>

      <ul className="dwell-help__list">
        <li><strong>高速率重複掃描</strong>：已確認環境正常、無需每次執行皆檢視報告時。</li>
        <li><strong>極致吞吐量的串流</strong> — 雖然檢查很輕量（&lt; 100 ms），仍需在記憶體中保留結果以便掃描。停用可省略此保留時段。</li>
      </ul>

      <p>
        在初次部署、排查鬆動的 USB 線纜或驗證新位元串流時，請保持開啟。這些檢查正是為了捕捉
        &ldquo;掃描完成但資料悄悄出錯&rdquo;這類成本高昂、否則難以察覺的失敗模式而設計的。
      </p>
    </>
  ),

  runValidated: () => (
    <>
      <p>
        當您需要的是<strong>阻塞式掃描結果</strong>而不是即時串流時，請使用
        <strong>驗證執行</strong>。它在光柵與矢量兩種模式下都可用，會等待掃描完成，
        然後一次性回傳耗時資料與驗證報告。
      </p>

      <div className="dwell-help__rule">
        <strong>需要報告時用這個。</strong>一般的 <code>Run</code> 只負責即時送出資料區塊，
        不會等待驗證結果。<code>驗證執行</code> 才是產生 儲存結果面板中那些掃描後檢查的路徑。
      </div>

      <p>
        光柵或矢量參數表中的驗證核取方塊，仍然決定結果裡是否包含逐項的通過 / 失敗清單。
        這個按鈕只是選擇回傳掃描結果物件的阻塞端點。
      </p>
    </>
  ),

  pattern: () => (
    <>
      <p>
        矢量模式允許主機向 FPGA 發送顯式的點列 — 每個像素一個 <code>(x, y, dwell)</code> 三元組 —
        而非讓閘級電路在內部自行產生光柵掃描。此欄位決定該點列的來源。
      </p>

      <ul className="dwell-help__list">
        <li><strong>預設掃描</strong> — 巨集按<strong>解析度</strong>所設密度，在完整 DAC 範圍內逐列產生掃描。等同於光柵掃描，但走的是矢量命令路徑。適合需要在相同涵蓋範圍內比較光柵與矢量的 A/B 測試，或因某些閘級因素導致光柵模式不可用的情形。</li>
        <li><strong>自訂點列</strong> — 您在下方文字方塊中提供點列。造訪順序與書寫順序完全一致。所有非光柵掃描皆走此模式：純 ROI 掃描、稀疏成像、光刻路徑、校準點，以及任何帶有客製化造訪順序的情境。</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>矢量的每像素速度慢於光柵。</strong>每個矢量像素都攜帶一個顯式的 (x, y, dwell) 三元組 —
        OUT 路徑上 6 位元組 — 而光柵像素使用游程編碼（RasterPixelRunCommand），
        約每整列 5 位元組。在 2048² 下，預設圖樣的矢量發送速度大約比相同涵蓋範圍的光柵慢一個數量級。
        請僅在需要矢量的彈性時使用，而非在光柵同樣可行時使用。
      </div>

      <p>
        兩種模式都經過相同的 SynchronizeCommand cookie 握手、相同的 SixteenBit/EightBit 輸出路徑，
        以及掃描末尾相同的排空填充。會話內隨時切換無任何成本；FPGA 無需重新設定。
      </p>
    </>
  ),

  vectorResolution: () => (
    <>
      <p>
        當<strong>圖樣</strong>為 <code>default</code> 時，此項決定內建掃描對 DAC 範圍取樣的稠密程度。
        涵蓋範圍<em>始終</em>是完整 DAC 範圍 — 解析度越小只是次取樣。
      </p>

      <ul className="dwell-help__list">
        <li><strong>2048 — 原生（步長 1）</strong>：造訪每個 DAC 碼值。等同於 2048 解析度的光柵，但走矢量路徑。</li>
        <li><strong>1024 — 步長 2</strong>：每隔 2 個 DAC 碼值造訪一次。點數為 ¼，掃描時間亦為 ¼。</li>
        <li><strong>512 — 步長 4</strong>：每隔 4 個 DAC 碼值。點數與時間為 1/16。</li>
        <li><strong>256 — 步長 8</strong>：每隔 8 個 DAC 碼值。點數為 1/64；適用於快速預覽掃描。</li>
        <li><strong>自訂值 1..2048</strong>：仍涵蓋完整 DAC 範圍，但取樣間距會盡量平均分布，而不是嚴格的整數步長。</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>允許範圍為 1..2048。</strong> 2 的冪預設能在 2048 x 2048 DAC 預覽網格上保持整齊映射；
        自訂值則用來更細地控制總點數。
      </div>

      <p>
        與光柵解析度不同，此欄位<em>對自訂圖樣掃描無任何影響</em>。
        當將圖樣設為 <code>custom</code> 時，造訪清單完全來自下方文字方塊 — 此欄位被忽略。
      </p>

      <div className="dwell-help__table-wrap">
        <table className="dwell-help__table">
          <thead>
            <tr><th>解析度</th><th>步長</th><th>總點數</th><th>大致掃描時間<br /><span className="muted">（dwell=1）</span></th></tr>
          </thead>
          <tbody>
            <tr><td>256</td><td>8</td><td>65 536</td><td>~16 ms</td></tr>
            <tr><td>512</td><td>4</td><td>262 144</td><td>~66 ms</td></tr>
            <tr><td>1024</td><td>2</td><td>1 048 576</td><td>~262 ms</td></tr>
            <tr><td>2048</td><td>1</td><td>4 194 304</td><td>~1.05 s</td></tr>
          </tbody>
        </table>
      </div>

      <p>
        掃描時間為數量級估計；矢量模式每像素都有 USB 額外開銷（每點攜帶一條 6 位元組命令，
        而光柵使用游程編碼），因此實際數值會略長一些。
      </p>
    </>
  ),

  customPoints: () => (
    <>
      <p>
        每行一個 <code>(x, y, dwell)</code> 三元組。各值可用逗號或空白分隔；兩者皆可。空白行會被忽略。
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

# 不合法（提交時會被拒絕）：
1.5,2.0,2      # 小數會被截斷為整數
0,0            # 缺少 dwell`}
      </pre>

      <ul className="dwell-help__list">
        <li><strong><code>x</code>、<code>y</code></strong> — DAC 碼值，閉區間 0..16383。超出範圍的值會在裝置上被截斷，但無法產生有用輸出。</li>
        <li><strong><code>dwell</code></strong> — 單位與光柵 dwell 一致：dwell 為 N 時每像素取樣 N + 1 次，每次 125 ns（revC3）。1 最快（2 個取樣）；3/7/15/31/…… 是 SNR 平均的實用值。最大可至 65535（約每像素 8.19 ms）。</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>硬性上限：1 000 000 個點。</strong>與 API 請求上 Pydantic 的{" "}
        <code>max_length</code> 一致。後端會在觸碰裝置之前以 422 拒絕過大的點列。
      </div>

      <p>大點列的效能建議：</p>

      <ul className="dwell-help__list">
        <li>啟用下方的<strong>預先處理資料區塊</strong> — 對於超過約 100k 點的點列，可將總掃描時間減少 50 % 或更多。</li>
        <li>對點列排序以減少相鄰像素之間的束流移動 — 大的 DAC 跳變會在類比通路上耗費整定時間。如無更具體的計畫，牛耕式（之字形）順序是個不錯的預設。</li>
        <li>造訪順序被嚴格保留。巨集不會重排、去重複或最佳化。若兩個連續點的 <code>(x, y)</code> 相同，束流在該處的駐留時間為兩段 dwell 之和。</li>
      </ul>

      <p>
        如需以程式產生，可從任何能輸出 CSV 的來源貼上：試算表、Python 腳本、Jupyter 筆記本皆可。
        在瀏覽器開始遲緩之前，文字方塊約可承載 50 MB 的文字，遠高於 100 萬點上限。
      </p>
    </>
  ),

  preProcess: () => (
    <>
      <p>
        每個矢量像素在 OUT 路徑上以一條 6 位元組命令發送：<code>x</code>（2 B）+ <code>y</code>（2 B）
        + <code>dwell</code>（2 B），大端序。巨集將其按<strong>延遲</strong>大小批次封裝成資料區塊。
        本核取方塊控制的是<em>何時</em>進行這一批次封裝。
      </p>

      <ul className="dwell-help__list">
        <li><strong>未勾選（按需，串流預設）</strong> — 資料區塊在發送協程內隨傳輸消耗而按需編碼。記憶體佔用最低：同一時刻 RAM 中只有傳輸中視窗（max_pipeline × latency_bytes）這麼多。但主機 CPU 需要跟上 USB；若產生點列的迭代器較慢，裝置就會因等待下一個區塊而停滯。</li>
        <li><strong>勾選（預先處理）</strong> — 巨集的 <code>_pre_process_chunks()</code> 在掃描開始時執行一次，將每個資料區塊實體化為命令物件持有的 memoryview。此時傳輸僅受 USB 吞吐量限制，與主機端編碼速度無關。代價：峰值 RAM 約為 <code>6 × total_pixels</code> 位元組（即百萬點掃描約 6 MB）。</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>實際執行的預先處理時長會單獨回報。</strong><code>process_time_s</code>{" "}
        記錄這次執行的預先處理時長；<code>send_time_s</code> 只記錄 USB 傳輸時長。
        舊版 UI 曾將兩者混為一談。
      </div>

      <p>何時啟用：</p>

      <ul className="dwell-help__list">
        <li><strong>建議啟用：</strong>任何超過約 100k 點的自訂點列，尤其是點列迭代器需要大量運算時（計算路徑、基於影像的光柵化等）。</li>
        <li><strong>建議啟用：</strong>關心總吞吐量時，高解析度（1024+）下的預設掃描。</li>
        <li><strong>不建議：</strong>非常長的掃描中，峰值 RAM 比總耗時更重要時（≥ 1000 萬點且執行在記憶體受限的主機上）。</li>
        <li><strong>不建議：</strong>低於約 10k 點的小型掃描 — 預先處理開銷與所節省的時間相當。</li>
      </ul>
    </>
  ),

  canvasView: () => (
    <>
      <p>
        這個控制只會改變目前矢量緩衝區在畫布上的繪製方式，不會改變實際掃描本身。
      </p>

      <ul className="dwell-help__list">
        <li>
          <strong>抽稀</strong> — 以目前取樣網格大小顯示即時矢量影像。每個像素對應矢量緩衝區中的一個樣本索引。
        </li>
        <li>
          <strong>原生</strong> — 將矢量影像展開到 DAC 網格。當目前矢量解析度低於 2048 時，每個取樣單元會按 DAC 步長進行區塊填充，方便在原生座標網格上檢查覆蓋情況。
        </li>
      </ul>

      <div className="dwell-help__rule">
        <strong>步長 1 時兩種檢視完全一致。</strong>當矢量解析度為 2048 時，沒有抽稀，因此切換檢視只會改變標籤。
      </div>

      <p>
        當您想分析取樣順序與影像稀疏度時，使用<strong>抽稀</strong>。
        當您想檢查較低矢量網格在 DAC 空間中的佔用範圍時，使用<strong>原生</strong>。
      </p>
    </>
  ),

  magCalibration: () => (
    <>
      <p>
        放大倍率校準用於把顯微鏡放大倍率映射到所選束流的完整水平視野（HFOV，單位米）。
      </p>

      <div className="dwell-help__rule">
        <strong>HFOV 公式。</strong>{" "}
        <code>HFOV_m = measured_length_m × (image_resolution_px / measured_line_px)</code>。
        measured length 是測量線對應的真實物理長度；measured pixels 是該測量線在影像中的像素長度。
      </div>

      <ul className="dwell-help__list">
        <li><strong>Magnification</strong> 是目前校準點的顯微鏡放大倍率。</li>
        <li><strong>Image resolution</strong> 應匹配校準所用完整影像軸，通常為 <code>max(width_px, height_px)</code>。</li>
        <li><strong>Update curve</strong> 會把目前放大倍率下計算得到的 HFOV 寫入曲線。</li>
        <li><strong>Save</strong> 會按束流保存到 <code>magCalibration.beams[beam].m_per_fov</code>。</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>X/Y 關係。</strong>放大倍率校準只保存 HFOV。ROI 的 X/Y 校準負責視口到 DUT
        座標的映射。如果像素為正方形，VFOV 可由 HFOV 按影像寬高比推導；否則 X 和 Y
        需要分別透過 ROI 校準。
      </div>

      <p>
        <strong>匯入 CSV</strong> 需要的是從本面板匯出的放大倍率校準 CSV：
        <code>Magnification,FOV (m)</code>。它不是一般掃描輸出 CSV。掃描結果 CSV
        包含取樣影像資料，不會被解析為放大倍率校準曲線。
      </p>

      <p>
        保存結果會寫入 stream 設定，並透過 <code>/api/admin/mag-calibration</code> 返回。
        其他掃描邏輯可從 defaults/config 讀取該按束流保存的映射；匯入按鈕本身只替換目前的校準點表。
      </p>

      <p>
        曲線使用 log-log 座標，因為 FOV 通常近似與放大倍率成反比。CSV 匯入/匯出使用兩欄資料：magnification 與 FOV meters。
      </p>
    </>
  ),
  scanGeometry: () => (
    <>
      <p>
        本面板把所選設備的校準檔案（profile）數值與目前束流已測得的放大倍率校準結合，
        將掃描映射為真實世界座標（µm）。在按下<strong>套用至掃描</strong>之前，不會影響實際掃描。
      </p>

      <div className="dwell-help__rule">
        <strong>1 · 來自校準檔案的數值。</strong>像素數、旋轉偏移、Y/X 長寬比、束流傾角、
        停束位置（spot park）以及廠商 dwell 基準值，均讀取自 CONFIGURATION &gt; Admin &gt;
        Calibration 中該設備與該欄（FIB/SEM）的資料。顯示為<em>未設定</em>的項會使用內建預設值——
        按旁邊的<strong>編輯</strong>可為其填入真正測量得到的值。
      </div>

      <ul className="dwell-help__list">
        <li><strong>放大倍率（Magnification）</strong>由顯微鏡本身設定，本軟體並不控制它——請填入鏡台目前實際顯示的數值。</li>
        <li><strong>HFOV 覆寫 / Pixels X / Pixels Y</strong> 僅針對本次操作點，覆寫校準檔案或放大倍率校準原本提供的值。</li>
        <li><strong>掃描旋轉</strong>與<strong>載台 X/Y</strong>描述即將掃描的畫面：其旋轉角度，以及畫面中心處的載台位置（µm）。</li>
        <li><strong>傾角校正</strong>在載台朝向束流傾斜時補償 Y 方向的比例——啟用後填入載台傾角（度）。</li>
      </ul>

      <div className="dwell-help__rule">
        <strong>3 · 結果。</strong>該操作點下計算出的掃描畫面：像素尺寸、比例係數
        （µm / DAC 碼）、視場（FOV）、畫面中心及其四個角點的世界座標，以及旋轉、剪切與畫面時間。
        只有當上方檔案中的數值是真正的校準值而非預設值時，這些結果才可信。
      </div>

      <p>
        結果旁邊的小方框畫的就是這個掃描畫面：虛線輪廓是未經校正的標稱（nominal）畫面，
        實心輪廓是校正後（rectified）的畫面，圓點標記 DAC (0, 0)，圓環標記你輸入的基準點，
        從圓環引出的紅線代表該基準點的殘差——擬合結果與它的偏差——並放大 20 倍以便看清微小誤差。
        尚未加入基準點或完成擬合時，兩條輪廓線會重疊，所以看起來只是一個普通方框——
        這是正常現象，不是錯誤。
      </p>

      <div className="dwell-help__rule">
        <strong>4 · 用基準點（fiducials）校正。</strong>對於已知真實世界位置的特徵（網格線、
        標記點、一次載台移動），填入它在影像中出現的位置（像素或 DAC）及其真實位置（µm）。
        至少加入 3 個點（仿射擬合）或 2 個點（相似變換擬合，無剪切/獨立縮放），並盡量分布在整個
        視場內，然後按<strong>擬合</strong>。殘差欄與預覽圖會顯示每個點與擬合結果的偏差。
      </div>

      <p>
        <strong>套用至掃描</strong>需要 SuperUser 或更高權限，會把結果寫入{" "}
        <code>streamData.json</code>，並讓 ROI / 點陣掃描路徑改用這個經過校正的映射。
        出現「過期」標記表示校準檔案自套用後已產生新的修訂版本——請檢查後重新套用。
        <strong>將縮放併入 HFOV</strong>（擬合後才會出現）會把擬合得到的縮放修正直接併入已保存的
        放大倍率校準曲線，而不是單獨保留為一次性校正，這樣往後在該放大倍率下的掃描會直接使用修正後的值。
      </p>
    </>
  ),
  geometryFit: () => (
    <>
      <p>
        擬合會計算一個較小的修正——縮放（X/Y）、旋轉，以及（仿射擬合時）剪切——
        使標稱（未校準）畫面盡可能與你輸入的基準點對齊：即已啟用、同時填有像素/DAC 位置
        與真實世界位置的行。這是一次最小平方擬合，本身並不會改變任何東西；之後仍需按下
        <strong>套用至掃描</strong>才會真正生效。
      </p>

      <div className="dwell-help__rule">
        <strong>仿射（affine）與相似變換（similarity）。</strong>仿射會求解獨立的 X/Y
        縮放及剪切——至少需要 3 個點——最適合擬合真實的光學畸變。相似變換只求解單一的
        縮放與旋轉（無剪切）——至少需要 2 個點——在基準點較少時更安全，因為它不會把雜訊
        誤「解釋」為剪切。
      </div>

      <p>
        當點數恰好等於最小要求時，擬合依定義就是精確的（殘差為零）——這並不代表擬合品質好，
        只是說明已經沒有多餘的資料可用來檢驗它。在信任殘差欄或預覽圖中的紅線之前，
        建議在最小點數之上再多加一兩個點，並盡量分散在整個視場內，而不是集中在一處。
      </p>
    </>
  ),
  rectifyFiducials: () => (
    <>
      <p>
        這裡提供幾個點：你既知道它們在掃描中的位置，也知道它們真實的世界座標，
        由此擬合可以求解出校準檔案本身無法給出的旋轉/剪切誤差。這一步完全是可選的——
        沒有它，第 1–3 節仍能給出一個可用、只是未經校正的畫面。
      </p>

      <div className="dwell-help__rule">
        <strong>1 · 選擇已知位置的參考特徵。</strong>
        校準標準件上的網格線、把載台移動到某個已知偏移處的標記點、一次已知距離的載台移動——
        總之，這個特徵在真實世界中的位置（µm）你已經從系統之外確知無疑。這就是擬合用來
        校驗一切的基準。
      </div>

      <div className="dwell-help__rule">
        <strong>2 · 填寫每一列。</strong>
        <em>Measured in</em>：若你是從拍到的影像上讀取位置（像素欄/列），選 pixel；
        若你已直接知道其原始束流位置代碼（0–16383），選 DAC。
        <em>Column/X</em> 與 <em>Row/Y</em>：該特徵實際出現的位置。
        <em>World X/Y (µm)</em>：它真實、已知的位置——來自第 1 步的基準值，而不是工具算出來的。
        只有兩個位置都填寫後，該列才會被計入；取消勾選某一列可將其排除而不必刪除。
      </div>

      <div className="dwell-help__rule">
        <strong>3 · 加入足夠多、分布分散的點。</strong>
        仿射擬合至少需要 3 個點（獨立的 X/Y 縮放、旋轉與剪切）；相似變換擬合至少需要 2 個點
        （僅單一縮放與旋轉，無剪切——點數較少時更安全）。盡量把點分布在整個視場內：
        角落與邊緣上的點對擬合的約束力遠大於聚在一起的點。
      </div>

      <p>
        按下<strong>擬合</strong>可計算修正值，並在預覽圖與殘差欄中顯示——僅此一步
        不會改變任何實際掃描。當點數恰好等於最小要求時，擬合依定義就是精確的（殘差為零），
        這並不代表品質好；建議在最小點數之上再加一兩個點後再信任殘差。
        只有按下<strong>套用至掃描</strong>才會真正生效，若即將取代 Dimension Cal 的
        手動測量值，會先給出警告。
      </p>
    </>
  ),
};
