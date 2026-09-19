import { armFromEnv, armNeedsIndexLoad, retrieverFor } from '../moss/retriever-factory';
import { loadIndexFromS3 } from '../moss/index-loader';
import { RetrieverNotReadyError, type MossRetriever } from '../moss/retriever';
import { Metric, emit } from '../observability/metrics';
import {
  assertConnectResponse,
  flattenForConnect,
  truncateToBytes,
  type ConnectContactFlowEvent,
  type ConnectFlowResponse,
} from './connect-contract';

/**
 * Surface 1 of 3: self-service voice retrieval.
 *
 * Amazon Connect contact flow -> this Lambda -> retrieval -> answer.
 *
 * One deployment of this handler exists per benchmark arm (lexical / moss /
 * bedrock-kb), selected by MOSS_RETRIEVAL_ARM. Separate functions, not a runtime
 * switch, so each arm has an independent cold-start profile -- a shared warm
 * container would make the cold-start comparison meaningless.
 *
 * THE LOAD HAPPENS AT MODULE SCOPE, ON PURPOSE.
 * ---------------------------------------------
 * Everything below runs during Lambda INIT, before any invocation. With
 * provisioned concurrency AWS runs init ahead of traffic, so a warm instance
 * already holds the index and the handler does a pure memory lookup -- the only
 * way a sub-10ms retrieval claim survives contact with Lambda.
 *
 * The bedrock-kb arm skips the load entirely. That is not an oversight; zero init
 * cost is the managed baseline's real advantage and the benchmark must show it.
 */

const ARM = armFromEnv(process.env.MOSS_RETRIEVAL_ARM);
const BUCKET = process.env.MOSS_INDEX_BUCKET;
const MANIFEST_KEY = process.env.MOSS_INDEX_MANIFEST_KEY;
const LATENCY_BUDGET_MS = Number(process.env.MOSS_LATENCY_BUDGET_MS ?? '120');
const MIN_SCORE = Number(process.env.MOSS_MIN_SCORE ?? '0.25');

export const retriever: MossRetriever = retrieverFor(ARM, {
  bedrockKnowledgeBaseId: process.env.MOSS_BEDROCK_KB_ID,
  region: process.env.AWS_REGION,
  // mossBindings is supplied here once the real SDK is wired. Until then the
  // 'moss' arm throws at init rather than quietly serving lexical results.
});

/** Init-phase warmup. The handler awaits it; it does not trigger it. */
const warmup: Promise<void> = (async () => {
  if (!armNeedsIndexLoad(ARM)) {
    await retriever.load({ kind: 'documents', version: `${ARM}:managed`, documents: [] });
    return;
  }
  if (!BUCKET || !MANIFEST_KEY) {
    throw new Error('MOSS_INDEX_BUCKET and MOSS_INDEX_MANIFEST_KEY must be set');
  }
  await retriever.load(await loadIndexFromS3(BUCKET, MANIFEST_KEY));
  const loadMs = retriever.stats().loadMs;
  if (loadMs !== null) {
    await emit(Metric.IndexLoadMs, { Surface: 'VoiceRetrieval', RetrievalArm: ARM }, loadMs, 'Milliseconds');
  }
})().catch(async (err: unknown) => {
  await emit(Metric.IndexLoadFailed, { Surface: 'VoiceRetrieval', RetrievalArm: ARM });
  console.error(
    `index load failed at init arm=${ARM} ` +
      `error=${err instanceof Error ? err.message : String(err)}`,
  );
  throw err;
});

export async function handler(event: ConnectContactFlowEvent): Promise<ConnectFlowResponse> {
  const started = performance.now();
  const params = event.Details?.Parameters ?? {};
  const query = params.query ?? params.transcript ?? '';
  const contactId = event.Details?.ContactData?.ContactId ?? 'unknown';

  if (!query.trim()) {
    return assertConnectResponse({ resolved: false, reason: 'empty_query', escalate: true, arm: ARM });
  }

  try {
    await warmup;
  } catch {
    await emit(Metric.RetrieverNotReady, { Surface: 'VoiceRetrieval', RetrievalArm: ARM });
    await emit(Metric.FallbackToAgent, { Surface: 'VoiceRetrieval', RetrievalArm: ARM });
    return assertConnectResponse({
      resolved: false,
      reason: 'index_unavailable',
      escalate: true,
      arm: ARM,
    });
  }

  try {
    const filter = params.locale ? { locale: params.locale } : undefined;
    const result = await retriever.retrieve(query, {
      topK: 3,
      minScore: MIN_SCORE,
      ...(filter ? { filter } : {}),
    });

    const totalMs = performance.now() - started;
    const dims = {
      Surface: 'VoiceRetrieval',
      RetrievalArm: ARM,
      IndexVersion: result.indexVersion,
    } as const;

    // Always record the latency, hit or miss -- a benchmark needs the
    // distribution, not just the successes.
    await emit(Metric.RetrievalLatency, dims, result.elapsedMs, 'Milliseconds');

    if (result.hits.length === 0) {
      await emit(Metric.RetrievalNoHit, dims);
      await emit(Metric.FallbackToAgent, dims);
      return assertConnectResponse({
        resolved: false,
        reason: 'no_confident_match',
        escalate: true,
        arm: ARM,
        retrieval_ms: Math.round(result.elapsedMs),
        index_version: result.indexVersion,
      });
    }

    if (totalMs > LATENCY_BUDGET_MS) {
      await emit(Metric.RetrievalSlow, dims, totalMs, 'Milliseconds');
      console.warn(
        `retrieval over budget arm=${ARM} contact=${contactId} total_ms=${totalMs.toFixed(1)} ` +
          `budget_ms=${LATENCY_BUDGET_MS} retrieval_ms=${result.elapsedMs.toFixed(1)}`,
      );
    }
    await emit(Metric.RetrievalSuccess, dims);

    const best = result.hits[0];
    return assertConnectResponse({
      resolved: true,
      escalate: false,
      arm: ARM,
      // Polly reads this one. Well under Connect's 32KB cap.
      answer: truncateToBytes(best.text, 4_000),
      answer_id: best.id,
      answer_score: Number(best.score.toFixed(4)),
      index_version: result.indexVersion,
      retrieval_ms: Math.round(result.elapsedMs),
      total_ms: Math.round(totalMs),
      // Alternates, flattened -- Connect rejects the nested array outright.
      ...flattenForConnect(
        'alt',
        result.hits.slice(1).map((h) => ({ id: h.id, score: Number(h.score.toFixed(4)) })),
        2,
      ),
    });
  } catch (err) {
    const notReady = err instanceof RetrieverNotReadyError;
    await emit(notReady ? Metric.RetrieverNotReady : Metric.IndexLoadFailed, {
      Surface: 'VoiceRetrieval',
      RetrievalArm: ARM,
    });
    await emit(Metric.FallbackToAgent, { Surface: 'VoiceRetrieval', RetrievalArm: ARM });
    console.error(
      `voice retrieval failed arm=${ARM} contact=${contactId} ` +
        `error=${err instanceof Error ? err.message : String(err)}`,
    );
    // Never throw at Connect: an exception routes the contact down the error
    // branch with no context. A clean escalate flag lets the flow route properly.
    return assertConnectResponse({
      resolved: false,
      reason: 'retrieval_error',
      escalate: true,
      arm: ARM,
    });
  }
}
