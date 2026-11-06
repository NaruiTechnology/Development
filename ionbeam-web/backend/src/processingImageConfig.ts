import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "./configManager";

/** Read only the image named by local configuration; requests cannot supply a path. */
export function readProcessingImage(patternsPath: string, streamConfigPath: string) {
  const stream = JSON.parse(fs.readFileSync(streamConfigPath, "utf8"));
  if (stream.IsProduction !== false) return { is_production: true, image: null };
  const patterns = JSON.parse(fs.readFileSync(patternsPath, "utf8"));
  const configured = patterns?.Header?.LoadImage;
  if (configured === undefined || configured === null || configured === "") {
    return { is_production: false, image: null };
  }
  if (typeof configured !== "string") throw new ConfigError("Header.LoadImage must be a file path", 400);
  const filename = path.resolve(path.dirname(patternsPath), configured);
  const mime: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".bmp": "image/bmp",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  };
  const type = mime[path.extname(filename).toLowerCase()];
  if (!type) throw new ConfigError("Header.LoadImage must name a supported image file", 400);
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) {
    throw new ConfigError("Header.LoadImage must name an image file no larger than 32 MiB", 400);
  }
  return { is_production: false, image: {
    name: path.basename(filename), data_url: `data:${type};base64,${fs.readFileSync(filename).toString("base64")}`,
  } };
}
