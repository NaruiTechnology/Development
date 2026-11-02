import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

test("measurement gesture reports calibrated dimensions, retains lines and supports undo/cancel", async () => {
  const previousWindow = globalThis.window;
  const keys = new Map();
  globalThis.window = {
    addEventListener: (name, fn) => keys.set(name, fn),
    removeEventListener: (name, fn) => { if (keys.get(name) === fn) keys.delete(name); },
  };
  const listeners = new Map();
  let captured = false;
  const frame = {
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }),
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
    setPointerCapture: () => { captured = true; },
    hasPointerCapture: () => captured,
    releasePointerCapture: () => { captured = false; },
  };
  const event = (type, x, y, extra = {}) => ({
    type, clientX: x, clientY: y, pointerId: 1, button: 0, ctrlKey: true, shiftKey: true,
    target: { closest: () => null }, preventDefault() {}, stopImmediatePropagation() {}, ...extra,
  });
  const fire = (type, x, y, extra) => act(() => listeners.get(type)(event(type, x, y, extra)));
  const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  let renderer;
  try {
    const { TextureMeasurements } = await vite.ssrLoadModule("/src/components/TextureMeasurements.tsx");
    const { translate } = await vite.ssrLoadModule("/src/i18n/index.ts");
    const props = { t: (key, vars) => translate("en", key, vars), frameRef: { current: frame }, edge: 100, extent: { x: 20, y: 10, unit: "µm" }, rotate90: false, enabled: true };
    await act(async () => { renderer = create(React.createElement(TextureMeasurements, props)); });
    fire("pointerdown", 10, 20, { ctrlKey: false });
    assert.equal(renderer.root.findAllByType("line").length, 0);
    fire("pointerdown", 10, 20);
    fire("pointermove", 110, 70);
    assert.equal(captured, true);
    let text = JSON.stringify(renderer.toJSON());
    assert.ok(text.includes("11.18"), text);
    assert.ok(text.includes("50.00"), text);
    assert.equal(renderer.root.findByType("line").props.strokeWidth, "1");
    fire("pointerup", 110, 70);
    assert.equal(captured, false);
    assert.equal(renderer.root.findAllByType("line").length, 1);
    assert.equal(renderer.root.findAllByProps({ className: "texture-measurement-chip" }).length, 0);
    assert.equal(renderer.root.findAllByType("button").length, 0);
    assert.equal(renderer.root.findByType("text").children.join(""), "11.18 µm");
    act(() => keys.get("keydown")({ key: "z", ctrlKey: true, shiftKey: false,
      target: { closest: () => null }, preventDefault() {}, stopImmediatePropagation() {} }));
    assert.equal(renderer.root.findAllByType("line").length, 0);
    fire("pointerdown", 10, 20);
    fire("pointermove", 1000, -100);
    assert.equal(renderer.root.findByType("line").props.x2, "100%");
    assert.equal(renderer.root.findByType("line").props.y2, "0%");
    fire("pointercancel", 1000, -100);
    assert.equal(renderer.root.findAllByType("line").length, 0);
    await act(async () => { renderer.update(React.createElement(TextureMeasurements, { ...props, rotate90: true })); });
    fire("pointerdown", 10, 20);
    fire("pointerup", 110, 20);
    text = JSON.stringify(renderer.toJSON());
    assert.ok(text.includes("5.00"), text);
    act(() => keys.get("keydown")({ key: "z", ctrlKey: true, shiftKey: false,
      target: { closest: () => null }, preventDefault() {}, stopImmediatePropagation() {} }));
    assert.equal(renderer.root.findAllByType("line").length, 0);
    for (const [locale, lengthLabel, pixelLabel] of [
      ["en", "Length:", "Pixel size X:"],
      ["zh-CN", "长度：", "像素尺寸 X："],
      ["zh-TW", "長度：", "像素尺寸 X："],
    ]) {
      await act(async () => { renderer.update(React.createElement(TextureMeasurements, {
        ...props, t: (key, vars) => translate(locale, key, vars),
      })); });
      fire("pointerdown", 10, 20);
      fire("pointermove", 110, 70);
      text = JSON.stringify(renderer.toJSON());
      assert.ok(text.includes(lengthLabel), text);
      assert.ok(text.includes(pixelLabel), text);
      assert.ok(text.includes("11.18"), "switching locale preserves the measurement");
      fire("pointercancel", 110, 70);
      const { helpBodies } = await vite.ssrLoadModule(`/src/i18n/help/${locale}.tsx`);
      let help;
      act(() => { help = create(helpBodies.scanModes()); });
      const helpText = JSON.stringify(help.toJSON());
      assert.ok(helpText.includes("Ctrl + Shift"), `${locale} documents texture measurement`);
      assert.ok(helpText.includes("Ctrl + Z"), `${locale} documents undo`);
      assert.ok(help.root.findAllByType("li").length >= 12, `${locale} includes the mouse control reference`);
      act(() => help.unmount());
    }
  } finally {
    if (renderer) act(() => renderer.unmount());
    await vite.close();
    globalThis.window = previousWindow;
  }
});
