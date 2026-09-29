import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The ADC timing settings help states ranges and defaults. Tie them to the
 * places that actually enforce them: the UI validator, the backend validator
 * and the shipped streamData.json (the upstream OBI profile).
 */
const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const LOCALES = ["en", "zh-CN", "zh-TW"].map((lang) => [lang, read(`../src/i18n/locales/${lang}.ts`)]);
const dialog = read("../src/components/SettingsDialog.tsx");
const backend = read("../../backend/src/configManager.ts");
const streamData = JSON.parse(read("../../../GlasgowDataIO/Json/streamData.json"));
const action = streamData.Actions[0].streamData.actionData;

const value = (text, key) => {
  const match = new RegExp(`"${key.replace(/\./g, "\\.")}":\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  assert.ok(match, `missing locale key ${key}`);
  return match[1];
};

test("shipped config is the upstream OBI profile the help describes", () => {
  assert.deepEqual(
    [action.adcHalfPeriod, action.adcSettleCycles, action.adcLatchCycles,
     action.busTurnaroundCycles, action.dacDataSetupCycles, action.dacLatchCycles],
    [3, 1, 1, 0, 1, 1]);
});

test("bus turnaround of zero is accepted by the UI and the backend", () => {
  assert.match(dialog, /turnaround >= 0/);
  assert.match(dialog, /turnaround: boundedTimingValue\(value, 0\)/);
  assert.match(backend, /turnaroundCycles as number\) < 0/);
});

test("turnaround help states the accepted range and default in every language", () => {
  const ranges = { en: /0 to 255/, "zh-CN": /0 到 255/, "zh-TW": /0 到 255/ };
  const defaults = { en: /default is 0/, "zh-CN": /默认值为 0/, "zh-TW": /預設值為 0/ };
  const rejected = /zero is rejected|1 to 255|不允许为零|不允許為零|1 到 255/;
  for (const [lang, text] of LOCALES) {
    const body = value(text, "settings.help.generalBusTurnaroundCycles.body");
    assert.match(body, ranges[lang], `${lang}: range`);
    assert.match(body, defaults[lang], `${lang}: default`);
    assert.doesNotMatch(body, rejected, `${lang}: must not claim zero is rejected`);
  }
});

test("the shared timing rule does not claim every window starts at 1", () => {
  for (const [lang, text] of LOCALES) {
    const rule = value(text, "settings.general.adcTiming.rule");
    assert.match(rule, /0[–-]255/, `${lang}: turnaround exception`);
    assert.match(rule, /\{minimum\}/, `${lang}: keeps the minimum placeholder`);
  }
});
