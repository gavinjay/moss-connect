import {
  RetrieverNotReadyError,
  type IndexSource,
  type MossRetriever,
  type RetrieveOptions,
  type RetrieveResult,
  type RetrieverState,
  type RetrieverStats,
} from './retriever';

/**
 * Adapter for the real Moss SDK.
 *
 * ---------------------------------------------------------------------------
 * UNVERIFIED SURFACE -- READ BEFORE EDITING
 * ---------------------------------------------------------------------------
 * The Moss JS SDK's actual API has NOT been inspected. Rather than guess at
 * import paths and method names -- which produces code that looks finished,
 * compiles, and is wrong -- this adapter takes the handful of operations it
 * needs as an injected `MossSdkBindings` object.
 *
 * Wiring the real SDK is then a ~20-line binding in one place, with nothing
 * fabricated anywhere else in the codebase.
 *
 * Questions to settle with the Moss team (see docs/MOSS_QUESTIONS.md):
 *   1. Index artifact format, and whether a prebuilt index can be loaded from
 *      raw bytes (required: Lambda pulls bytes from S3 at init).
 *   2. Whether the Node/WASM runtime initialises without network access.
 *   3. Score semantics -- range, direction, and whether it is comparable
 *      across index versions.
 *   4. Thread/instance safety for a single index reused across invocations.
 *   5. Peak RSS for an index of N documents, to size Lambda memory.
 */
export interface MossSdkBindings {
  /**
   * Build or hydrate an in-memory index. Called once during `load()`.
   * Must not be called on the hot path.
   */
  readonly createIndex: (source: IndexSource) => Promise<MossSdkIndex>;
}

export interface MossSdkIndex {
  /** Hot path. Must be pure CPU/memory. */
  readonly search: (
    query: string,
    topK: number,
    filter?: Readonly<Record<string, string>>,
  ) => Promise<readonly MossSdkHit[]>;
  readonly size: () => number;
  readonly close?: () => Promise<void>;
}

export interface MossSdkHit {
  readonly id: string;
  readonly text: string;
  readonly score: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

export class SdkRetriever implements MossRetriever {
  private index: MossSdkIndex | null = null;
  private state: RetrieverState = 'unloaded';
  private indexVersion: string | null = null;
  private loadMs: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly bindings: MossSdkBindings) {}

  async load(source: IndexSource): Promise<void> {
    const started = performance.now();
    this.state = 'loading';
    try {
      this.index = await this.bindings.createIndex(source);
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
    if (this.state !== 'ready' || this.index === null || this.indexVersion === null) {
      throw new RetrieverNotReadyError(this.state);
    }
    const started = performance.now();
    const topK = options.topK ?? 3;
    const raw = await this.index.search(query, topK, options.filter);
    const minScore = options.minScore ?? 0;

    return {
      hits: raw.filter((hit) => hit.score > minScore),
      elapsedMs: performance.now() - started,
      indexVersion: this.indexVersion,
    };
  }

  stats(): RetrieverStats {
    return {
      state: this.state,
      indexVersion: this.indexVersion,
      documentCount: this.index?.size() ?? 0,
      loadMs: this.loadMs,
      lastError: this.lastError,
    };
  }
}
