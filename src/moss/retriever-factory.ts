import { isRetrievalArm, type RetrievalArmName } from '../config/deploy-config';
import { BedrockKbRetriever } from './bedrock-kb-retriever';
import type { MossRetriever } from './retriever';
import { SdkRetriever, type MossSdkBindings } from './sdk-retriever';
import { StubRetriever } from './stub-retriever';

/**
 * Builds the retriever for one benchmark arm.
 *
 * One Lambda is deployed per arm, each with MOSS_RETRIEVAL_ARM set, so every arm
 * has its own independent cold-start profile and its own metric stream. Selecting
 * the arm inside a single shared Lambda would let one arm's warm container serve
 * another's traffic and make the cold-start numbers meaningless.
 */
export interface ArmDependencies {
  /** Supplied once the real Moss SDK is wired. Absent until then. */
  readonly mossBindings?: MossSdkBindings;
  readonly bedrockKnowledgeBaseId?: string | undefined;
  readonly region?: string | undefined;
}

export class UnavailableArmError extends Error {
  constructor(arm: string, reason: string) {
    super(`retrieval arm "${arm}" is not available: ${reason}`);
    this.name = 'UnavailableArmError';
  }
}

export function retrieverFor(arm: RetrievalArmName, deps: ArmDependencies = {}): MossRetriever {
  switch (arm) {
    case 'lexical':
      return new StubRetriever();

    case 'moss':
      if (!deps.mossBindings) {
        // Fail loudly. Silently falling back to the lexical stub would produce a
        // benchmark that reports "Moss" numbers for a word-overlap scorer --
        // exactly the kind of quiet substitution that makes a result worthless.
        throw new UnavailableArmError(
          'moss',
          'no MossSdkBindings supplied. Wire the real SDK in src/moss/sdk-retriever.ts ' +
            'before deploying this arm; it will NOT silently fall back to the lexical stub.',
        );
      }
      return new SdkRetriever(deps.mossBindings);

    case 'bedrock-kb':
      if (!deps.bedrockKnowledgeBaseId) {
        throw new UnavailableArmError('bedrock-kb', 'MOSS_BEDROCK_KB_ID is not set');
      }
      return new BedrockKbRetriever(deps.bedrockKnowledgeBaseId, deps.region);
  }
}

/** Reads and validates the arm this Lambda was deployed as. */
export function armFromEnv(value: string | undefined): RetrievalArmName {
  if (!value) throw new Error('MOSS_RETRIEVAL_ARM is not set');
  if (!isRetrievalArm(value)) throw new Error(`MOSS_RETRIEVAL_ARM has unknown value "${value}"`);
  return value;
}

/** True when the arm hydrates a local index and therefore pays a cold-start cost. */
export function armNeedsIndexLoad(arm: RetrievalArmName): boolean {
  return arm !== 'bedrock-kb';
}
