# Deploy runbook

## Region

**`us-west-2`.** Amazon Connect does not exist in `us-east-2`. Set it explicitly
every time — the shell's `AWS_REGION` is routinely pointed somewhere else:

```bash
export AWS_PROFILE=claude-sandbox
export AWS_REGION=us-west-2
```

## One-time prerequisites (manual — not CloudFormation)

These cannot be created by this stack, and skipping them produces silence rather
than an error.

1. **An Amazon Connect instance** in `us-west-2`. Note its ARN.
2. **Put the instance ARN in `cdk.json`** under
   `context.mossConnect.connectInstanceArn`. The synth fails until you do — by
   design. Do **not** pass it with `-c`: a value that only exists on one machine
   is a value the next deploy drops silently.
3. **CDK bootstrap** in the target account/region, if not already done:
   ```bash
   npx cdk bootstrap aws://576872909007/us-west-2
   ```

## Deploy

```bash
npm install
npm run typecheck
npm test                 # must be green; includes a full stack synth
npm run cdk:synth
npm run cdk:diff         # READ THE [-] LINES. Both of this codebase's
                         # predecessors shipped a silent regression that was
                         # invisible in code review and obvious in one diff.
npm run cdk:deploy
```

Record the stack outputs: `IndexBucketName`, `VoiceRetrievalAliasArn`,
`AnalysisBucketName`, `TranscriptStreamName`.

## Post-deploy wiring (also manual)

### 1. Seed an index

Nothing retrieves until an index and a manifest exist. The voice Lambda's init
fails, emits `Index.LoadFailed`, and every call escalates — which is the designed
behaviour, not a bug, but it means a fresh stack deflects nothing.

Build a first index from a document set, upload the artifact, then the manifest
(artifact **first** — a manifest naming a missing object breaks every consumer's
next cold start).

### 2. Author the contact flow

Add an **Invoke AWS Lambda function** block pointing at the
`VoiceRetrievalAliasArn` output, and pass the caller's utterance as the `query`
parameter.

Read the result in the flow as:

- `$.External.resolved` — `true` when there is a confident answer
- `$.External.answer` — the text to read out
- `$.External.escalate` — `true` when it should route to a human
- `$.External.index_version`, `$.External.retrieval_ms` — for debugging a bad answer

Branch on `escalate` before playing `answer`.

### 3. Enable Contact Lens real-time (only for agent assist)

Real-time analytics is a **contact-flow / instance setting**, not a CFN resource.
Enable it on the instance and set the flow's analytics block to stream to the
`TranscriptStreamName` output.

If this step is skipped the agent-assist Lambda simply never fires. There is no
error. Confirm with a test call and check the Lambda's invocation count.

### 4. Point Contact Lens post-call output at the analysis bucket

Post-call analysis must land under the `Analysis/` prefix of the
`AnalysisBucketName` bucket, with a `.json` suffix, or the S3 notification will
not match and no index ever gets rebuilt.

## Verifying it actually works

A green deploy proves nothing about retrieval. Check, in order:

1. **Index loaded** — voice Lambda logs show no `Index.LoadFailed`; CloudWatch has
   `MossConnect / Retrieval.Success` with `Surface=VoiceRetrieval`.
2. **Metrics exist with the right dimensions** — confirm the metric name,
   namespace *and* dimension set are present in live CloudWatch. An alarm on a
   metric nobody emits stays green forever.
3. **Warm path is real** — invoke twice and compare `total_ms`. If the second call
   is not dramatically faster, provisioned concurrency is not attached to the alias
   Connect is invoking, and the entire latency premise is broken.
4. **Flat-response contract** — make a real call through the flow, not just a
   Lambda test invoke. A nested response is rejected by Connect and by nothing else.

## Rollback

Repoint `manifests/current.json` at the previous `indexes/<version>.json`. The
index bucket is versioned so previous artifacts still exist. Consumers pick it up
on their next cold start — force it by publishing a new alias version if you need
it immediately.

Rebuilding the index is **not** a rollback.
