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

export async function recognizeText(bytes: Buffer): Promise<OcrResult> {
  const w = await getWorker();
  const { data } = await w.recognize(bytes);
  const text = clean(data.text ?? "");
  return { text, confidence: Math.round(data.confidence ?? 0), lines: text ? text.split("\n").length : 0 };
}

/** Stops the recognition worker (for tests and shutdown). */
export async function stopOcr() {
  const w = worker;
  worker = undefined;
  if (w) await (await w).terminate().catch(() => {});
}
