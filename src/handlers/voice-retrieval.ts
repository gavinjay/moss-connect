import { loadIndexFromS3 } from '../moss/index-loader';
import { StubRetriever } from '../moss/stub-retriever';
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
 * Amazon Connect contact flow -> this Lambda -> in-process Moss index -> answer.
 *
 * THE LOAD HAPPENS AT MODULE SCOPE, ON PURPOSE.
 * ---------------------------------------------
 * Everything below the import block runs during the Lambda INIT phase, before
 * any handler invocation. With provisioned concurrency, AWS runs init ahead of
 * traffic, so a warm instance already holds the index in memory and the handler
 * does a pure memory lookup -- which is the only way a sub-10ms retrieval claim
 * survives contact with Lambda.
 *
 * Move this load inside the handler and the integration still works, still
 * passes every test, and is pointless.
 */

const BUCKET = process.env.MOSS_INDEX_BUCKET;
const MANIFEST_KEY = process.env.MOSS_INDEX_MANIFEST_KEY;
const LATENCY_BUDGET_MS = Number(process.env.MOSS_LATENCY_BUDGET_MS ?? '120');
const MIN_SCORE = Number(process.env.MOSS_MIN_SCORE ?? '0.25');

/** Swapped for SdkRetriever once the Moss SDK binding lands. One line, one place. */
export const retriever: MossRetriever = new StubRetriever();

/** Init-phase warmup. The handler awaits it; it does not trigger it. */
const warmup: Promise<void> = (async () => {
  if (!BUCKET || !MANIFEST_KEY) {
    throw new Error('MOSS_INDEX_BUCKET and MOSS_INDEX_MANIFEST_KEY must be set');
  }
  const source = await loadIndexFromS3(BUCKET, MANIFEST_KEY);
  await retriever.load(source);
})().catch(async (err: unknown) => {
  // Do not let init rejection become an unhandled promise rejection; record it
  // and let the handler degrade deliberately on the first call.
  await emit(Metric.IndexLoadFailed, { Surface: 'VoiceRetrieval' });
  console.error(
    `moss index load failed at init error=${err instanceof Error ? err.message : String(err)}`,
  );
  throw err;
});

export async function handler(event: ConnectContactFlowEvent): Promise<ConnectFlowResponse> {
  const started = performance.now();
  const params = event.Details?.Parameters ?? {};
  const query = params.query ?? params.transcript ?? '';
  const contactId = event.Details?.ContactData?.ContactId ?? 'unknown';

  if (!query.trim()) {
    return assertConnectResponse({ resolved: false, reason: 'empty_query', escalate: true });
  }

  try {
    await warmup;
  } catch {
    await emit(Metric.RetrieverNotReady, { Surface: 'VoiceRetrieval' });
    await emit(Metric.FallbackToAgent, { Surface: 'VoiceRetrieval' });
    return assertConnectResponse({ resolved: false, reason: 'index_unavailable', escalate: true });
  }

  try {
    const filter = params.locale ? { locale: params.locale } : undefined;
    const result = await retriever.retrieve(query, {
      topK: 3,
      minScore: MIN_SCORE,
      ...(filter ? { filter } : {}),
    });

    const totalMs = performance.now() - started;
    const dims = { Surface: 'VoiceRetrieval', IndexVersion: result.indexVersion } as const;

    if (result.hits.length === 0) {
      await emit(Metric.RetrievalNoHit, dims);
      await emit(Metric.FallbackToAgent, dims);
      return assertConnectResponse({
        resolved: false,
        reason: 'no_confident_match',
        escalate: true,
        retrieval_ms: Math.round(result.elapsedMs),
        index_version: result.indexVersion,
      });
    }

    if (totalMs > LATENCY_BUDGET_MS) {
      // Still answer -- but never let a blown budget go unrecorded.
      await emit(Metric.RetrievalSlow, dims, totalMs, 'Milliseconds');
      console.warn(
        `retrieval over budget contact=${contactId} total_ms=${totalMs.toFixed(1)} ` +
          `budget_ms=${LATENCY_BUDGET_MS} retrieval_ms=${result.elapsedMs.toFixed(1)}`,
      );
    }
    await emit(Metric.RetrievalSuccess, dims);

    const best = result.hits[0];
    return assertConnectResponse({
      resolved: true,
      escalate: false,
      // Polly reads this one. Budget headroom well under Connect's 32KB cap.
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
    });
    await emit(Metric.FallbackToAgent, { Surface: 'VoiceRetrieval' });
    console.error(
      `voice retrieval failed contact=${contactId} ` +
        `error=${err instanceof Error ? err.message : String(err)}`,
    );
    // Never throw at Connect: an exception sends the contact down the error
    // branch with no context. A clean escalate flag lets the flow route properly.
    return assertConnectResponse({ resolved: false, reason: 'retrieval_error', escalate: true });
  }
}
