# Open questions for the Moss team

We are a design partner, so asking is cheap and guessing is expensive. Nothing in
this repo fabricates a Moss API call; every unknown is listed here instead.

Ordered by how much of the architecture each answer moves.

## Blocking — the design depends on these

1. **Can a prebuilt index be loaded from raw bytes?**
   The Lambda pulls index bytes from S3 during init and hydrates in-process. If the
   SDK can only build an index from source documents at runtime, cold start becomes
   a build, and the whole warm-instance design changes.
   → `MossSdkBindings.createIndex(source)` in `src/moss/sdk-retriever.ts`

2. **Does the Node/WASM runtime initialise with no network access?**
   The retrieval Lambda should not need egress. If WASM init or a license check
   phones home, that is a VPC/NAT conversation and a new failure mode on every
   cold start.

3. **Is one index instance safe to reuse across concurrent invocations?**
   A Lambda container serves one request at a time, but the browser agent-assist
   path is genuinely concurrent. Need to know whether a single index handle is
   re-entrant or whether each caller needs its own.

4. **Peak RSS for an index of N documents.**
   Drives Lambda `memorySize`, which drives CPU, which drives cold-start time.
   Ballpark for 1k / 10k / 100k documents would let us size this properly instead
   of guessing at 2048MB.

5. **Index artifact size on disk for the same N.**
   Lambda deployment packages cap at 250MB unzipped, and a layer shares that
   budget. Above that we need EFS or an init-time S3 fetch (currently S3 fetch).

## Score semantics

6. **What is the score's range and direction?** Is higher better, is it bounded
   0..1, and is it comparable *across index versions*? Our `minScore` threshold
   (currently 0.25 for voice, 0.3 for agent assist) decides whether a caller hears
   an answer or gets escalated. If scores shift between index builds, a rebuild
   silently changes escalation rates.

7. **Is there a calibrated "no good answer" signal?** Thresholding a similarity
   score is a blunt instrument for "we don't know". A confidence signal would be
   better than us picking a number.

## Latency verification

8. **What does sub-10ms measure?** Retrieval only, or including embedding of the
   query text? If the query has to be embedded first, where does that happen and
   what does it cost?

9. **Do you have numbers on a Lambda-class CPU?** The sub-10ms figure presumably
   comes from a real machine. Lambda at 2048MB is ~1.2 vCPU. Worth knowing how
   much of the claim survives.

## Browser path (the differentiated version of agent assist)

10. **What is the browser bundle size and WASM init time?** The best agent-assist
    topology holds the index in the agent's browser — zero hops, which is the
    whole pitch. That only works if init is fast enough for an agent opening their
    workspace at shift start.

11. **Can the browser and a Lambda share one index artifact?** We currently plan
    one artifact in S3 consumed by both. If the formats diverge we need two build
    outputs and a way to keep them in step.

12. **Incremental index updates:** the site says "instant index updates". Does that
    mean patching a loaded index in place? If so, the agent-assist browser path can
    stay warm across a rebuild instead of reloading.

## Operational

13. **Licensing / auth model for self-hosted use** — per-seat, per-index, offline?
    Affects whether the retrieval Lambda needs any credential at all.

14. **Version pinning and compatibility:** does an index built by SDK vX load in
    SDK vY? Our manifest is content-addressed but records no SDK version — it
    should, if this matters.

---

## Amazon Connect side — verify on first deploy, not with Moss

- **Does `AWS::Connect::IntegrationAssociation` accept a qualified (alias) ARN?**
  We associate the alias so provisioned concurrency is actually used. If Connect
  rejects it, do **not** silently fall back to `$LATEST` — that discards the warm
  path while every test still passes. See `lib/constructs/voice-retrieval.ts`.
- **Contact Lens real-time segment field names.** `src/handlers/contact-lens-contract.ts`
  is modelled from the documented payload; Contact Lens has versioned this shape
  before. Confirm against a live stream.
