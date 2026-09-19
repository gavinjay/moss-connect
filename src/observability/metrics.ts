import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

export const NAMESPACE = 'MossConnect';

/**
 * Emit a metric EVERY time we degrade.
 *
 * A caught error that only writes a WARN line is invisible: the contact centre
 * keeps answering calls, just worse. These are the degradation paths that must
 * never be silent -- each one means a caller got a worse answer than the
 * architecture promises.
 */
export const Metric = {
  /** Retrieval exceeded the latency budget. The core product claim failing. */
  RetrievalSlow: 'Retrieval.Slow',
  /** Retriever was not loaded when a call arrived (cold start lost the race). */
  RetrieverNotReady: 'Retrieval.NotReady',
  /** Index loaded, but nothing scored above threshold -- we had no answer. */
  RetrievalNoHit: 'Retrieval.NoHit',
  /** Index load failed outright at init. */
  IndexLoadFailed: 'Index.LoadFailed',
  /** Serving an index older than the published manifest. */
  IndexStale: 'Index.Stale',
  /** A successful, in-budget retrieval. Denominator for the rate maths. */
  RetrievalSuccess: 'Retrieval.Success',
  /** Observed end-to-end handler latency. The headline benchmark number. */
  RetrievalLatency: 'Retrieval.LatencyMs',
  /** Index hydration time at init. Where an in-process arm pays for its speed. */
  IndexLoadMs: 'Index.LoadMs',
  /** Handler fell back to the escalation path instead of answering. */
  FallbackToAgent: 'Retrieval.FallbackToAgent',
} as const;

export type MetricName = (typeof Metric)[keyof typeof Metric];

export interface MetricDimensions {
  readonly Surface: 'VoiceRetrieval' | 'AgentAssist' | 'PostCall';
  /**
   * Which retrieval implementation served this. Without it the three benchmark
   * arms pile into one undifferentiated metric and the comparison is unreadable.
   */
  readonly RetrievalArm?: string;
  readonly IndexVersion?: string;
}

let client: CloudWatchClient | null = null;
function cw(): CloudWatchClient {
  client ??= new CloudWatchClient({});
  return client;
}

/**
 * Fire-and-forget metric emission. Never throws: a metrics failure must not
 * take down a live call. It does log, so a silently-failing emitter is findable.
 */
export async function emit(
  name: MetricName,
  dimensions: MetricDimensions,
  value = 1,
  unit: 'Count' | 'Milliseconds' = 'Count',
): Promise<void> {
  try {
    await cw().send(
      new PutMetricDataCommand({
        Namespace: NAMESPACE,
        MetricData: [
          {
            MetricName: name,
            Value: value,
            Unit: unit,
            Dimensions: Object.entries(dimensions)
              .filter(([, v]) => v !== undefined)
              .map(([Name, Value]) => ({ Name, Value: String(Value) })),
          },
        ],
      }),
    );
  } catch (err) {
    console.warn(
      `metric emit failed name=${name} surface=${dimensions.Surface} ` +
        `error=${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
