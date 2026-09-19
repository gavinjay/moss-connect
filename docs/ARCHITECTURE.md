# Architecture

## The constraint everything follows from

Moss returns results in single-digit milliseconds **because the index is in the
same process as the caller**. That is the product. Any topology that puts a
network hop between the agent and the index gives up the entire advantage — and
does so invisibly: the calls still connect, the tests still pass, the answers are
still correct. Only the latency, the thing you bought, is gone.

So the invariant is mechanical rather than aspirational:

```
MossRetriever.load()      may be slow.   Runs once, at init.
MossRetriever.retrieve()  does no I/O.   Runs on the hot path.
```

`src/moss/retriever.ts` states it; the handlers structure themselves around it by
loading at module scope; `src/__tests__/stack.test.ts` pins the alias-based
provisioned concurrency that makes warm instances real.

## Index distribution

One writer, one source of truth for "which index is live".

```
Contact Lens analysis (S3)
        │
        ▼
post-call-index Lambda ──── builds ────▶ indexes/<version>.json   (content-addressed)
        │                                        │
        └──── then writes ────▶ manifests/current.json ───────────┘
                                         │
              ┌──────────────────────────┴───────────────────────┐
              ▼                                                  ▼
   voice-retrieval Lambda                              agent-assist consumer
   (resolves manifest at init)                          (Lambda today, browser later)
```

Design notes:

- **Content-addressed versions.** The version is the first 16 hex of the artifact
  SHA-256, so an unchanged corpus produces an unchanged version and a no-op
  rebuild cannot churn the live pointer.
- **Artifact before manifest, always.** A manifest naming an object that does not
  exist yet takes every consumer down on its next cold start.
- **S3 versioning on the index bucket.** Rolling back a bad index means repointing
  the manifest at the previous version, which has to still be there. Rebuilding is
  not a rollback.
- **Every served response carries `indexVersion`.** A bad answer has to be
  attributable to a specific index, or you are debugging a ghost.

## Surface 1 — self-service voice retrieval

```
caller ──▶ Connect contact flow ──▶ InvokeLambdaFunction ──▶ voice-retrieval
                  ◀── answer / escalate flag ──────────────────────┘
```

Two hard Connect constraints drive the code:

1. **The response must be flat.** String keys → scalar values. One nested object
   or array and Connect rejects the whole response and routes the contact down the
   flow's error branch. Nested retrieval results are the natural output, so this is
   exactly where it breaks — hence `flattenForConnect()` and
   `assertConnectResponse()` in `src/handlers/connect-contract.ts`.
2. **8-second hard ceiling.** The Lambda timeout is configured below it so the
   handler returns a deliberate `escalate: true` rather than letting Connect time
   out with no context.

The handler never throws at Connect. Every failure path returns
`{ resolved: false, escalate: true, reason }` **and emits a metric**, because a
caught error that only logs is a contact center that quietly stops deflecting
calls.

## Surface 2 — real-time agent assist

Shipped topology:

```
Contact Lens real-time ──▶ Kinesis ──▶ agent-assist Lambda ──▶ retrieval ──▶ publish
```

**The better topology, not yet built.** Moss compiles to WASM and runs natively in
a browser. Holding the index in the *agent's browser* and retrieving against the
live transcript locally is zero-hop — the actual Moss pitch — while the path above
pays a Kinesis hop plus a publish hop to reach the agent. It will never match the
browser path's numbers.

The server-side version ships first because it works with any agent workspace and
needs no front-end decision. Before extending it, read questions 10–12 in
`docs/MOSS_QUESTIONS.md`: bundle size and WASM init time decide whether the
browser path is viable, and the answer changes where this code should live.

`SuggestionPublisher` is left injectable because where suggestions go depends on
the agent workspace (a Connect 3p app, a custom CCP over Amazon Connect Streams,
an AppSync subscription) and that has not been chosen.

Only **customer** speech feeds retrieval. Indexing the agent's own words creates a
loop where the assistant re-suggests whatever the agent just read aloud.

Batches are dropped rather than retried forever (`maxRecordAge: 2 min`): a
suggestion is worthless once the call has ended, and a poison record must not wedge
the shard.

## Surface 3 — post-call enrichment

Pairs each customer question with the agent reply that followed it. The useful unit
of retrieval is *"what was asked and what worked"* — a question indexed alone
teaches the assistant to echo the question back.

Raw transcripts live in a **separate bucket** from index artifacts: transcripts are
customer PII on a retention clock, index artifacts are derived build output. One
lifecycle policy cannot serve both.

## Observability

Every degradation path has a metric in the `MossConnect` namespace and an alarm
(`src/observability/metrics.ts`). The alarm namespace is asserted against the
emitted namespace in the stack test, because an alarm watching a metric nobody
emits stays green forever and reads as proof of health.

`HighFallbackRate` uses `100*(fallback/(fallback+success+0.0001))` — the epsilon
keeps a zero-traffic period from evaluating as 100% failure.
