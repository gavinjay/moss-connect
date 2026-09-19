import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { IndexSource } from './retriever';

/**
 * Index distribution.
 *
 * ONE source of truth for "which index is live": the manifest object in S3.
 * Consumers (the Lambda, the agent's browser) resolve the manifest, then fetch
 * the exact versioned artifact it names. Nobody hardcodes a version, and nobody
 * guesses "latest" -- a consumer silently serving a stale index is precisely
 * the failure that looks like a model regression rather than a deploy bug.
 */
export interface IndexManifest {
  /** Opaque version id -- also the S3 key suffix of the artifact. */
  readonly version: string;
  readonly key: string;
  readonly documentCount: number;
  readonly builtAt: string;
  readonly sha256: string;
}

export function parseManifest(json: string): IndexManifest {
  const raw = JSON.parse(json) as Partial<IndexManifest>;
  for (const field of ['version', 'key', 'documentCount', 'builtAt', 'sha256'] as const) {
    if (raw[field] === undefined || raw[field] === null || raw[field] === '') {
      throw new Error(`index manifest is missing required field "${field}"`);
    }
  }
  return raw as IndexManifest;
}

let s3: S3Client | null = null;
function client(): S3Client {
  s3 ??= new S3Client({});
  return s3;
}

async function getBytes(bucket: string, key: string): Promise<Uint8Array> {
  const res = await client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`s3://${bucket}/${key} returned an empty body`);
  return new Uint8Array(await res.Body.transformToByteArray());
}

async function getText(bucket: string, key: string): Promise<string> {
  const res = await client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`s3://${bucket}/${key} returned an empty body`);
  return res.Body.transformToString();
}

/**
 * Resolves the manifest and fetches the artifact it names.
 *
 * Runs during Lambda INIT, never on the hot path. Slow is acceptable here;
 * slow inside `retrieve()` is not.
 */
export async function loadIndexFromS3(bucket: string, manifestKey: string): Promise<IndexSource> {
  const manifest = parseManifest(await getText(bucket, manifestKey));
  const bytes = await getBytes(bucket, manifest.key);
  return { kind: 'bytes', version: manifest.version, bytes };
}
