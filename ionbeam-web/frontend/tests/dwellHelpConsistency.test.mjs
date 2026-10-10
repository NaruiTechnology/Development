import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  GLASGOW_REVC3_ADC_HALF_PERIOD_CYCLES,
  GLASGOW_REVC3_CLOCK_HZ,
  estimateRevC3ScanTiming,
  samplesPerPixel,
} from "../.test-dist/lib/scanTiming.js";

/**
 * The dwell help is static text in three languages. It quotes the ADC sample
 * period and figures derived from it (rates, frame times, max dwell). When the
 * FPGA half-period changed from 4 to 3 the code followed but the text did not,
 * so the UI kept quoting 166.7 ns. Separately, the text treated one dwell unit
 * as one sample although the gateware takes dwell + 1. These tests tie every
 * such figure to scanTiming.ts (samples per pixel = dwell + 1) so neither can
 * happen silently.
 */
const read = (relative) => readFileSync(new URL(`../src/${relative}`, import.meta.url), "utf8");
const LANGUAGES = ["en", "zh-CN", "zh-TW"];
const HELP = LANGUAGES.map((lang) => [`i18n/help/${lang}.tsx`, read(`i18n/help/${lang}.tsx`)]);
const LOCALES = LANGUAGES.map((lang) => [`i18n/locales/${lang}.ts`, read(`i18n/locales/${lang}.ts`)]);
const OTHER = [
  ["components/SettingsDialog.tsx", read("components/SettingsDialog.tsx")],
  ["types/api.ts", read("types/api.ts")],
];
const ALL = [...HELP, ...LOCALES, ...OTHER];

const PERIOD_NS = estimateRevC3ScanTiming(1, 1).samplePeriodNs;
const near = (actual, expected, relative) =>
  Math.abs(actual - expected) <= Math.abs(expected) * relative;

function seconds(text) {
  const match = /([\d.]+)\s*(ms|s)\b/.exec(text.replace(/[~≈]/g, ""));
  return match ? Number(match[1]) * (match[2] === "ms" ? 1e-3 : 1) : null;
}

function pixelsPerSecond(text) {
  const match = /([\d.]+)\s*(M|k)Pix\/s/.exec(text);
  return match ? Number(match[1]) * (match[2] === "M" ? 1e6 : 1e3) : null;
}

test("the ADC sample period under test is the 6-cycle, 125 ns revC3 period", () => {
  assert.equal(GLASGOW_REVC3_ADC_HALF_PERIOD_CYCLES, 3);
  assert.ok(near(PERIOD_NS, 125, 1e-9));
  assert.ok(near(1e9 / GLASGOW_REVC3_CLOCK_HZ, 20.8333, 1e-4));
});

test("no help text quotes the sample period of any other half-period", () => {
  // Half-period 3 is current. Half-period 2 (83.333 ns) is excluded because
  // 83.333 ns legitimately appears as a 4-cycle latch pulse elsewhere. Periods
  // that are whole multiples of 125 ns (250, 375, 500 ns...) are excluded too:
  // they are legitimate pixel times (N samples x 125 ns), so a stale half-period
  // that happens to coincide with one cannot be told apart by value.
  const forbidden = [4, 5, 6, 7, 8, 9, 10, 11, 12]
    .map((half) => (2 * half * 1e9) / GLASGOW_REVC3_CLOCK_HZ)
    .filter((value) => Math.abs(value / PERIOD_NS - Math.round(value / PERIOD_NS)) > 1e-3);
  for (const [name, text] of ALL) {
    for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*ns\b/g)) {
      const value = Number(match[1]);
      for (const stale of forbidden) {
        assert.ok(!near(value, stale, 5e-4),
          `${name} quotes ${match[0]}, which is the base period for another half-period`);
      }
    }
  }
});

test("every language states the current base period where it defines the dwell unit", () => {
  for (const [name, text] of [...HELP, ...LOCALES, ...OTHER]) {
    const quoted = [...text.matchAll(/(\d+(?:\.\d+)?)\s*ns\s*(?:units?|sample|ADC|revC3|单位|單位|采样|取樣|樣|周期|週期)/g)];
    const inDwellContext = quoted.filter((m) => !near(Number(m[1]), 20.8333, 1e-3) && !near(Number(m[1]), 83.333, 1e-3));
    for (const match of inDwellContext) {
      assert.ok(near(Number(match[1]), PERIOD_NS, 5e-4), `${name}: "${match[0]}" should be ${PERIOD_NS} ns`);
    }
  }
  for (const [name, text] of HELP) {
    assert.match(text, new RegExp(`${PERIOD_NS}(?:\\.0+)? ns`), `${name} must state the base period`);
  }
});

test("no rate figure contradicts the 8 MS/s sample rate", () => {
  const sampleRate = 1e9 / PERIOD_NS;
  // A pixel takes dwell + 1 samples; dwell 0 (one sample) is the sample rate.
  const allowed = [0, 1, 3, 7, 15, 31, 63].map((dwell) => estimateRevC3ScanTiming(1, dwell).pixelRate);
  for (const [name, text] of [...HELP, ...LOCALES]) {
    for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(M|k)(?:Pix|Pixels)\/s/g)) {
      const value = Number(match[1]) * (match[2] === "M" ? 1e6 : 1e3);
      assert.ok(allowed.some((rate) => near(value, rate, 5e-3)), `${name}: ${match[0]} is not ${sampleRate} / 2^k`);
    }
    for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:MS\/s|MSPS|MSamples\/s)/g)) {
      assert.ok(near(Number(match[1]) * 1e6, sampleRate, 5e-3), `${name}: ${match[0]} is not ${sampleRate / 1e6} MS/s`);
    }
  }
});

test("the ADC/DAC transaction length quoted in help equals twice the half-period", () => {
  const words = { four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const expected = 2 * GLASGOW_REVC3_ADC_HALF_PERIOD_CYCLES;
  const [, english] = HELP[0];
  const en = /configured (\w+)-clock ADC\/DAC transaction/.exec(english.replace(/\s+/g, " "));
  assert.ok(en, "English help must state the transaction length");
  assert.equal(words[en[1].toLowerCase()], expected);
  for (const [name, text] of HELP.slice(1)) {
    const match = /(\d+)\s*(?:时钟|時脈)\s*ADC\/DAC/.exec(text.replace(/\s+/g, " "));
    assert.ok(match, `${name} must state the transaction length`);
    assert.equal(Number(match[1]), expected, name);
  }
});

test("dwell bullet lists quote the pixel rate for each dwell value", () => {
  for (const [name, text] of HELP) {
    let checked = 0;
    for (const match of text.matchAll(/"dwell": (\d+)<\/code>([^\n]*)/g)) {
      const rate = pixelsPerSecond(match[2]);
      if (rate === null) continue;
      const expected = estimateRevC3ScanTiming(1, Number(match[1])).pixelRate;
      assert.ok(near(rate, expected, 5e-3), `${name}: dwell ${match[1]} quotes ${rate}, expected ${expected}`);
      assert.ok(Number.isInteger(Math.log2(samplesPerPixel(Number(match[1])))),
        `${name}: dwell ${match[1]} does not give a power-of-two sample count`);
      checked += 1;
    }
    assert.ok(checked >= 6, `${name}: expected the dwell 1..63 bullets, found ${checked}`);
  }
});

test("dwell and resolution tables agree with the timing model", () => {
  for (const [name, text] of HELP) {
    let rows = 0;
    for (const table of text.matchAll(/<table[\s\S]*?<\/table>/g)) {
      const block = table[0];
      const header = block.slice(0, block.indexOf("<tbody>"));
      const firstHeader = (/<th>(.*?)<\/th>/.exec(header)?.[1] ?? "").replace(/<[^>]+>/g, "").trim();
      const dwellColumn = /^dwell$/i.test(firstHeader);
      const resolutionColumn = /^(resolution|分辨率|解析度)$/i.test(firstHeader);
      if (!dwellColumn && !resolutionColumn) continue;   // skips latency/mode tables
      const fixedDwell = /dwell\s*=\s*(\d+)/.exec(header);
      assert.ok(dwellColumn || fixedDwell, `${name}: resolution table must state its dwell`);
      for (const row of block.matchAll(/<tr>(.*?)<\/tr>/g)) {
        const cells = [...row[1].matchAll(/<td>(.*?)<\/td>/g)].map((c) => c[1].trim());
        if (cells.length < 3) continue;
        const key = Number(cells[0]);
        const resolution = dwellColumn ? 1024 : key;
        const dwell = dwellColumn ? key : Number(fixedDwell[1]);
        const model = estimateRevC3ScanTiming(resolution, dwell);
        if (dwellColumn) {
          assert.equal(cells[1], String(samplesPerPixel(dwell)), `${name}: samples/pixel for dwell ${dwell}`);
          const snrCell = cells.find((c) => /×$/.test(c));
          assert.ok(near(Number(snrCell.replace("×", "")), Math.sqrt(model.samplesPerPixel / 2), 6e-3),
            `${name}: SNR gain ${snrCell} at dwell ${dwell}`);
        }
        const timeCell = [...cells].reverse().find((c) => /^~?\s*[\d.]+\s*(ms|s)$/.test(c));
        assert.ok(timeCell, `${name}: no time cell in ${row[1]}`);
        const tolerance = timeCell.startsWith("~") ? 0.03 : 0.006;
        assert.ok(near(seconds(timeCell), model.frameSeconds, tolerance),
          `${name}: ${resolution}² at dwell ${dwell} shows ${timeCell}, model says ${(model.frameSeconds * 1e3).toFixed(2)} ms`);
        const rateCell = cells.find((c) => /Pix\/s/.test(c));
        if (rateCell) {
          assert.ok(near(pixelsPerSecond(rateCell), model.pixelRate, 5e-3), `${name}: ${rateCell} at dwell ${dwell}`);
        }
        const sampleCell = cells.find((c) => /MS\/s/.test(c));
        if (sampleCell) {
          assert.ok(near(Number(sampleCell.split(" ")[0]) * 1e6, 1e9 / PERIOD_NS, 5e-3), `${name}: ${sampleCell}`);
        }
        rows += 1;
      }
    }
    assert.ok(rows >= 14, `${name}: expected to validate the dwell and resolution tables, checked ${rows} rows`);
  }
});

test("the quoted maximum-dwell time is 65535 base periods", () => {
  for (const [name, text] of HELP) {
    const found = [...text.matchAll(/65535[^\n]{0,40}?([\d.]+)\s*ms/g)];
    assert.ok(found.length >= 1, `${name}: expected the max-dwell figure`);
    for (const match of found) {
      const expected = estimateRevC3ScanTiming(1, 65535).pixelDwellNs / 1e6;
      assert.ok(near(Number(match[1]), expected, 6e-3), `${name}: ${match[1]} ms, expected ${expected.toFixed(2)} ms`);
    }
  }
});

test("the frame-time formula uses dwell + 1 samples of the current period", () => {
  for (const [name, text] of HELP) {
    const formula = /N²\s*×\s*\(dwell \+ 1\)\s*×\s*([\d.]+)\s*ns/.exec(text);
    assert.ok(formula, `${name}: expected the frame-time formula`);
    assert.ok(near(Number(formula[1]), PERIOD_NS, 5e-4), `${name}: formula uses ${formula[1]} ns`);
  }
});

test("every help states that a dwell of N takes N + 1 samples", () => {
  for (const [name, text] of HELP) {
    assert.match(text, /N \+ 1/, `${name} must explain the dwell + 1 convention`);
  }
});

test("no text still defines a dwell unit as one 125 ns sample", () => {
  const oldConvention = /125 ns units?|125 ns 单位|125 ns 單位|ns sample periods accumulated|same units as raster dwell: number of|单位与光栅 dwell 一致：当前|單位與光柵 dwell 一致：目前|supersampler does nothing|no supersampling|超采样器不工作|无超采样|超取樣器不工作|無超取樣/;
  for (const [name, text] of ALL) {
    assert.doesNotMatch(text, oldConvention, `${name} still defines a dwell unit as one sample`);
  }
});

test("the live dwell label receives the sample count", () => {
  for (const [name, text] of LOCALES) {
    assert.match(text, /"scan\.dwell\.dynamic": "[^"]*\{samples\}/, `${name}: scan.dwell.dynamic must show {samples}`);
  }
  for (const file of ["components/RasterScanExecutionSettings.tsx", "components/VectorScanExecutionSettings.tsx", "components/VectorParameters.tsx"]) {
    assert.match(read(file), /samples: timing\.samplesPerPixel/, `${file} must pass samples to the label`);
  }
});
