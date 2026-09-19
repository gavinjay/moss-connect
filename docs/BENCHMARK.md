# Retrieval benchmark

## Why three arms, not two

| Arm | What it is | What it isolates | Runs locally? |
|---|---|---|---|
| `lexical` | Word-overlap matching. No AI. | The floor. What you get with no semantics at all. | Yes |
| `local-embed` | MiniLM sentence embeddings + brute-force cosine, all in-process | **"Why do I need Moss?"** Semantic and in-process and free. | Yes |
| `bedrock-kb` | Bedrock Knowledge Base — managed vector store behind a network call | What a Connect customer deploys **today**. | Needs AWS |
| `moss` | In-process Moss (Rust/WASM) | The product. | Needs the SDK |

`local-embed` is the arm that matters most. Any competent engineer evaluating Moss
will say *"I can embed with MiniLM locally and do a dot product."* If Moss cannot
beat that, Moss has no story. It is semantic like Moss, in-process like Moss, and
free — so it isolates exactly what Moss adds over the obvious DIY approach.

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

## Results so far

**14 documents, 18 labeled questions, warm:**

```
arm            n      p50      p90      p99      max  embed%     load    R@1    R@3
lexical         360    0.01    0.02    0.04    0.06       -        1    50%    67%
local-embed     360    1.86    2.20    4.42    6.37     99%      334   100%   100%
```

**1,400 documents (100x padding), warm:**

```
local-embed      90    3.55    3.91    7.98    7.98     57%     5621   100%   100%
```

Three findings, and none of them flatter the premise at this scale:

**1. Free local embeddings already get 100%.** MiniLM answers every paraphrased
question correctly. There is no quality headroom left for Moss to win on a corpus
this easy — the test is too small to discriminate.

**2. Embedding the query dominates, not searching.** At 14 documents, **99%** of
`retrieve()` is turning the question into a vector. The actual similarity search
is ~0.02ms. This is the single most important question to put to Moss: *does
"sub-10ms" include embedding the query, or only the search?* If it excludes
embedding, Moss's search is competing against a number that is already effectively
zero. If it includes embedding, Moss at 10ms is **slower** than this free setup at
1.86ms. Either answer is informative.

**3. Load time is the real problem, and it grows fast.** 334ms at 14 documents,
**5.6 seconds** at 1,400. Extrapolated to 100k documents that is minutes of
embedding before the first call can be served — which is exactly why an index must
be *prebuilt and loaded from bytes* rather than constructed at startup. See
question 1 in `docs/MOSS_QUESTIONS.md`; it is now the most load-bearing question
on the list.

## Corpus size is the variable that decides this

```bash
npm run bench -- --arms local-embed --scale 100 --iterations 5
```

`--scale` pads the corpus with synthetic distractors. Recall becomes indicative
only (the filler is generated), but the **latency curve is honest**, and that
curve is the whole argument: search grew from ~0.02ms to ~1.5ms as the corpus grew
100x, while embedding stayed flat. Extrapolate and brute force loses — somewhere
above ~100k documents a purpose-built index has to win.

**That crossover point is where Moss's value lives, and this repo cannot currently
find it** because there is no 100k-document corpus to test against. Getting one is
the highest-value next step for the benchmark.

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
