import { join } from "node:path";
import { dataRoot } from "../../db/src/local.ts";

/** Turns text into vectors whose dot product measures similarity of meaning. */
export interface Embedder {
  readonly id: string;
  embed(texts: string[], kind: "query" | "passage"): Promise<number[][]>;
}

/**
 * Local, free embeddings with transformers.js (ONNX on CPU). BGE-small is a strong small retrieval model
 * (MIT licence, 384 dimensions); it is downloaded once into data/models and then runs offline.
 * Calls are serialised because one model instance is shared by the whole process.
 */
export class LocalEmbedder implements Embedder {
  readonly id: string;
  private extractor?: Promise<(texts: string[], options: Record<string, unknown>) => Promise<{ tolist(): number[][] }>>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly model = process.env.EMBEDDING_MODEL || "Xenova/bge-small-en-v1.5") { this.id = model; }

  private load() {
    this.extractor ??= (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = join(dataRoot, "models", "transformers");
      return (await pipeline("feature-extraction", this.model, { dtype: "q8" })) as never;
    })();
    return this.extractor;
  }
  embed(texts: string[], kind: "query" | "passage"): Promise<number[][]> {
    const run = async () => {
      const extract = await this.load();
      // BGE models retrieve best when queries (not passages) carry this instruction.
      const inputs = kind === "query" && /bge/i.test(this.model) ? texts.map(t => `Represent this sentence for searching relevant passages: ${t}`) : texts;
      const vectors: number[][] = [];
      for (let i = 0; i < inputs.length; i += 16) vectors.push(...(await extract(inputs.slice(i, i + 16), { pooling: /bge/i.test(this.model) ? "cls" : "mean", normalize: true })).tolist());
      return vectors;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
