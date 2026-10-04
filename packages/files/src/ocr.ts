import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Worker } from "tesseract.js";

/**
 * Text recognition for screenshots and photos of text, done locally with Tesseract (Apache-2.0) and the English
 * model shipped in @tesseract.js-data/eng, so nothing is downloaded or sent anywhere. It reads text only: layout,
 * colours and non-text content of an image are not understood.
 */
let worker: Promise<Worker> | undefined;
async function getWorker(): Promise<Worker> {
  worker ??= (async () => {
    const { createWorker } = await import("tesseract.js");
    const require = createRequire(import.meta.url);
    const langPath = join(dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");
    return createWorker("eng", 1, { langPath, gzip: true, cacheMethod: "none", logger: () => {} });
  })().catch(error => { worker = undefined; throw error; });
  return worker;
}

export interface OcrResult { text: string; confidence: number; lines: number }
/** Lines with too little recognisable content (noise around icons and borders) are dropped. */
function clean(text: string): string {
  return text.split("\n").map(l => l.replace(/\s+$/, "")).filter(l => (l.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 2).join("\n").trim();
}

/**
 * Screenshots are often small and light-on-dark (terminals, dark themes), which Tesseract reads poorly. The image is
 * made grey, inverted when its background is dark, and enlarged so text is at least ~30px tall, before recognition.
 */
export async function prepareForOcr(bytes: Buffer): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const image = sharp(bytes, { failOn: "none" }).rotate().flatten({ background: "#ffffff" }).greyscale();
  const { width = 0 } = await image.metadata();
  const stats = await image.clone().stats();
  const dark = (stats.channels[0]?.mean ?? 255) < 110;
  const scale = width && width < 1600 ? Math.min(3, 1600 / width) : 1;
  let out = image;
  if (scale > 1.05) out = out.resize({ width: Math.round(width * scale), kernel: "lanczos3" });
  if (dark) out = out.negate({ alpha: false });
  return out.normalise().png().toBuffer();
}

export async function recognizeText(bytes: Buffer): Promise<OcrResult> {
  const w = await getWorker();
  const prepared = await prepareForOcr(bytes).catch(() => bytes);
  const { data } = await w.recognize(prepared);
  const text = clean(data.text ?? "");
  return { text, confidence: Math.round(data.confidence ?? 0), lines: text ? text.split("\n").length : 0 };
}

/** Stops the recognition worker (for tests and shutdown). */
export async function stopOcr() {
  const w = worker;
  worker = undefined;
  if (w) await (await w).terminate().catch(() => {});
}
