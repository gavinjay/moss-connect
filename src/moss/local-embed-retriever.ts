import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';
import {
  RetrieverNotReadyError,
  type IndexSource,
  type MossDocument,
  type MossRetriever,
  type RetrieveOptions,
  type RetrieveResult,
  type RetrieverState,
  type RetrieverStats,
} from './retriever';

/**
 * BENCHMARK ARM: local sentence embeddings + brute-force cosine similarity.
 *
 * WHY THIS ARM EXISTS
 * -------------------
 * It is the "why do I need Moss at all?" arm.
 *
 * Any competent engineer evaluating Moss will say: I can embed locally with
 * MiniLM and do a dot product over my documents -- in-process, no network, no
 * vendor. If Moss cannot beat that, Moss has no story. If it can, THAT is the
 * argument, and it is a far stronger one than beating a network round trip.
 *
 * So this arm is semantic like Moss, in-process like Moss, and free. It isolates
 * exactly what Moss adds over the obvious do-it-yourself approach: index
 * structure that beats a linear scan at scale, and embedding quality.
 *
 * It also exposes something a headline number can hide. An embedding retriever
 * must embed the QUERY before it can search, on the hot path, every time. This
 * arm reports `embedMs` and `searchMs` separately so you can ask Moss precisely
 * which of the two their sub-10ms figure covers -- see question 8 in
 * docs/MOSS_QUESTIONS.md.
 *
 * Model: Xenova/all-MiniLM-L6-v2 (384 dims, quantised ONNX), run via
 * transformers.js. Downloaded once and cached; no API key, no AWS, no network at
 * query time.
 */
export class LocalEmbedRetriever implements MossRetriever {
  private extractor: FeatureExtractionPipeline | null = null;
  private documents: readonly MossDocument[] = [];
  private vectors: Float32Array[] = [];
  private state: RetrieverState = 'unloaded';
  private indexVersion: string | null = null;
  private loadMs: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly modelId = 'Xenova/all-MiniLM-L6-v2') {}

  async load(source: IndexSource): Promise<void> {
    const started = performance.now();
    this.state = 'loading';
    try {
      const documents =
        source.kind === 'documents'
          ? source.documents
          : (JSON.parse(new TextDecoder().decode(source.bytes)) as MossDocument[]);

      this.extractor = await pipeline('feature-extraction', this.modelId, { quantized: true });
      // Embedding the corpus is the real load cost, and it grows linearly with
      // the corpus. This is the number that becomes cold-start pain.
      this.vectors = [];
      for (const doc of documents) {
        this.vectors.push(await this.embed(doc.text));
      }
      this.documents = documents;
      this.indexVersion = source.version;
      this.state = 'ready';
      this.lastError = null;
    } catch (err) {
      this.state = 'failed';
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.loadMs = performance.now() - started;
    }
  }

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<RetrieveResult> {
    if (this.state !== 'ready' || this.indexVersion === null) {
      throw new RetrieverNotReadyError(this.state);
    }
    const started = performance.now();
    const topK = options.topK ?? 3;
    const minScore = options.minScore ?? 0;

    // On the hot path, unavoidably: you cannot search a vector index without a
    // query vector.
    const queryVector = await this.embed(query);
    const embedMs = performance.now() - started;

    const searchStart = performance.now();
    const scored: { doc: MossDocument; score: number }[] = [];
    for (let i = 0; i < this.documents.length; i++) {
      const doc = this.documents[i];
      if (options.filter && !matchesFilter(doc, options.filter)) continue;
      // Vectors are L2-normalised, so a dot product IS cosine similarity.
      const score = dot(queryVector, this.vectors[i]);
      if (score > minScore) scored.push({ doc, score });
    }
    scored.sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));
    const searchMs = performance.now() - searchStart;

    return {
      hits: scored.slice(0, topK).map(({ doc, score }) => ({
        id: doc.id,
        text: doc.text,
        score,
        ...(doc.metadata ? { metadata: doc.metadata } : {}),
      })),
      elapsedMs: performance.now() - started,
      indexVersion: this.indexVersion,
      breakdown: { embedMs, searchMs },
    };
  }

  stats(): RetrieverStats {
    return {
      state: this.state,
      indexVersion: this.indexVersion,
      documentCount: this.documents.length,
      loadMs: this.loadMs,
      lastError: this.lastError,
    };
  }

  private async embed(text: string): Promise<Float32Array> {
    if (!this.extractor) throw new RetrieverNotReadyError(this.state);
    const out = await this.extractor(text, { pooling: 'mean', normalize: true });
    return out.data as Float32Array;
  }
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function matchesFilter(doc: MossDocument, filter: Readonly<Record<string, string>>): boolean {
  return Object.entries(filter).every(([key, value]) => doc.metadata?.[key] === value);
}
