import type { KinesisStreamEvent } from 'aws-lambda';
import { loadIndexFromS3 } from '../moss/index-loader';
import { StubRetriever } from '../moss/stub-retriever';
import type { MossRetriever } from '../moss/retriever';
import { Metric, emit } from '../observability/metrics';
import { customerUtterances, parseContactLensEvent } from './contact-lens-contract';

/**
 * Surface 2 of 3: real-time agent assist.
 *
 * Contact Lens real-time -> Kinesis -> this Lambda -> Moss retrieval ->
 * suggestion surfaced to the human agent while the call is still live.
 *
 * DESIGN NOTE -- the better version of this runs in the browser.
 * -------------------------------------------------------------
 * Moss compiles to WASM and runs in a browser natively. The lowest-latency
 * agent-assist topology is therefore to hold the index in the AGENT'S BROWSER
 * and retrieve locally as the transcript arrives -- zero network hops, which is
 * the entire Moss pitch. This server-side path exists because it is simpler to
 * ship first and works with any agent workspace, but it pays a Kinesis hop plus
 * a publish hop to reach the agent, so it will never hit the numbers the
 * browser path can. See docs/ARCHITECTURE.md before extending this.
 */

const BUCKET = process.env.MOSS_INDEX_BUCKET;
const MANIFEST_KEY = process.env.MOSS_INDEX_MANIFEST_KEY;
const MIN_SCORE = Number(process.env.MOSS_MIN_SCORE ?? '0.3');
/** Ignore partial utterances shorter than this -- retrieving on "uh, I" is noise. */
const MIN_QUERY_CHARS = Number(process.env.MOSS_MIN_QUERY_CHARS ?? '12');

export const retriever: MossRetriever = new StubRetriever();

const warmup: Promise<void> = (async () => {
  if (!BUCKET || !MANIFEST_KEY) {
    throw new Error('MOSS_INDEX_BUCKET and MOSS_INDEX_MANIFEST_KEY must be set');
  }
  await retriever.load(await loadIndexFromS3(BUCKET, MANIFEST_KEY));
})().catch(async (err: unknown) => {
  await emit(Metric.IndexLoadFailed, { Surface: 'AgentAssist' });
  console.error(
    `agent-assist index load failed error=${err instanceof Error ? err.message : String(err)}`,
  );
  throw err;
});

export interface Suggestion {
  readonly contactId: string;
  readonly query: string;
  readonly answerId: string;
  readonly answer: string;
  readonly score: number;
  readonly indexVersion: string;
  readonly retrievalMs: number;
}

/**
 * Delivery seam. Where suggestions go depends on the agent workspace -- a
 * Connect 3p app, a custom CCP over Amazon Connect Streams, an AppSync
 * subscription. Left injectable rather than guessed at.
 */
export type SuggestionPublisher = (suggestion: Suggestion) => Promise<void>;

let publish: SuggestionPublisher = async (s) => {
  // Structured single-line log: Python-style `extra={}` context gets stripped by
  // default formatters, so the context is inlined into the message itself.
  console.log(
    `suggestion contact=${s.contactId} answer=${s.answerId} score=${s.score.toFixed(3)} ` +
      `index=${s.indexVersion} retrieval_ms=${s.retrievalMs.toFixed(1)}`,
  );
};

export function setSuggestionPublisher(next: SuggestionPublisher): void {
  publish = next;
}

export async function handler(event: KinesisStreamEvent): Promise<void> {
  try {
    await warmup;
  } catch {
    await emit(Metric.RetrieverNotReady, { Surface: 'AgentAssist' });
    // Returning cleanly drops this batch rather than wedging the shard on a
    // permanent failure. The metric plus alarm is how this stays visible.
    return;
  }

  for (const record of event.Records) {
    let utterances;
    try {
      const json = Buffer.from(record.kinesis.data, 'base64').toString('utf8');
      utterances = customerUtterances(parseContactLensEvent(json));
    } catch (err) {
      console.warn(
        `skipping malformed contact lens record seq=${record.kinesis.sequenceNumber} ` +
          `error=${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    for (const utterance of utterances) {
      if (utterance.text.length < MIN_QUERY_CHARS) continue;
      try {
        const result = await retriever.retrieve(utterance.text, {
          topK: 1,
          minScore: MIN_SCORE,
          ...(utterance.locale ? { filter: { locale: utterance.locale } } : {}),
        });
        const dims = { Surface: 'AgentAssist', IndexVersion: result.indexVersion } as const;

        const best = result.hits[0];
        if (!best) {
          await emit(Metric.RetrievalNoHit, dims);
          continue;
        }
        await emit(Metric.RetrievalSuccess, dims);
        await publish({
          contactId: utterance.contactId,
          query: utterance.text,
          answerId: best.id,
          answer: best.text,
          score: best.score,
          indexVersion: result.indexVersion,
          retrievalMs: result.elapsedMs,
        });
      } catch (err) {
        await emit(Metric.RetrieverNotReady, { Surface: 'AgentAssist' });
        console.error(
          `agent-assist retrieval failed contact=${utterance.contactId} ` +
            `error=${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
