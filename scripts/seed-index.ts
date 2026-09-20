/**
 * Seeds the live index from a local corpus file.
 *
 * Nothing retrieves until a manifest exists: every call escalates by design and
 * `Index.LoadFailed` fires. This is the bootstrap that breaks that loop.
 *
 * It reuses `buildIndexArtifact()` and `manifestFor()` from the post-call
 * indexer -- the manifest's ONLY production writer -- so the two cannot drift
 * apart on format, and it follows the same ordering rule: artifact first,
 * manifest second. A manifest naming an object that does not exist yet takes
 * every consumer down on its next cold start.
 *
 * Refuses to overwrite an existing manifest unless --force is passed; the
 * post-call indexer owns it once calls start landing.
 *
 *   npm run seed-index                       # bench/corpus.json -> live index
 *   npm run seed-index -- --corpus path.json --force
 *
 * The bucket is discovered from the MossConnectStack outputs, never typed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { buildIndexArtifact, manifestFor } from '../src/handlers/post-call-index';
import type { MossDocument } from '../src/moss/retriever';

const root = resolve(__dirname, '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const force = process.argv.includes('--force');

function stackOutput(stack: string, key: string, region: string): string {
  const out = execFileSync(
    'aws',
    [
      'cloudformation', 'describe-stacks', '--stack-name', stack, '--region', region,
      '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue`, '--output', 'text',
    ],
    { encoding: 'utf8' },
  ).trim();
  if (!out || out === 'None') throw new Error(`stack ${stack} has no output ${key}; is it deployed?`);
  return out;
}

async function main(): Promise<void> {
  const cdk = JSON.parse(readFileSync(resolve(root, 'cdk.json'), 'utf8'));
  const ctx = cdk.context.mossConnect;
  const region: string = ctx.region;
  const manifestKey: string = ctx.indexStore.manifestKey;

  const bucket = arg('bucket') ?? stackOutput('MossConnectStack', 'IndexBucketName', region);
  const corpusPath = resolve(root, arg('corpus') ?? 'bench/corpus.json');
  const documents = JSON.parse(readFileSync(corpusPath, 'utf8')) as MossDocument[];
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new Error(`${corpusPath} is not a non-empty document array`);
  }
  for (const d of documents) {
    if (typeof d.id !== 'string' || typeof d.text !== 'string') {
      throw new Error(`document ${JSON.stringify(d).slice(0, 80)} lacks string id/text`);
    }
  }

  const s3 = new S3Client({ region });

  try {
    const existing = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: manifestKey }));
    const current = await existing.Body?.transformToString();
    if (!force) {
      console.error(
        `refusing to overwrite existing manifest s3://${bucket}/${manifestKey}\n${current}\n` +
          'Pass --force to replace it.',
      );
      process.exit(2);
    }
    console.log(`replacing existing manifest (--force): ${current?.replace(/\s+/g, ' ')}`);
  } catch (err) {
    const code = (err as { name?: string }).name;
    if (code !== 'NoSuchKey' && code !== 'NotFound') throw err;
  }

  const bytes = buildIndexArtifact(documents);
  const manifest = manifestFor(documents, bytes);

  // Artifact first.
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: manifest.key, Body: bytes, ContentType: 'application/json' }),
  );
  console.log(`wrote artifact s3://${bucket}/${manifest.key} bytes=${bytes.byteLength}`);

  // Manifest second.
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: manifestKey,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: 'application/json',
    }),
  );
  console.log(
    `published manifest s3://${bucket}/${manifestKey} version=${manifest.version} ` +
      `documents=${manifest.documentCount} corpus=${corpusPath}`,
  );
  console.log(
    'Provisioned instances already running hold the OLD index until they recycle. ' +
      'To pick it up now, publish a new Lambda version (redeploy) or wait for the natural refresh.',
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
