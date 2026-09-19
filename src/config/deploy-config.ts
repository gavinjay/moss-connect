import { assertConnectRegion, parseConnectInstanceArn, type ConnectRegion } from './regions';

/**
 * Deploy inputs come from cdk.json context and nowhere else.
 *
 * Not from `-c` flags, not from shell env vars. A value that can be forgotten
 * will be forgotten, and the resulting failure is silent: the stack deploys,
 * then quietly does the wrong thing. Every required field here throws at synth
 * time if absent.
 */

/** Arms that can be DEPLOYED as Lambdas. */
export const RETRIEVAL_ARMS = ['lexical', 'moss', 'bedrock-kb'] as const;
export type RetrievalArmName = (typeof RETRIEVAL_ARMS)[number];

/**
 * Arms that only run in the local harness.
 *
 * `local-embed` carries a ~90MB ONNX model. Putting that in a Lambda is a real
 * option but a separate conversation (layer vs EFS, cold-start cost), so it is
 * deliberately not deployable yet -- and the CDK arm list stays honest about
 * what it can actually ship.
 */
export const BENCH_ONLY_ARMS = ['local-embed'] as const;
export type BenchOnlyArmName = (typeof BENCH_ONLY_ARMS)[number];
export type BenchArmName = RetrievalArmName | BenchOnlyArmName;

export function isRetrievalArm(value: string): value is RetrievalArmName {
  return (RETRIEVAL_ARMS as readonly string[]).includes(value);
}

export function isBenchArm(value: string): value is BenchArmName {
  return isRetrievalArm(value) || (BENCH_ONLY_ARMS as readonly string[]).includes(value);
}

export interface PhoneNumberConfig {
  readonly enabled: boolean;
  /** ISO country code, e.g. "US". */
  readonly countryCode: string;
  /** DID is cheaper per minute; TOLL_FREE is cheaper to claim. */
  readonly type: 'DID' | 'TOLL_FREE';
  readonly description: string;
}

export interface ConnectFoundationConfig {
  /**
   * Alias for a newly created instance. **Globally unique across all of AWS**,
   * not just your account -- which is why it has no default. A taken alias fails
   * the deploy several minutes in.
   */
  readonly instanceAlias: string;
  /** Set this to adopt an instance you already have; leave blank to create one. */
  readonly existingInstanceArn: string | null;
  readonly inboundCalls: boolean;
  readonly outboundCalls: boolean;
  readonly phoneNumber: PhoneNumberConfig;
}

export interface VoiceRetrievalConfig {
  readonly latencyBudgetMs: number;
  readonly provisionedConcurrency: number;
  readonly memoryMb: number;
  /** Must stay below Amazon Connect's hard 8s contact-flow invocation ceiling. */
  readonly timeoutSeconds: number;
}

export interface IndexStoreConfig {
  readonly retainOnDelete: boolean;
  readonly manifestKey: string;
}

export interface BenchmarkConfig {
  /** Which arms to deploy. One Lambda per arm, so each has its own cold-start profile. */
  readonly arms: readonly RetrievalArmName[];
  /** Required only when the 'bedrock-kb' arm is deployed. */
  readonly bedrockKnowledgeBaseId: string | null;
}

export interface TagConfig {
  readonly project: string;
  readonly owner: string;
  readonly awsApnId: string;
}

export interface MossConnectConfig {
  readonly region: ConnectRegion;
  /**
   * The AWS account this deployment belongs to, derived from the Connect
   * instance ARN when one is given.
   *
   * This is NOT read from CDK_DEFAULT_ACCOUNT. An earlier version was, and a
   * `cdk diff` duly synthesized both stacks into whichever account the shell's
   * credentials happened to be for, while every Connect reference pointed at a
   * different one. Nothing failed at synth; the cross-account wiring was only
   * visible by reading the stack header.
   */
  readonly account: string | null;
  readonly connect: ConnectFoundationConfig;
  readonly voiceRetrieval: VoiceRetrievalConfig;
  readonly indexStore: IndexStoreConfig;
  readonly benchmark: BenchmarkConfig;
  readonly tags: TagConfig;
}

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

function blankToNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function loadConfig(scope: ContextReader): MossConnectConfig {
  const raw = scope.tryGetContext('mossConnect') as Record<string, any> | undefined;
  if (!raw) throw new Error('cdk.json is missing the "mossConnect" context block entirely.');

  const connect = (raw.connect ?? {}) as Record<string, any>;
  const phone = (connect.phoneNumber ?? {}) as Record<string, any>;
  const voice = (raw.voiceRetrieval ?? {}) as Record<string, any>;
  const store = (raw.indexStore ?? {}) as Record<string, any>;
  const bench = (raw.benchmark ?? {}) as Record<string, any>;
  const tags = (raw.tags ?? {}) as Record<string, any>;

  const timeoutSeconds = required<number>(voice.timeoutSeconds, 'voiceRetrieval.timeoutSeconds');
  if (timeoutSeconds >= 8) {
    throw new Error(
      `voiceRetrieval.timeoutSeconds is ${timeoutSeconds}; Amazon Connect abandons a ` +
        'contact-flow Lambda invocation at 8 seconds. Set it below 8 so the handler ' +
        'returns a graceful fallback instead of Connect timing out on us.',
    );
  }

  const existingInstanceArn = blankToNull(connect.existingInstanceArn);
  // Exactly one of "adopt an instance" / "create an instance" must be decided.
  // Neither, and we would silently build a stack attached to nothing.
  const instanceAlias = existingInstanceArn
    ? (blankToNull(connect.instanceAlias) ?? '')
    : required<string>(connect.instanceAlias, 'connect.instanceAlias');

  const arms = parseArms(bench.arms);
  const bedrockKnowledgeBaseId = blankToNull(bench.bedrockKnowledgeBaseId);
  if (arms.includes('bedrock-kb') && bedrockKnowledgeBaseId === null) {
    throw new Error(
      'The "bedrock-kb" benchmark arm is enabled but mossConnect.benchmark.' +
        'bedrockKnowledgeBaseId is blank.\n' +
        'A Bedrock Knowledge Base is not created by this stack (its OpenSearch Serverless ' +
        'vector index is not a CloudFormation resource). Create the KB, then put its id here -- ' +
        'or remove "bedrock-kb" from benchmark.arms.',
    );
  }

  const phoneEnabled = phone.enabled !== false;

  const region = assertConnectRegion(required<string>(raw.region, 'region'));

  // When we adopt an instance, its ARN is authoritative for BOTH account and
  // region. Disagreement between the ARN and cdk.json is always a mistake.
  let account: string | null = blankToNull(raw.account);
  if (existingInstanceArn) {
    const parsed = parseConnectInstanceArn(existingInstanceArn);
    if (parsed.region !== region) {
      throw new Error(
        `mossConnect.region is "${region}" but connect.existingInstanceArn is in ` +
          `"${parsed.region}". A Connect instance cannot be adopted across regions -- ` +
          'fix whichever one is wrong.',
      );
    }
    if (account && account !== parsed.account) {
      throw new Error(
        `mossConnect.account is "${account}" but connect.existingInstanceArn belongs to ` +
          `account "${parsed.account}". These must agree.`,
      );
    }
    account = parsed.account;
  }

  return {
    region,
    account,
    connect: {
      instanceAlias,
      existingInstanceArn,
      inboundCalls: connect.inboundCalls !== false,
      outboundCalls: connect.outboundCalls === true,
      phoneNumber: {
        enabled: phoneEnabled,
        countryCode: phoneEnabled
          ? required<string>(phone.countryCode, 'connect.phoneNumber.countryCode')
          : 'US',
        type: parsePhoneType(phone.type, phoneEnabled),
        description: phone.description ?? 'moss-connect',
      },
    },
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
    benchmark: { arms, bedrockKnowledgeBaseId },
    tags: {
      project: required<string>(tags.project, 'tags.project'),
      owner: required<string>(tags.owner, 'tags.owner'),
      awsApnId: required<string>(tags.awsApnId, 'tags.awsApnId'),
    },
  };
}

function parseArms(value: unknown): readonly RetrievalArmName[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `Missing required cdk.json context: mossConnect.benchmark.arms\n` +
        `Expected a non-empty array of: ${RETRIEVAL_ARMS.join(', ')}`,
    );
  }
  const bad = value.filter((v) => typeof v !== 'string' || !isRetrievalArm(v));
  if (bad.length > 0) {
    throw new Error(
      `Unknown benchmark arm(s): ${bad.join(', ')}. Valid arms: ${RETRIEVAL_ARMS.join(', ')}`,
    );
  }
  return [...new Set(value as RetrievalArmName[])];
}

function parsePhoneType(value: unknown, enabled: boolean): 'DID' | 'TOLL_FREE' {
  if (!enabled) return 'DID';
  if (value !== 'DID' && value !== 'TOLL_FREE') {
    throw new Error(
      `mossConnect.connect.phoneNumber.type must be "DID" or "TOLL_FREE", got ${JSON.stringify(value)}`,
    );
  }
  return value;
}
