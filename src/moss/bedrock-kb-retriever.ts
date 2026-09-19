import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import {
  type IndexSource,
  type MossRetriever,
  type RetrieveOptions,
  type RetrieveResult,
  type RetrieverState,
  type RetrieverStats,
} from './retriever';

/**
 * BENCHMARK BASELINE ARM -- not a production path.
 *
 * This is Amazon Bedrock Knowledge Bases: a managed vector store behind a
 * network call, and what an Amazon Connect customer would actually deploy today
 * if Moss did not exist. It is the arm Moss has to beat.
 *
 * IT DELIBERATELY VIOLATES THE PROJECT'S CORE INVARIANT. `retrieve()` performs
 * network I/O, which everywhere else in this codebase is a bug. Here it is the
 * measurement: the network hop IS the thing under test. Do not "fix" this by
 * caching, and do not copy this pattern into the Moss or lexical arms.
 *
 * Fair-comparison notes, because a rigged baseline proves nothing:
 *   - Same corpus, same query set, same Lambda memory, same region as the other
 *     arms. A KB in another region would be measuring geography.
 *   - The client is constructed at module scope so connection setup and SDK
 *     init are NOT counted against per-query latency. Charging the baseline for
 *     cold TLS on every call would flatter Moss dishonestly.
 *   - `load()` is a no-op, which is the baseline's genuine advantage: zero init
 *     cost, no cold-start index load. Report that honestly -- it is where Moss
 *     is most likely to lose.
 */
export class BedrockKbRetriever implements MossRetriever {
  private state: RetrieverState = 'unloaded';
  private lastError: string | null = null;
  private readonly client: BedrockAgentRuntimeClient;

  constructor(
    private readonly knowledgeBaseId: string,
    region?: string,
  ) {
    this.client = new BedrockAgentRuntimeClient(region ? { region } : {});
  }

  /**
   * No-op. A managed KB needs no local hydration -- that is exactly the
   * tradeoff being measured: no init cost, but a network hop per query.
   */
  async load(_source?: IndexSource): Promise<void> {
    this.state = 'ready';
  }

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<RetrieveResult> {
    const started = performance.now();
    const topK = options.topK ?? 3;
    const minScore = options.minScore ?? 0;

    try {
      const res = await this.client.send(
        new RetrieveCommand({
          knowledgeBaseId: this.knowledgeBaseId,
          retrievalQuery: { text: query },
          retrievalConfiguration: {
            vectorSearchConfiguration: { numberOfResults: topK },
          },
        }),
      );
      this.state = 'ready';
      this.lastError = null;

      const hits = (res.retrievalResults ?? [])
        .map((r, i) => ({
          // Bedrock KB returns no stable document id, so fall back to the
          // source location. Recall scoring needs a comparable id across arms --
          // see docs/BENCHMARK.md on normalising this before scoring quality.
          id: r.location?.s3Location?.uri ?? `bedrock-kb:${i}`,
          text: r.content?.text ?? '',
          score: r.score ?? 0,
          ...(r.metadata
            ? { metadata: Object.fromEntries(Object.entries(r.metadata).map(([k, v]) => [k, String(v)])) }
            : {}),
        }))
        .filter((h) => h.text !== '' && h.score > minScore);

      return {
        hits,
        elapsedMs: performance.now() - started,
        indexVersion: `bedrock-kb:${this.knowledgeBaseId}`,
      };
    } catch (err) {
      this.state = 'failed';
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  stats(): RetrieverStats {
    return {
      state: this.state,
      indexVersion: `bedrock-kb:${this.knowledgeBaseId}`,
      documentCount: -1, // Not knowable from the client side.
      loadMs: 0, // Genuinely zero. This is the baseline's advantage.
      lastError: this.lastError,
    };
  }
}
