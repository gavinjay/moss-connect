# moss-connect — Agent Operating Manual

Amazon Connect ↔ Moss integration. One manual; keep it here, don't fork it.

---

## Deployment coordinates — check these BEFORE concluding something is missing

| | |
|---|---|
| AWS profile | whichever maps to account 184670915146 |
| Account | `184670915146` |
| **Region** | **`us-west-2`** |
| Stacks | `ConnectFoundationStack` (deploy once) + `MossConnectStack` (iterate) |

```bash
AWS_PROFILE="$MOSS_PROFILE" AWS_REGION=us-west-2 aws <cmd>
```

### Amazon Connect is NOT in us-east-2

The US Connect regions are `us-east-1` and `us-west-2`. **Ohio is not one of them.**

This matters more here than it looks. The sibling `jarvis` project deploys to
`us-east-2` and its manual contains a long warning about a session that burned
many tool calls in the wrong region — so `us-east-2` is exactly what a returning
engineer types. On this project that region does not merely hold the wrong
resources; the service is absent, and the failure reads like an IAM or account
problem instead.

`src/config/regions.ts` is the single source of truth and fails the synth.
Re-verify the list when adding a region — AWS adds them over time.

---

## What this is

Three integration surfaces over one shared retrieval core:

1. **Voice retrieval** (`src/handlers/voice-retrieval.ts`) — contact flow → Lambda
   → in-process index → answer to the caller.
2. **Agent assist** (`src/handlers/agent-assist.ts`) — Contact Lens real-time →
   Kinesis → retrieval → suggestion to the human agent.
3. **Post-call enrichment** (`src/handlers/post-call-index.ts`) — analysis in S3 →
   Q/A documents → new versioned index. The **only** writer of the manifest.

---

## The invariant that defines this project

**Retrieval happens in-process. `retrieve()` does no I/O.**

Moss sells sub-10ms retrieval with zero network hops. Turn it into a remote
service call and you have added 30–80ms to the thing that was supposed to be
fast, and *nothing fails* — tests pass, calls connect, the product is just
quietly worse. That is the single most likely way this project dies.

Consequences, all load-bearing:

- The index loads at **module scope** in each handler (Lambda init phase), never
  inside the handler body.
- Provisioned concurrency attaches to a Lambda **alias**. `$LATEST` cannot be
  warmed. `src/__tests__/stack.test.ts` pins this.
- `MossRetriever.load()` may be slow; `retrieve()` may not. Any PR that adds a
  `fetch`/SDK call inside `retrieve()` is wrong.

---

## Build / test / deploy

```bash
npm run typecheck       # tsc --noEmit (covers bin/ lib/ src/ scripts/)
npm test                # 101 tests, incl. fast-check property tests + two-stack synth
npm run bench -- --mode local --arms lexical   # needs no AWS
npm run cdk:synth
npm run cdk:diff        # and actually read the [-] lines
npm run cdk:deploy
```

`npm test` includes a real `Template.fromStack` synth, so esbuild bundling of all
three handlers is exercised by the suite. A green suite means the stack
synthesizes.

---

## Conventions

- **Every required deploy input lives in `cdk.json`** — not a `-c` flag, not a
  shell env var. `src/config/deploy-config.ts` throws on absence rather than
  substituting a default. Currently load-bearing: `connectInstanceArn`, `region`,
  `indexStore.manifestKey`, all three `tags.*`.
- **TrackIt tags are mandatory** and applied through `lib/tagging.ts`, which both
  `bin/` and the stack test call. Never apply tags via the CLI — they drift off on
  the next deploy.
- **Emit a metric whenever you degrade.** A caught error that only WARNs is
  invisible; the contact center keeps answering calls, just worse. See
  `src/observability/metrics.ts` — every degradation path has a metric and an
  alarm, and the alarm namespace is asserted against the emitted namespace in
  `stack.test.ts`.
- **Structured single-line logs.** Inline the context into the message; don't rely
  on a formatter to render `extra={}`.
- **Property tests use fast-check.**

---

## Gotchas that are real bugs already fixed — don't regress

1. **Connect contact-flow responses must be FLAT.** String keys → scalar values.
   One nested object or array and Connect rejects the entire response, sending the
   contact down the error branch. This fails at runtime on a live call and nowhere
   else. `src/handlers/connect-contract.ts` guards it; `flattenForConnect()` is
   how you return multiple hits.
2. **Connect abandons a contact-flow Lambda at 8 seconds, hard.** The config
   loader refuses a timeout ≥ 8 so the handler returns a graceful `escalate` flag
   instead of Connect timing out on us.
3. **Never throw at Connect.** An exception gives the flow no context. Return
   `{ resolved: false, escalate: true, reason: ... }`.
4. **32KB response cap.** `truncateToBytes()` respects UTF-8 boundaries — an
   earlier version cut multi-byte characters in half because it inspected a byte
   past the end of the buffer.
5. **`exactOptionalPropertyTypes` is off on purpose.** `aws-cdk-lib`'s own types
   are incompatible with it (`IVersion.role`, `Environment.account`). Everything
   else stays strict. Don't turn it back on.
6. **Don't count `AWS::Lambda::Function` resources in stack tests.** CDK injects a
   `BucketNotificationsHandler` of its own. Count only functions carrying
   `MOSS_INDEX_BUCKET`.
7. **Agent speech is excluded from retrieval input.** Retrieving against the
   agent's own words creates a loop where the assistant re-suggests whatever the
   agent just read aloud.
8. **Write the index artifact before the manifest.** A manifest pointing at an
   object that does not exist yet takes every consumer down on its next cold
   start.
9. **The `moss` arm never falls back to the lexical stub.** `retrieverFor()`
   throws when no SDK bindings are supplied. A benchmark that reports "moss"
   numbers for a word-overlap scorer is worse than no benchmark.
10. **`bedrock-kb` does network I/O inside `retrieve()` on purpose.** Everywhere
    else that is a bug; there it is the measurement. Don't "fix" it with a cache,
    and don't copy the pattern into another arm.
11. **Arms must be sized identically.** Same memory, same timeout, same region, or
    the benchmark measures Lambda rather than retrieval. A stack test asserts it.
12. **The Connect instance and phone number live in the foundation stack.** Never
    move them into the app stack — a rollback there would destroy the demo line.
13. **`scripts/` is inside the typecheck.** It was not originally, and the
    benchmark harness broke without `tsc` noticing.
14. **Lambda runtime is nodejs24.x.** nodejs20.x is deprecated with creation
    disabled from 2027-02-01.
15. **The target account comes from the Connect instance ARN, never from
    `CDK_DEFAULT_ACCOUNT`.** Three accounts are in play (184670915146 holds the
    Connect instance; 394125495069 and 576872909007 do not). Taking it from the
    environment once synthesized a cross-account stack that looked completely
    normal. A mismatch is fatal at synth.
16. **Never put a placeholder inside a runnable command block.** `<angle
    brackets>` are read by zsh as redirects, and a realistic-looking fake profile
    name gets pasted verbatim. Write commands that DISCOVER the value instead --
    that is what `scripts/preflight.sh` is for.

---

## Moss SDK: unverified surface

The Moss JS SDK's API has **not** been inspected. `src/moss/sdk-retriever.ts`
takes what it needs as an injected `MossSdkBindings` object instead of guessing
at import paths and method names — which would produce code that looks finished,
compiles, and is wrong.

**Do not invent Moss API calls.** If you need a fact about the SDK and don't have
it, put it in `docs/MOSS_QUESTIONS.md` and leave the seam alone. We are a design
partner; asking is cheap.

`StubRetriever` is lexical (IDF-weighted token overlap), not semantic. It exercises
the pipeline's shape. It is **not** a quality or latency stand-in for Moss.

---

## Don't do

- Don't move the index load inside a handler body.
- Don't associate the Connect integration with `$LATEST` to "simplify" — that
  silently discards the warm path.
- Don't add a second writer of the index manifest.
- Don't skip `cdk diff` before a deploy.
- Don't put a real Connect instance ARN, phone number, or transcript in a commit.
