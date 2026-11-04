import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config";
import { writeConfig } from "../src/configManager";

test("pipeline limits persist for both modes and reject values that stall the sender", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pipeline-config-"));
  const original = config.configPath;
  config.configPath = path.join(directory, "streamData.json");
  const data = (name: string, key: string, value: unknown) => ({
    Actions: [{ streamData: { actionData: { [name]: { [key]: value } } } }],
  });
  try {
    for (const name of ["rasterScan", "vectorScan"]) {
      for (const key of ["max_pipeline", "maxPipeline"]) {
        for (const value of [1, 3, 4, 32]) {
          const body = data(name, key, value);
          await writeConfig(body);
          assert.deepEqual(JSON.parse(await fs.readFile(config.configPath, "utf8")), body);
        }
        const before = await fs.readFile(config.configPath, "utf8");
        for (const value of [0, -1, 1.5, "4", null]) {
          await assert.rejects(writeConfig(data(name, key, value)), /positive integer/);
          assert.equal(await fs.readFile(config.configPath, "utf8"), before);
        }
      }
    }
  } finally {
    config.configPath = original;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
