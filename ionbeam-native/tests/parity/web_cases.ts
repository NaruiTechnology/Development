// Golden cases for the web -> native port. Bundled with esbuild and run by
// Node (tests/parity/generate.mjs); the Python side (tests/test_web_parity.py)
// replays every case against the ported functions.
import * as L from "../../../ionbeam-web/frontend/src/lib/displayLevels";
import * as T from "../../../ionbeam-web/frontend/src/lib/scanTiming";
import * as G from "../../../ionbeam-web/frontend/src/lib/grayScaleSelection";
import * as V from "../../../ionbeam-web/frontend/src/lib/vectorScanPath";
import * as R from "../../../ionbeam-web/frontend/src/lib/scanRepeat";
import * as S from "../../../ionbeam-web/frontend/src/lib/scanSamples";

type Case = { fn: string; args: unknown[]; out: unknown };
const cases: Case[] = [];
const add = (fn: string, args: unknown[], out: unknown) =>
  cases.push({ fn, args, out: out instanceof Uint8Array ? Array.from(out) : out });

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

for (let i = 0; i < 40; i++) {
  const v = Math.floor(rnd() * 65536);
  add("sampleToCode", [v], L.sampleToCode(v));
  add("codeToSample", [v >> 2], L.codeToSample(v >> 2));
  const lo = Math.floor(rnd() * 30000), hi = lo + Math.floor(rnd() * 35000) + 1;
  add("levelGray", [v, lo, hi], L.levelGray(v, lo, hi));
  add("normalizeLevels", [lo - 5000, hi + 3000], L.normalizeLevels(lo - 5000, hi + 3000));
  add("normalizeLevels", [hi, lo], L.normalizeLevels(hi, lo));
  const dom = { min: lo, max: hi };
  add("valueToFraction", [v, dom], L.valueToFraction(v, dom));
  add("fractionToValue", [rnd() * 1.2 - 0.1, dom], L.fractionToValue(cases.length % 7 / 6, dom));
  add("niceCodeTicks", [dom], L.niceCodeTicks(dom));
  for (const kind of ["low", "high", "region"] as const) {
    add("dragLevels", [kind, { low: lo, high: hi }, v, 37], L.dragLevels(kind, { low: lo, high: hi }, v, 37));
  }
  add("grayLevelLut", [{ low: lo, high: hi }], L.grayLevelLut({ low: lo, high: hi }));
}
// fractionToValue args above use a derived fraction; recompute consistently
for (const c of cases) if (c.fn === "fractionToValue") {
  c.args[0] = Number(c.args[0]);
  c.out = L.fractionToValue(c.args[0] as number, c.args[1] as { min: number; max: number });
}
for (let i = 0; i < 12; i++) {
  const n = 200 + Math.floor(rnd() * 3000);
  const values = Array.from({ length: n }, () => Math.floor(rnd() * rnd() * 65535));
  const min = Math.min(...values), max = Math.max(...values);
  const hist = L.buildHistogram(min, max, n, (visit) => values.forEach((v) => visit(v)));
  const plain = { min: hist.min, max: hist.max, total: hist.total, bins: Array.from(hist.bins) };
  add("buildHistogram", [min, max, n, values], plain);
  for (const p of [0.1, 1, 5, 50, 95, 99, 99.9]) add("histogramPercentile", [plain, p], L.histogramPercentile(hist, p));
  const auto = L.resolveLevels(hist, { mode: "auto", low: 0, high: 65532 });
  add("resolveLevels", [plain, { mode: "auto", low: 0, high: 65532 }], auto);
  add("resolveLevels", [plain, { mode: "manual", low: 1000 + i, high: 40000 - i }],
      L.resolveLevels(hist, { mode: "manual", low: 1000 + i, high: 40000 - i }));
  add("wedgeDomain", [plain, auto], L.wedgeDomain(hist, auto));
}
for (const d of [0, 1, 2, 3, 7, 15, 16, 31, 63, 100.7, -3]) {
  add("samplesPerPixel", [d], T.samplesPerPixel(d));
  for (const r of [1, 256, 1024, 2048]) add("estimateRevC3ScanTiming", [r, d], T.estimateRevC3ScanTiming(r, d));
}
add("revC3DwellPresetOptions", [], T.revC3DwellPresetOptions());
for (const x of [0, 1, 999, 1e6, 1234567, 8e6, 470588.2352941176, 2.5e6]) add("formatPixelRate", [x], T.formatPixelRate(x));
for (const x of [1e-9, 5e-7, 2.125e-6, 0.00042, 0.5, 2.228, 61.3, 3600.2]) add("formatDuration", [x], T.formatDuration(x));
for (const x of [125, 999.9, 2125, 17000, 2.5e6]) add("formatNanoseconds", [x], T.formatNanoseconds(x));
for (const v of [-4, 0, 17.5, 255, 300, NaN]) add("clampGrayScale", [String(v)], G.clampGrayScale(v));
for (const sel of [[3, 200], [200, 3], [-5, 999], [7, 7]] as [number, number][]) {
  add("normalizeGrayScaleSelection", [sel], G.normalizeGrayScaleSelection(sel));
  add("formatGrayScaleSelection", [sel], G.formatGrayScaleSelection(sel));
  add("grayScaleSelectionContains", [sel, 100], G.grayScaleSelectionContains(sel, 100));
}
for (const path of ["horizontal_sawtooth", "horizontal_serpentine", "vertical_sawtooth", "vertical_serpentine",
  "hilbert", "spiral"]) {
  for (const edge of [1, 2, 5, 16, 33]) {
    add("vectorScanSampleCount", [edge, path], V.vectorScanSampleCount(edge, path as never));
    for (const idx of [0, 1, edge, edge * edge - 1, edge * edge, Math.floor(edge * edge / 3)]) {
      const p = V.vectorScanSamplePixel(idx, edge, path as never);
      add("vectorScanSamplePixel", [idx, edge, path], p);
    }
  }
}
for (const [a, b, c] of [[1, 0, false], [5, 3, true], [5, 0, true], [0, 2, true], [3.9, 9, true]] as [number, number, boolean][]) {
  add("repeatCountdownDisplay", [a, b, c], R.repeatCountdownDisplay(a, b, c));
}
for (const v of [0, 4, 100, 32768, 65532, 70000, -3]) {
  add("scaleScanSample", [v], S.scaleScanSample(v));
  add("scaleScanSample", [v, 1000, 30000], S.scaleScanSample(v, 1000, 30000));
}
console.log(JSON.stringify(cases));
