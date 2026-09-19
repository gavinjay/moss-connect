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
 * A real, deterministic, in-process retriever used for local development, tests
 * and CI -- everywhere the Moss SDK is not wired up yet.
 *
 * It scores with IDF-weighted token overlap. That is LEXICAL, not semantic: it
 * will miss paraphrases that Moss would catch. It is not a quality stand-in for
 * Moss and must never be used to evaluate answer quality or to benchmark
 * latency claims. What it is good for is exercising the shape of the pipeline --
 * load phase, hot path, scoring, thresholds, filters, degradation paths -- so
 * the Connect side is fully built and tested before the SDK lands behind it.
 */
export class StubRetriever implements MossRetriever {
  private documents: readonly MossDocument[] = [];
  private tokenised = new Map<string, Set<string>>();
  private idf = new Map<string, number>();
  private state: RetrieverState = 'unloaded';
  private indexVersion: string | null = null;
  private loadMs: number | null = null;
  private lastError: string | null = null;

  async load(source: IndexSource): Promise<void> {
    const started = performance.now();
    this.state = 'loading';
    try {
      const documents =
        source.kind === 'documents' ? source.documents : decodeDocuments(source.bytes);

      this.documents = documents;
      this.tokenised = new Map(documents.map((d) => [d.id, new Set(tokenise(d.text))]));
      this.idf = buildIdf(this.tokenised, documents.length);
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
    const queryTokens = new Set(tokenise(query));

    const scored: { doc: MossDocument; score: number }[] = [];
    for (const doc of this.documents) {
      if (options.filter && !matchesFilter(doc, options.filter)) continue;
      const docTokens = this.tokenised.get(doc.id);
      if (!docTokens) continue;

      let overlap = 0;
      let queryMass = 0;
      for (const token of queryTokens) {
        const weight = this.idf.get(token) ?? 0;
        queryMass += weight;
        if (docTokens.has(token)) overlap += weight;
      }
      // Normalise to 0..1 so callers can apply a single meaningful threshold.
      const score = queryMass === 0 ? 0 : overlap / queryMass;
      if (score > minScore) scored.push({ doc, score });
    }

    scored.sort((a, b) => (b.score - a.score) || a.doc.id.localeCompare(b.doc.id));

    return {
      hits: scored.slice(0, topK).map(({ doc, score }) => ({
        id: doc.id,
        text: doc.text,
        score,
        ...(doc.metadata ? { metadata: doc.metadata } : {}),
      })),
      elapsedMs: performance.now() - started,
      indexVersion: this.indexVersion,
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
}

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function buildIdf(tokenised: Map<string, Set<string>>, docCount: number): Map<string, number> {
  const documentFrequency = new Map<string, number>();
  for (const tokens of tokenised.values()) {
    for (const token of tokens) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [token, freq] of documentFrequency) {
    idf.set(token, Math.log(1 + docCount / freq));
  }
  return idf;
}

function matchesFilter(doc: MossDocument, filter: Readonly<Record<string, string>>): boolean {
  return Object.entries(filter).every(([key, value]) => doc.metadata?.[key] === value);
}

/** The stub's on-disk format is plain JSON. The real Moss index format is opaque binary. */
function decodeDocuments(bytes: Uint8Array): readonly MossDocument[] {
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(parsed)) throw new Error('stub index must decode to a JSON array of documents');
  return parsed as MossDocument[];
}
