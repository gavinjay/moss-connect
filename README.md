# moss-connect

Amazon Connect ↔ **Moss** integration: sub-10ms semantic retrieval for contact-center voice agents.

[Moss](https://www.ycombinator.com/companies/moss) (YC F25) is a real-time semantic
search runtime — a Rust/WASM vector index that runs *in the same process as the
agent*, returning results in single-digit milliseconds with no network hop. This
repo wires that into Amazon Connect across three surfaces.

---

## ⚠️ Region: this is not `us-east-2`

**Amazon Connect does not exist in us-east-2 (Ohio).** The US Connect regions are
`us-east-1` and `us-west-2`.

This project deploys to **`us-west-2`** — Connect-supported, lowest RTT from SF,
and the sandbox account default.

The sibling `jarvis` project deploys to `us-east-2`, so that is the region muscle
memory will type. `src/config/regions.ts` fails the synth rather than let it
through. Always be explicit:

```bash
AWS_PROFILE=claude-sandbox AWS_REGION=us-west-2 aws <cmd>
```

---

## The one architectural decision that matters

Moss's value proposition is **zero network hops** — the index lives where the
agent runs. If this integration calls Moss as a remote service, it adds 30–80ms
of round trip to something that advertises sub-10ms, and the reason to use Moss
disappears **while every test still passes**.

So the index is loaded **in-process, during Lambda init**, and `retrieve()` never
does I/O:

```
Connect contact flow
      │  (InvokeLambdaFunction, 8s hard ceiling)
      ▼
Lambda  ── init phase ──▶ S3 manifest ──▶ index bytes ──▶ in-memory Moss index
      │                                                          │
      └── handler: pure memory lookup ◀───────────────────────────┘
```

`src/moss/retriever.ts` encodes this: `load()` is allowed to be slow, `retrieve()
`is not. **An implementation that does network I/O inside `retrieve()` is a bug,
not a tradeoff.**

Provisioned concurrency is therefore load-bearing, and it attaches to a Lambda
**alias** — never `$LATEST`. A regression to `$LATEST` breaks nothing visibly; it
just moves the index load onto a caller's first word.

---

## The three surfaces

| Surface | Path | Status |
|---|---|---|
| **1. Self-service voice retrieval** | Contact flow → Lambda → in-process index → answer to caller | Built, tested |
| **2. Real-time agent assist** | Contact Lens real-time → Kinesis → retrieval → suggestion to agent | Built, delivery seam open |
| **3. Post-call enrichment** | Contact Lens analysis in S3 → Q/A documents → new versioned index | Built, tested |

Surface 2 has a better version that this repo does **not** yet implement: because
Moss runs in the browser via WASM, holding the index in the *agent's browser* and
retrieving locally beats any server-side path. See `docs/ARCHITECTURE.md`.

---

## Quickstart

```bash
npm install
npm run typecheck
npm test              # 67 tests, incl. property tests and a full stack synth
npm run cdk:synth     # fails until cdk.json names your Connect instance
```

Before the first synth succeeds, set `mossConnect.connectInstanceArn` in
`cdk.json`. It is intentionally blank: a missing required input fails loudly here
rather than deploying something subtly wrong.

```bash
npm run cdk:diff      # read the [-] lines
npm run cdk:deploy
```

---

## Moss SDK status

The Moss JS SDK's actual API has **not** been inspected, so nothing in this repo
pretends to call it. `src/moss/sdk-retriever.ts` takes the operations it needs as
an injected `MossSdkBindings` object — wiring the real SDK is a ~20-line binding
in one file, with nothing fabricated anywhere else.

Until then `StubRetriever` (IDF-weighted lexical scoring, deterministic) runs the
whole pipeline locally and in CI. It is **lexical, not semantic** — never use it
to judge answer quality or to benchmark latency claims.

`docs/MOSS_QUESTIONS.md` is the list of things to settle with the Moss team.

---

## Layout

```
bin/            CDK entry point + TrackIt tagging
lib/            Stack and one construct per surface
src/config/     Connect region allowlist, fail-closed cdk.json loader
src/moss/       Retriever interface, stub, SDK seam, index distribution
src/handlers/   Three Lambda handlers + Connect/Contact Lens contracts
src/__tests__/  Co-located tests
docs/           Architecture, deploy runbook, open questions for Moss
```
