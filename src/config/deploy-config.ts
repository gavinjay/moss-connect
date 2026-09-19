import { assertConnectRegion, type ConnectRegion } from './regions';

/**
 * Deploy inputs come from cdk.json context and nowhere else.
 *
 * Not from `-c` flags, not from shell env vars. A value that can be forgotten
 * will be forgotten, and the resulting failure is silent: the stack deploys,
 * then quietly does the wrong thing in production. Every required field here
 * throws at synth time if absent.
 */
export interface VoiceRetrievalConfig {
  /** Wall-clock budget for the whole contact-flow round trip, in ms. */
  readonly latencyBudgetMs: number;
  /** Warm instances. Moss index load at cold start is the dominant risk; 0 means accepting it. */
  readonly provisionedConcurrency: number;
  readonly memoryMb: number;
  /** Must stay below Amazon Connect's hard 8s contact-flow invocation ceiling. */
  readonly timeoutSeconds: number;
}

export interface IndexStoreConfig {
  readonly retainOnDelete: boolean;
  readonly manifestKey: string;
}

export interface TagConfig {
  readonly project: string;
  readonly owner: string;
  readonly awsApnId: string;
}

export interface MossConnectConfig {
  readonly region: ConnectRegion;
  readonly connectInstanceArn: string;
  readonly contactLensRealtimeEnabled: boolean;
  readonly voiceRetrieval: VoiceRetrievalConfig;
  readonly indexStore: IndexStoreConfig;
  readonly tags: TagConfig;
}

/** Minimal shape of the construct node we read context from. */
export interface ContextReader {
  tryGetContext(key: string): unknown;
}

function required<T>(value: T | undefined | null | '', path: string): T {
  if (value === undefined || value === null || value === '') {
    throw new Error(
      `Missing required cdk.json context: mossConnect.${path}\n` +
        'Add it to cdk.json under "context" -> "mossConnect". Do not pass it with -c: ' +
        'a value that only exists on one machine is a value the next deploy drops silently.',
    );
  }
  return value;
}

export function loadConfig(scope: ContextReader): MossConnectConfig {
  const raw = scope.tryGetContext('mossConnect') as Record<string, any> | undefined;
  if (!raw) {
    throw new Error('cdk.json is missing the "mossConnect" context block entirely.');
  }

  const voice = (raw.voiceRetrieval ?? {}) as Record<string, any>;
  const store = (raw.indexStore ?? {}) as Record<string, any>;
  const tags = (raw.tags ?? {}) as Record<string, any>;

  const timeoutSeconds = required<number>(voice.timeoutSeconds, 'voiceRetrieval.timeoutSeconds');
  if (timeoutSeconds >= 8) {
    throw new Error(
      `voiceRetrieval.timeoutSeconds is ${timeoutSeconds}; Amazon Connect abandons a ` +
        'contact-flow Lambda invocation at 8 seconds. Set it below 8 so the handler ' +
        'returns a graceful fallback instead of Connect timing out on us.',
    );
  }

  return {
    region: assertConnectRegion(required<string>(raw.region, 'region')),
    connectInstanceArn: required<string>(raw.connectInstanceArn, 'connectInstanceArn'),
    contactLensRealtimeEnabled: raw.contactLensRealtimeEnabled !== false,
    voiceRetrieval: {
      latencyBudgetMs: required<number>(voice.latencyBudgetMs, 'voiceRetrieval.latencyBudgetMs'),
      provisionedConcurrency: voice.provisionedConcurrency ?? 0,
      memoryMb: required<number>(voice.memoryMb, 'voiceRetrieval.memoryMb'),
      timeoutSeconds,
    },
    indexStore: {
      retainOnDelete: store.retainOnDelete !== false,
      manifestKey: required<string>(store.manifestKey, 'indexStore.manifestKey'),
    },
    tags: {
      project: required<string>(tags.project, 'tags.project'),
      owner: required<string>(tags.owner, 'tags.owner'),
      awsApnId: required<string>(tags.awsApnId, 'tags.awsApnId'),
    },
  };
}
