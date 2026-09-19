# Retrieval benchmark

## Why three arms, not two

| Arm | What it is | What it isolates |
|---|---|---|
| `bedrock-kb` | Bedrock Knowledge Base — managed vector store behind a network call | What an Amazon Connect customer deploys **today**. The arm Moss must beat. |
| `lexical` | In-process IDF-weighted word overlap. Not Moss. | **The control.** In-process but not semantic. |
| `moss` | In-process Moss (Rust/WASM) | The product. |

The two comparisons that matter:

- **`bedrock-kb` → `lexical`** isolates the *architectural* win: what you get purely
  from deleting the network hop.
- **`lexical` → `moss`** isolates what *Moss itself* adds: semantic recall and
  index performance, at in-process latency.

Skip the control and a Moss win is unattributable. You will have proved
*"not making a network call is fast"*, which nobody disputes, and an ML-literate
founder will say so within about ninety seconds. The control is what turns a demo
into an experiment.

## Running it

```bash
npm run bench -- --mode local --arms lexical --iterations 50
```

Local mode needs no AWS account and no deployment. It measures the **retrieval
leg**, which is the only leg that differs between arms. Lambda invoke overhead is
identical across arms and adds nothing but variance, which is why there is no
Lambda mode yet.

The `moss` arm **fails loudly** until the real SDK is bound. It will not fall back
to the lexical stub: a benchmark that prints "moss" numbers for a word-overlap
scorer is worse than no benchmark.

## First result (lexical control, 14-document corpus, 18 labeled questions)

```
arm          n      p50      p90      p99      max    load    R@1    R@3
lexical        900    0.01    0.01    0.03    2.65       1    50%    67%
```

Read this carefully, because it reframes the pitch for a corpus this size:

**Latency is not the interesting axis here.** Word overlap across 14 documents
takes 0.01ms — already three orders of magnitude under Moss's 10ms headline. On a
small corpus, in-process retrieval of *any* kind is effectively free, and Moss
cannot win a speed argument against a number that is already zero.

**Quality is the axis.** The control answers only **50% of paraphrased questions
correctly at rank 1**. Every miss is lexical: "how long do I have to return
something" shares almost no vocabulary with a passage about refund windows. That
50% is the number Moss has to beat, and it is a fair, defensible baseline to
quote.

So for a demo at this scale, the Moss story is *semantic recall at in-process
latency* — not raw speed. Raw speed only becomes the story against `bedrock-kb`,
where the network hop puts 30–80ms on the board.

## Corpus size is a first-class variable

Latency differences between in-process arms only emerge at scale. A linear scan of
14 documents is free; a scan of 100,000 is not, and that is precisely where an
indexed structure earns its keep. Before quoting latency, run at several corpus
sizes (1k / 10k / 100k) and show the curve. A single small-corpus number will
understate Moss and an ML founder will know it.

## Cold vs warm: report both or neither

The managed baseline has **zero init cost**. The in-process arms must hydrate an
index before the first query. Averaging cold and warm together either flatters
Moss (warm only) or buries it (mixed).

This is where Moss is most likely to lose, and you want that number before he
quotes it at you. Measure it deliberately:

- **Warm** is what the harness reports now — steady state, after a discarded
  warmup pass.
- **Cold** means a fresh Lambda execution environment. Force one by changing a
  function environment variable (which replaces all containers), then invoke once.
  Note that **provisioned concurrency defeats this** — measure cold against an
  unwarmed version, or the number is meaningless.

Mitigations for a bad cold-start number, in preference order: provisioned
concurrency (already wired to the alias), a smaller index, or lazy/partial index
load. All three are worth discussing with Moss rather than working around alone.

## Keeping the comparison honest

- **Same corpus, same query set, same Lambda memory, same region.** The stack
  enforces identical memory and timeout across arms, and a test asserts it.
- **The Bedrock client is constructed at module scope** so SDK init and TLS
  setup are not charged to per-query latency. Charging the baseline for cold TLS
  on every call would flatter Moss dishonestly.
- **`bedrock-kb` returns no stable document id**, so the harness falls back to the
  S3 source URI. Normalise ids to a common scheme before comparing recall across
  arms, or the baseline will score 0% for reasons that have nothing to do with
  retrieval quality.
- **18 labeled questions smoke-tests the harness. It does not support a quality
  claim.** Get to ~50+ before showing recall to anyone, and write the labels
  before you see any arm's output.

## What is not yet measured

- Cold start, as above — needs a deployment.
- Token cost. Moss advertises 70–90% savings versus traditional pipelines; that
  is a separate measurement against whatever consumes the retrieved context.
- End-to-end call latency including telephony and TTS. The demo flow uses a keypad
  menu precisely because speech recognition adds 500–1500ms and heavy variance,
  which would swamp everything above.
