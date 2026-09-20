# Handoff — state as of 2026-09-20

Written for a Claude Code CLI session picking this up locally. Read
`CLAUDE.md` first; this file is what is true *right now*.

---

## What is actually deployed

Both stacks are **green** in account `184670915146`, `us-west-2`.

**`ConnectFoundationStack`** — unchanged since the last handoff.

| | |
|---|---|
| Connect instance | `2b88db70-9667-404a-b9ba-634da2adbfa6` (`trackit-demo`, adopted, not managed) |
| **Demo phone number** | **`+1 686 210 3817`** — claimed, and now **pointed at the `lexical` flow** |
| Escalation queue | `.../queue/04923a7e-bd27-4f1a-b870-d3d69e9e15e6` |

**`MossConnectStack`** — `CREATE_COMPLETE` on 2026-09-20 00:56 UTC.

| | |
|---|---|
| Arms deployed | `lexical` only |
| Voice Lambda alias | `MossConnectStack-VoicelexicalFn…:live`, provisioned concurrency **READY, 2** |
| Contact flow | `moss-connect-lexical`, `ACTIVE` / `PUBLISHED` |
| Index bucket | `mossconnectstack-indexstorebucket…` (see stack output `IndexBucketName`) |
| Live index | `manifests/current.json` → `indexes/3801044e0734ead7.json`, **14 documents** from `bench/corpus.json` |
| Realtime analytics storage config | created (Kinesis stream for agent assist) |
| Call-recording storage config | **not** created, by config — see "Surface 3 is inert" below |

## What was verified, and how

1. **The contact flow is accepted by Connect.** Not just by CloudFormation: the
   rendered JSON was round-tripped through `aws connect create-contact-flow
   --cli-error-format json`, which returns the specific problem list that
   CloudFormation's bare `InvalidContactFlowException` hides. Use that loop for
   any future flow change — it takes seconds, a failed stack takes ten minutes.
2. **Connect accepts the qualified alias ARN** for the Lambda integration
   association. The warm path is real. Do not switch to `$LATEST`.
3. **The Lambda contract holds on the live alias.** Invoked three times with a
   Connect-shaped event for each of the three menu questions: flat scalar
   responses, `resolved: true`, `index_version=3801044e0734ead7`.
   First call on an instance: `total_ms=137` (it finishes the index load — see
   below). Every call after: `retrieval_ms=0`, billed 16–26 ms.
4. **Metrics land with the right dimensions.** `Retrieval.Success`,
   `Retrieval.LatencyMs`, `Index.LoadMs` all present in namespace `MossConnect`
   with `Surface=VoiceRetrieval, RetrievalArm=lexical, IndexVersion=…`. All three
   alarms `OK`.

**NOT verified: an actual phone call.** Nobody has dialled `+1 686 210 3817`
since the flow went live. The flow runs `UpdateContactTextToSpeechVoice`,
`GetParticipantInput`, `Compare` on `$.External.resolved`, and
`TransferContactToQueue` for real for the first time on that call. That is the
next thing to do, and the most likely place for a surprise.

## Two things the test call will show you

**Pressing 1 (refunds) reads back the password-reset answer.** The corpus says
"Refunds can be requested"; the menu query says "request a refund"; the lexical
stub does no stemming, so the token overlap is zero and three unrelated documents
tie at 0.3333. This is a *known labeled miss* in `bench/questions.json` and part
of the documented recall@1 = 50%. It was left alone deliberately: tuning the
control arm to pass the demo would make the benchmark dishonest. Options, in
order of preference: (a) wire the `moss` arm, which is what the demo is for;
(b) accept it and narrate it — it is a vivid illustration of why lexical fails;
(c) add stemming to the stub *and* re-run and re-document the benchmark numbers.
Do not do (c) quietly.

**Pressing 2 and 3 work** (shipping-standard at 0.64, order-change-address at 0.78).

## Surprise worth knowing: init does not wait for the index

`INIT_REPORT` shows ~350 ms for the voice Lambda, but the index load is a
module-scope *promise*, not a top-level await. Lambda freezes the sandbox when
the module finishes evaluating, so the S3 fetch completes during the **first
invocation** on each provisioned instance — that is where the 137 ms first-call
number comes from. Two consequences:

- The first real call on each of the 2 provisioned instances pays ~120 ms extra
  and emits `Retrieval.Slow`. Later calls are genuinely warm.
- It is also why seeding the index *after* provisioning worked: the pending
  fetch ran after the manifest existed. Had the fetch settled during init, both
  instances would have been poisoned with `index_unavailable` until recycled.

Fix, when wanted: bundle as ESM (`format: 'esm'`) and `await` the warmup at top
level so init blocks until the index is loaded. Then provisioned concurrency
really does pre-load the index, and a missing manifest fails init loudly
instead of quietly degrading. Not done in this session — it changes the
bundling of all three handlers and deserves its own diff.

## Surface 3 is inert

`callRecordings: false` in `cdk.json` (trackit-demo already had a
`CALL_RECORDINGS` storage config; a second is rejected 409). Contact Lens
post-call output therefore lands in whatever bucket the *existing* config names,
never in our `AnalysisBucket`, so `post-call-index.ts` **never runs**. Nothing
errors. Repoint that storage config by hand (console, or
`associate-instance-storage-config` after disassociating the old one) if you
want the index to grow from real calls.

## Next steps, in order

1. **Dial `+1 686 210 3817`.** Press 2 or 3 for a good answer, 1 for the miss.
   Then check `Retrieval.Success` ticked and the CTR carries
   `retrievalArm=lexical`.
2. **Create an agent login** if you want escalation (digit 1, timeout, or a
   miss) to reach a human. Routing profile `moss-connect-agents` and the queue
   exist; no users do. Without one the caller sits in the default customer queue.
3. **Top-level-await the index load** (above).
4. **Wire the `moss` arm.** `docs/MOSS_QUESTIONS.md` is the list for the
   design-partner call.

## How to redeploy / reseed

```bash
export AWS_PROFILE=hermes          # resolves to 184670915146
npm run cdk:diff                   # read the [-] lines
npm run cdk:deploy                 # needs a TTY to approve IAM changes
npm run seed-index -- --force      # replaces the live manifest; artifact first
```

Switching the number between arms is one CLI call; see `docs/DEPLOY.md` §2.

## Open items (unchanged)

- `cloudwatch:PutMetricData` on `*`; scope with `cloudwatch:namespace`.
- Bootstrap uses `AdministratorAccess` as the execution policy.
- `local-embed` arm unverified since the package swap.
- Benchmark is single-arm and the 14-doc corpus is too easy (`local-embed`
  scores 100%); a ~100k-document corpus is the highest-value missing piece.

## Three accounts — do not mix them up

| Account | What |
|---|---|
| `184670915146` | **This project.** Profile `hermes`. |
| `394125495069` | Default profile `gavin`. An earlier `cdk diff` targeted this by mistake. |
| `576872909007` | `claude-sandbox`, the `jarvis` project. Unrelated. |

**Amazon Connect does not exist in `us-east-2`.** The synth fails closed on it.
