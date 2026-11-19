import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readProcessingImage } from "../src/processingImageConfig";

test("Processing loads the configured relative image only in explicit simulation", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "processing-image-"));
  const patterns = path.join(folder, "processingPatterns.json"); // Base directory only; this file does not exist.
  let header: Record<string, unknown> = { LoadImage: "source.png" };
  const stream = path.join(folder, "streamData.json");
  try {
    fs.writeFileSync(stream, JSON.stringify({ IsProduction: false }));
    const data = Buffer.from("test image bytes");
    fs.writeFileSync(path.join(folder, "source.png"), data);
    assert.deepEqual(readProcessingImage(patterns, stream, header), {
      is_production: false, image: { name: "source.png", data_url: `data:image/png;base64,${data.toString("base64")}` },
    });
    for (const value of [true, undefined, "false", 0]) {
      fs.writeFileSync(stream, JSON.stringify({ IsProduction: value }));
      // Production must not even read the image configuration.
      assert.deepEqual(readProcessingImage(path.join(folder, "missing.json"), stream, header), { is_production: true, image: null });
    }
    fs.writeFileSync(stream, JSON.stringify({ IsProduction: false }));
    header = { LoadImage: "" };
    assert.equal(readProcessingImage(patterns, stream, header).image, null);
    header = { LoadImage: "missing.png" };
    assert.throws(() => readProcessingImage(patterns, stream, header), /ENOENT/);
    header = { LoadImage: "source.txt" };
    assert.throws(() => readProcessingImage(patterns, stream, header), /supported image/);
    header = { LoadImage: 123 };
    assert.throws(() => readProcessingImage(patterns, stream, header), /file path/);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
