/**
 * The Moss retrieval seam.
 *
 * WHY THIS INTERFACE EXISTS
 * -------------------------
 * Moss's value proposition is sub-10ms retrieval with *zero network hops* -- the
 * index lives in the same process as the agent. If we model Moss as a remote
 * service the integration calls over the wire, we add 30-80ms of round trip to
 * something that advertises single-digit milliseconds, and the entire reason to
 * use Moss evaporates while every test still passes.
 *
 * So this interface deliberately models a LOCAL, IN-PROCESS index with an
 * explicit load phase, not a client for a remote API:
 *
 *   - `load()`   runs once at Lambda init (outside the handler) or at browser
 *                bootstrap. It is allowed to be slow.
 *   - `retrieve()` runs on the hot path. It must not do I/O.
 *
 * Any implementation that performs network I/O inside `retrieve()` is a bug,
 * not a tradeoff.
 */

export interface MossDocument {
  readonly id: string;
  readonly text: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface MossHit {
  readonly id: string;
  readonly text: string;
  /** Higher is more similar. Normalised to 0..1 by the adapter, not by callers. */
  readonly score: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface RetrieveOptions {
  /** Max hits to return. */
  readonly topK?: number;
  /** Drop hits below this score. Prevents confidently reading out garbage to a caller. */
  readonly minScore?: number;
  /** Restrict to documents whose metadata matches all these pairs. */
  readonly filter?: Readonly<Record<string, string>>;
}

export interface RetrieveResult {
  readonly hits: readonly MossHit[];
  /** Measured in-process retrieval time. The number that justifies this project. */
  readonly elapsedMs: number;
  /** Index version that served this query, for attributing a bad answer to a bad index. */
  readonly indexVersion: string;
  /**
   * Optional split of where `elapsedMs` went.
   *
   * This matters more than it looks. Any embedding-based retriever must turn the
   * query into a vector BEFORE it can search, and that embedding happens on the
   * hot path. A headline "sub-10ms retrieval" number that excludes it is not the
   * latency a caller experiences. Arms that can separate the two report it here
   * so the comparison is about the same thing.
   */
  readonly breakdown?: { readonly embedMs: number; readonly searchMs: number };
}

export type RetrieverState = 'unloaded' | 'loading' | 'ready' | 'failed';

export interface RetrieverStats {
  readonly state: RetrieverState;
  readonly indexVersion: string | null;
  readonly documentCount: number;
  /** How long `load()` took. Directly predicts cold-start pain. */
  readonly loadMs: number | null;
  readonly lastError: string | null;
}

/**
 * An index the retriever can be hydrated from. Kept as a discriminated union so
 * the Lambda (bytes pulled from S3 at init) and the browser (bytes fetched over
 * HTTP) share one adapter.
 */
export type IndexSource =
  | { readonly kind: 'bytes'; readonly version: string; readonly bytes: Uint8Array }
  | { readonly kind: 'documents'; readonly version: string; readonly documents: readonly MossDocument[] };

export interface MossRetriever {
  load(source: IndexSource): Promise<void>;
  /** Hot path. Must be pure CPU/memory -- no network, no disk. */
  retrieve(query: string, options?: RetrieveOptions): Promise<RetrieveResult>;
  stats(): RetrieverStats;
}

/** Thrown when `retrieve()` is called before a successful `load()`. */
export class RetrieverNotReadyError extends Error {
  constructor(state: RetrieverState) {
    super(`Moss retriever is not ready (state: ${state})`);
    this.name = 'RetrieverNotReadyError';
  }
}
