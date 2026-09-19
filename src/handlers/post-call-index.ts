import { createHash } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { S3Event } from 'aws-lambda';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { IndexManifest } from '../moss/index-loader';
import type { MossDocument } from '../moss/retriever';
import { Metric, emit } from '../observability/metrics';

/**
 * Surface 3 of 3: post-call enrichment.
 *
 * Contact Lens post-call analysis lands in S3 -> this Lambda turns it into Moss
 * documents -> a new versioned index artifact plus an updated manifest.
 *
 * This is the only writer of the manifest. One writer, one source of truth for
 * "which index is live" -- a second writer racing this one is how two Lambdas
 * end up serving different answers to the same question.
 */

const INDEX_BUCKET = process.env.MOSS_INDEX_BUCKET;
const MANIFEST_KEY = process.env.MOSS_INDEX_MANIFEST_KEY ?? 'manifests/current.json';

let s3: S3Client | null = null;
function client(): S3Client {
  s3 ??= new S3Client({});
  return s3;
}

/** Contact Lens post-call analysis, trimmed to the fields we index. */
export interface PostCallAnalysis {
  readonly CustomerMetadata?: { readonly ContactId?: string };
  readonly Transcript?: readonly {
    readonly Id?: string;
    readonly ParticipantId?: string;
    readonly ParticipantRole?: string;
    readonly Content?: string;
    readonly BeginOffsetMillis?: number;
  }[];
  readonly LanguageCode?: string;
}

/**
 * Turns one analysed call into indexable documents.
 *
 * Pairs a customer question with the agent's following reply: the useful unit of
 * retrieval is "what was asked and what worked", not either side alone. An
 * unanswered question indexed by itself teaches the assistant to repeat it back.
 */
export function documentsFromAnalysis(analysis: PostCallAnalysis): MossDocument[] {
  const contactId = analysis.CustomerMetadata?.ContactId;
  const turns = analysis.Transcript;
  if (!contactId || !Array.isArray(turns)) return [];

  const docs: MossDocument[] = [];
  for (let i = 0; i < turns.length - 1; i++) {
    const question = turns[i];
    const answer = turns[i + 1];
    if (question.ParticipantRole !== 'CUSTOMER') continue;
    if (answer.ParticipantRole !== 'AGENT') continue;

    const q = (question.Content ?? '').trim();
    const a = (answer.Content ?? '').trim();
    if (!q || !a) continue;

    docs.push({
      id: `${contactId}:${question.Id ?? i}`,
      text: `Q: ${q}\nA: ${a}`,
      metadata: {
        contactId,
        ...(analysis.LanguageCode ? { locale: analysis.LanguageCode } : {}),
        offsetMillis: String(question.BeginOffsetMillis ?? 0),
      },
    });
  }
  return docs;
}

/**
 * Serialises documents into an index artifact.
 *
 * SEAM: today this writes the stub's JSON format. The real Moss index builder
 * replaces this one function -- everything downstream reads the manifest, so
 * nothing else changes when the format becomes opaque binary.
 */
export function buildIndexArtifact(documents: readonly MossDocument[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(documents));
}

export function manifestFor(documents: readonly MossDocument[], bytes: Uint8Array): IndexManifest {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  // Version is content-addressed: an identical corpus produces an identical
  // version, so a no-op rebuild cannot churn the live pointer.
  const version = sha256.slice(0, 16);
  return {
    version,
    key: `indexes/${version}.json`,
    documentCount: documents.length,
    builtAt: new Date().toISOString(),
    sha256,
  };
}

async function readJson<T>(bucket: string, key: string): Promise<T> {
  const res = await client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`s3://${bucket}/${key} is empty`);
  return JSON.parse(await res.Body.transformToString()) as T;
}

export async function handler(event: S3Event): Promise<void> {
  if (!INDEX_BUCKET) throw new Error('MOSS_INDEX_BUCKET must be set');

  const documents: MossDocument[] = [];
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    try {
      documents.push(...documentsFromAnalysis(await readJson<PostCallAnalysis>(bucket, key)));
    } catch (err) {
      console.warn(
        `skipping unreadable analysis s3://${bucket}/${key} ` +
          `error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (documents.length === 0) {
    await emit(Metric.RetrievalNoHit, { Surface: 'PostCall' });
    console.warn('post-call batch produced no indexable documents');
    return;
  }

  const bytes = buildIndexArtifact(documents);
  const manifest = manifestFor(documents, bytes);

  // Artifact first, manifest second. A manifest pointing at an object that does
  // not exist yet takes every consumer down on its next cold start.
  await client().send(
    new PutObjectCommand({
      Bucket: INDEX_BUCKET,
      Key: manifest.key,
      Body: bytes,
      ContentType: 'application/json',
    }),
  );
  await client().send(
    new PutObjectCommand({
      Bucket: INDEX_BUCKET,
      Key: MANIFEST_KEY,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: 'application/json',
    }),
  );

  console.log(
    `published index version=${manifest.version} documents=${manifest.documentCount} ` +
      `key=${manifest.key}`,
  );
}
