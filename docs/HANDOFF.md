# Handoff — state as of 2026-09-20

Written for a Claude Code CLI session picking this up locally. Read
`CLAUDE.md` first; this file is what is true *right now*.

---

## What is actually deployed

**`ConnectFoundationStack` — DEPLOYED, green.** In account `184670915146`,
`us-west-2`:

| | |
|---|---|
| Connect instance | `2b88db70-9667-404a-b9ba-634da2adbfa6` (`trackit-demo`, created by hand, **adopted** not managed) |
| **Demo phone number** | **`+1 686 210 3817`** — claimed and billing |
| Escalation queue | `.../queue/04923a7e-bd27-4f1a-b870-d3d69e9e15e6` |
| Also created | hours of operation, routing profile |

**`MossConnectStack` — FAILED, rolled back.** Nothing from it exists.

**CDK bootstrap** — done, version 32.

## Why it failed, and what was changed

```
CREATE_FAILED  AWS::Connect::InstanceStorageConfig  CallRecordingStorage
"Storage Config is already associated" (409, AlreadyExists)
```

Connect permits exactly **one storage config per resource type per instance**.
`trackit-demo` was created in the console and already had `CALL_RECORDINGS`, so
ours was rejected and took the stack down.

Fixed by making storage configs opt-in per type
(`connect.storageConfigs` in `cdk.json`). `callRecordings` now defaults to
**false** — adopting an instance means not assuming you own its storage.

**Consequence, and it is a real one:** with `callRecordings: false`, Contact Lens
post-call analysis goes to whatever bucket the *existing* config names, not our
`AnalysisBucket`. The S3 notification never fires and **the post-call index is
never rebuilt**. Surface 3 is inert until someone repoints that config by hand.
Nothing errors; it just quietly does nothing — the exact failure mode `CLAUDE.md`
is written around. Do not let this go unnoticed.

## Next command

```bash
cd ~/moss-connect && git pull
export AWS_PROFILE=hermes          # resolves to 184670915146
npm run cdk:deploy
```

`preflight` runs automatically and verifies account + bootstrap.

## What will probably break next

**The contact flow JSON has never been validated.** `CallRecordingStorage` failed
before CloudFormation reached `AWS::Connect::ContactFlow`, so the flow content in
`src/flows/flow-builder.ts` is still unproven against a live Connect instance.

It is structurally validated (every transition resolves, no orphans, no duplicate
ids — `src/__tests__/flow-builder.test.ts`) but the *action types and parameter
names* are modelled from documentation, not round-tripped. Connect validates
server-side and rejects with a reasonably specific message. **Expect this to be
the next failure.** Fix it in `flow-builder.ts`, keep the structural tests green.

## After a green deploy

1. **Seed an index.** Nothing retrieves until one exists; every call escalates by
   design and `Index.LoadFailed` fires. `bench/corpus.json` is a fine first
   corpus. Upload the **artifact first, manifest second** — a manifest naming a
   missing object breaks every consumer's next cold start.
2. **Point `+1 686 210 3817` at the `lexical` contact flow.** Console step, or
   `associate-phone-number-contact-flow`. This is how you switch arms in a demo.
3. **Create an agent login.** The routing profile and queue exist; no users do.
4. **Call it.** Keypad menu, three canned questions, answer read back by Polly.

## Open items

- **`cloudwatch:PutMetricData` is granted on `*`.** It has no resource-level ARN,
  but it can be condition-scoped to `cloudwatch:namespace = MossConnect`. Worth
  tightening; not urgent.
- **`cdk bootstrap` used `AdministratorAccess`** as the CloudFormation execution
  policy (CDK's default, not a choice made here). Scopeable with
  `--cloudformation-execution-policies`.
- **Only the `lexical` arm is deployed.** `bedrock-kb` needs a Knowledge Base id
  in `cdk.json`; `moss` needs real SDK bindings in `src/moss/sdk-retriever.ts`
  and **refuses to start without them** rather than serving stub results. Ladder
  documented in `cdk.json`.
- **`local-embed` benchmark arm is unverified since the package swap.** Moved
  from `@xenova/transformers` (1 critical + 4 high advisories) to
  `@huggingface/transformers` (clean). Typecheck caught the v3 `quantized` →
  `dtype` rename, but the arm has not been *executed* since. Verify with
  `npm run bench -- --arms local-embed`. May need
  `npm install-scripts approve onnxruntime-node` first.
- **Benchmark is single-arm until Moss lands.** Current control result: p50
  0.01ms, **recall@1 50%** on 14 docs / 18 labeled questions. `local-embed`
  scored **100%** — free local embeddings already saturate this corpus, so it is
  too easy to discriminate anything. See `docs/BENCHMARK.md`; a ~100k document
  corpus is the highest-value missing piece.
- **`docs/MOSS_QUESTIONS.md`** — 14 questions for the design-partner call. The
  most load-bearing is #1 (can a prebuilt index load from raw bytes), because
  index build time measured 334ms at 14 docs and **5.6s at 1,400**.

## Three accounts — do not mix them up

| Account | What |
|---|---|
| `184670915146` | **This project.** Profile `hermes`. |
| `394125495069` | Default profile `gavin`. An earlier `cdk diff` targeted this by mistake. |
| `576872909007` | `claude-sandbox`, the `jarvis` project. Unrelated. |

`npm run audit:accounts` sweeps all profiles for stray stacks and claimed phone
numbers. Last run: clean except the intended foundation stack.

**Amazon Connect does not exist in `us-east-2`.** The synth fails closed on it.
