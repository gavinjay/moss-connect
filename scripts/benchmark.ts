#!/usr/bin/env ts-node
/**
 * Three-arm retrieval benchmark.
 *
 * WHY THREE ARMS
 * --------------
 *   bedrock-kb  a managed vector store behind a network call -- what an Amazon
 *               Connect customer deploys today. The arm Moss must beat.
 *   lexical     in-process, but NOT Moss. The control. Without it, a Moss win
 *               cannot be distinguished from "not making a network call is fast",
 *               which is the first objection any ML person will raise.
 *   moss        in-process Moss.
 *
 * bedrock-kb -> lexical isolates the architectural win (no network hop).
 * lexical -> moss isolates what Moss itself adds (semantic quality, Rust/WASM speed).
 *
 * COLD AND WARM ARE REPORTED SEPARATELY, ON PURPOSE. The managed baseline has no
 * init cost; the in-process arms must hydrate an index. Averaging the two either
 * flatters Moss (warm only) or buries it (mixed). Report both or report neither.
 *
 * Usage:
 *   npx ts-node scripts/benchmark.ts --mode local
 *   npx ts-node scripts/benchmark.ts --mode local --iterations 200
 *   npx ts-node scripts/benchmark.ts --mode lambda --arm lexical=<aliasArn> --arm moss=<aliasArn>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MossDocument, MossRetriever } from '../src/moss/retriever';
import { StubRetriever } from '../src/moss/stub-retriever';
import { BedrockKbRetriever } from '../src/moss/bedrock-kb-retriever';
import { LocalEmbedRetriever } from '../src/moss/local-embed-retriever';
import { isBenchArm, type BenchArmName } from '../src/config/deploy-config';

interface Question {
  readonly query: string;
  readonly expected: readonly string[];
}

interface Sample {
  readonly query: string;
  readonly elapsedMs: number;
  readonly embedMs: number | null;
  readonly topId: string | null;
  readonly top3: readonly string[];
}

interface ArmResult {
  readonly arm: string;
  readonly samples: readonly Sample[];
  readonly loadMs: number | null;
  readonly recallAt1: number;
  readonly recallAt3: number;
  readonly errors: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  // Nearest-rank. With small N, interpolation invents precision we do not have.
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarise(arm: string, samples: readonly Sample[], loadMs: number | null, questions: readonly Question[], errors: number): ArmResult {
  const expectedFor = new Map(questions.map((q) => [q.query, new Set(q.expected)]));
  let hit1 = 0;
  let hit3 = 0;
  let scored = 0;
  for (const s of samples) {
    const expected = expectedFor.get(s.query);
    if (!expected || expected.size === 0) continue;
    scored++;
    if (s.topId !== null && expected.has(s.topId)) hit1++;
    if (s.top3.some((id) => expected.has(id))) hit3++;
  }
  return {
    arm,
    samples,
    loadMs,
    recallAt1: scored === 0 ? NaN : hit1 / scored,
    recallAt3: scored === 0 ? NaN : hit3 / scored,
    errors,
  };
}

/**
 * Pads the corpus with synthetic distractor documents.
 *
 * The real documents stay first and keep their ids, so recall is still
 * computable -- but the filler is generated, not real, so treat recall at scale
 * as indicative only. What this DOES measure honestly is how search cost grows
 * with corpus size, which is the only axis on which an index beats a linear scan.
 */
function padCorpus(base: readonly MossDocument[], scale: number): MossDocument[] {
  const topics = ['billing', 'devices', 'network', 'roaming', 'plans', 'outages', 'security'];
  const padded: MossDocument[] = [...base];
  const target = base.length * scale;
  for (let i = padded.length; i < target; i++) {
    const topic = topics[i % topics.length];
    padded.push({
      id: `filler-${i}`,
      text: `Regarding ${topic}, policy note ${i}: customers should review the ${topic} section of their agreement for terms covering item ${i % 97} and related conditions.`,
      metadata: { locale: 'en-US', topic },
    });
  }
  return padded;
}

async function runLocalArm(
  arm: BenchArmName,
  corpus: readonly MossDocument[],
  questions: readonly Question[],
  iterations: number,
): Promise<ArmResult> {
  let retriever: MossRetriever;
  if (arm === 'lexical') {
    retriever = new StubRetriever();
  } else if (arm === 'local-embed') {
    retriever = new LocalEmbedRetriever();
  } else if (arm === 'bedrock-kb') {
    const kbId = process.env.MOSS_BEDROCK_KB_ID;
    if (!kbId) throw new Error('bedrock-kb arm needs MOSS_BEDROCK_KB_ID (and AWS credentials)');
    retriever = new BedrockKbRetriever(kbId, process.env.AWS_REGION);
  } else {
    // Never silently substitute the stub here. A benchmark that reports "moss"
    // numbers for a word-overlap scorer is worse than no benchmark.
    throw new Error(
      'the moss arm needs real MossSdkBindings. Wire src/moss/sdk-retriever.ts, then ' +
        'construct SdkRetriever here. It will NOT fall back to the lexical stub.',
    );
  }

  const loadStart = performance.now();
  await retriever.load({ kind: 'documents', version: 'bench', documents: corpus });
  const loadMs = performance.now() - loadStart;

  // Discard a warmup pass: first-call JIT and allocation are not steady state.
  for (const q of questions) await retriever.retrieve(q.query, { topK: 3 });

  const samples: Sample[] = [];
  let errors = 0;
  for (let i = 0; i < iterations; i++) {
    for (const q of questions) {
      try {
        const res = await retriever.retrieve(q.query, { topK: 3 });
        samples.push({
          query: q.query,
          elapsedMs: res.elapsedMs,
          embedMs: res.breakdown?.embedMs ?? null,
          topId: res.hits[0]?.id ?? null,
          top3: res.hits.slice(0, 3).map((h) => h.id),
        });
      } catch {
        errors++;
      }
    }
  }
  return summarise(arm, samples, loadMs, questions, errors);
}

function latencyStats(samples: readonly Sample[]): Record<string, number> {
  const sorted = [...samples.map((s) => s.elapsedMs)].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? NaN,
  };
}

function report(results: readonly ArmResult[], iterations: number): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`Retrieval benchmark -- ${iterations} iteration(s) over ${results[0]?.samples.length ?? 0} samples/arm`);
  lines.push('');
  lines.push('arm            n      p50      p90      p99      max  embed%     load    R@1    R@3');
  lines.push('-------------------------------------------------------------------------------------');
  for (const r of results) {
    const sorted = [...r.samples.map((s) => s.elapsedMs)].sort((a, b) => a - b);
    const f = (n: number) => (Number.isFinite(n) ? n.toFixed(2).padStart(7) : '      -');
    const pct = (n: number) => (Number.isFinite(n) ? `${(n * 100).toFixed(0)}%`.padStart(6) : '     -');
    const embeds = r.samples.map((s) => s.embedMs).filter((v): v is number => v !== null);
    const embedShare =
      embeds.length === 0
        ? '      -'
        : `${((embeds.reduce((a, b) => a + b, 0) / r.samples.reduce((a, s) => a + s.elapsedMs, 0)) * 100).toFixed(0)}%`.padStart(7);
    lines.push(
      [
        r.arm.padEnd(13),
        String(sorted.length).padStart(5),
        f(percentile(sorted, 50)),
        f(percentile(sorted, 90)),
        f(percentile(sorted, 99)),
        f(sorted[sorted.length - 1] ?? NaN),
        embedShare,
        (r.loadMs === null ? '-' : r.loadMs.toFixed(0)).padStart(8),
        pct(r.recallAt1),
        pct(r.recallAt3),
      ].join(' '),
    );
  }
  lines.push('');
  lines.push('p50/p90/p99/max and load are milliseconds. R@1/R@3 are recall against the');
  lines.push('labeled set in bench/questions.json -- latency without quality is half an argument.');
  lines.push('embed% is how much of retrieve() went to embedding the QUERY -- unavoidable on the');
  lines.push('hot path for any vector retriever, and the thing a headline number can quietly omit.');
  lines.push('');
  lines.push('CAVEATS that belong on any chart built from this:');
  lines.push('  - These are WARM, in-process numbers. Cold start is a separate measurement.');
  lines.push('  - The lexical arm is word-overlap, not semantic. It is the control, not a product.');
  lines.push('  - 18 labeled questions is enough to smoke-test the harness, not to claim a');
  lines.push('    quality result. Aim for ~50+ before showing recall to anyone.');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback?: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const mode = get('--mode', 'local')!;
  const iterations = Number(get('--iterations', '50'));
  // Corpus size is the variable that decides this whole question. A brute-force
  // cosine scan over 14 documents is free; over 100,000 it is not, and that gap
  // is the only place a purpose-built index can earn its keep. Padding is
  // synthetic filler -- it makes the LATENCY curve honest, not the recall.
  const scale = Math.max(1, Number(get('--scale', '1')));
  const armArgs = (get('--arms', 'lexical,local-embed') ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a !== '');
  for (const a of armArgs) {
    if (!isBenchArm(a)) {
      throw new Error(`unknown arm: ${a}. Valid: lexical, local-embed, moss, bedrock-kb`);
    }
  }
  const arms = armArgs as BenchArmName[];

  if (mode !== 'local') {
    console.error(
      `mode "${mode}" is not implemented yet. Local mode measures the retrieval leg, which is\n` +
        'what differs between arms; Lambda mode additionally measures invoke overhead that is\n' +
        'identical across arms and only adds noise. See docs/BENCHMARK.md.',
    );
    process.exit(2);
  }

  const root = resolve(__dirname, '..');
  const baseCorpus = JSON.parse(readFileSync(resolve(root, 'bench/corpus.json'), 'utf8')) as MossDocument[];
  const corpus = scale > 1 ? padCorpus(baseCorpus, scale) : baseCorpus;
  if (scale > 1) {
    console.log(
      `corpus padded ${baseCorpus.length} -> ${corpus.length} documents. ` +
        'Filler is synthetic: latency numbers are meaningful, recall is not.',
    );
  }
  const questions = JSON.parse(readFileSync(resolve(root, 'bench/questions.json'), 'utf8')) as Question[];

  const results: ArmResult[] = [];
  for (const arm of arms) {
    try {
      results.push(await runLocalArm(arm, corpus, questions, iterations));
    } catch (err) {
      console.error(`SKIPPED arm "${arm}": ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  if (results.length === 0) {
    console.error('no arms ran');
    process.exit(1);
  }

  const text = report(results, iterations);
  console.log(text);
  const out = resolve(root, 'bench/results.json');
  const serialisable = results.map((r) => ({
    arm: r.arm,
    sampleCount: r.samples.length,
    loadMs: r.loadMs,
    recallAt1: r.recallAt1,
    recallAt3: r.recallAt3,
    errors: r.errors,
    latencyMs: latencyStats(r.samples),
  }));
  writeFileSync(
    out,
    JSON.stringify({ mode, iterations, generatedAt: new Date().toISOString(), results: serialisable }, null, 2),
  );
  console.log(`raw summary written to ${out}`);
}

void main();
