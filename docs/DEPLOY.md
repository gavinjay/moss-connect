# Deploy runbook

## Pick the right account FIRST

Three AWS accounts are in play and only one is correct:

| Account | What it is |
|---|---|
| `184670915146` | **This project.** Where the `trackit-demo` Connect instance lives. |
| `394125495069` | A different account these credentials may default to. |
| `576872909007` | The `jarvis` sandbox. Nothing to do with this project. |

The target account is derived from `connect.existingInstanceArn` in `cdk.json`,
never from `CDK_DEFAULT_ACCOUNT`. If your credentials are for a different account
the synth **fails** with both numbers printed, rather than quietly building a
cross-account stack. An earlier version did exactly that: `cdk diff` reported
`Stack ConnectFoundationStack (aws://394125495069/us-west-2)` while every Connect
reference pointed at `184670915146`, and nothing complained.

Check it with one command, which substitutes nothing by hand:

```bash
# `git -C` works from any directory -- no cd that can fail and swallow the pull.
git -C ~/moss-connect pull
cd ~/moss-connect
npm install

# Prints the target account and, if your credentials are wrong, lists YOUR real
# profile names with the account each resolves to plus the exact export line.
npm run preflight
```

Once preflight says OK:

```bash
npm run cdk:diff     # preflight runs again automatically first
npm run cdk:deploy
```

## Region

**`us-west-2`.** Amazon Connect does not exist in `us-east-2`. Set it explicitly
every time — the shell's `AWS_REGION` is routinely pointed somewhere else:

```bash
export AWS_PROFILE="$MOSS_PROFILE"
export AWS_REGION=us-west-2
```

## What you must decide before deploying

Only two values, both in `cdk.json`:

1. **`connect.instanceAlias`** — globally unique across all of AWS. Blank by
   design; the synth refuses until you choose one. A collision fails the deploy
   several minutes in, so pick something distinctive.
2. **`benchmark.arms`** — which arms to deploy. `bedrock-kb` additionally needs
   `benchmark.bedrockKnowledgeBaseId`, and the synth refuses if it is missing.

Then bootstrap, if you have not already:

```bash
npx cdk bootstrap aws://184670915146/us-west-2
```

## Deploy

```bash
npm install
npm run typecheck
npm test                 # must be green; includes a full two-stack synth
npm run cdk:synth
npm run cdk:diff         # READ THE [-] LINES.
npm run cdk:deploy       # foundation first, then the app stack
```

Foundation takes several minutes — Connect instance creation is slow. Record the
outputs: `DemoPhoneNumber`, `ConnectInstanceArn`, `EscalationQueueArn`,
`ConnectConsoleUrl`, then the app stack's `Arm*FlowArn` and `Arm*AliasArn`.

## Still manual after deploy

### 1. Seed an index

Nothing retrieves until an index and manifest exist. The in-process arms' init
fails, emits `Index.LoadFailed`, and every call escalates — designed behaviour, but
a fresh stack deflects nothing. `bench/corpus.json` is a reasonable first corpus.

Upload the **artifact first, manifest second**. A manifest naming a missing object
breaks every consumer's next cold start.

### 2. Point the phone number at an arm's flow

The flows are created; associating the claimed number with one of them is a
console step (or `associate-phone-number-contact-flow`). Point it at whichever arm
you are demonstrating — that is how you switch arms mid-demo without redeploying.

### 3. Create an agent login

`ConnectFoundationStack` builds the routing profile and queue but no users. Create
one agent in the console to exercise escalation and agent assist.

### 4. Bedrock Knowledge Base, if running that arm

Not created by this stack: its OpenSearch Serverless vector index is not a
CloudFormation resource, so it needs the console or a custom resource. Create it,
ingest the same corpus as the other arms — a different corpus measures nothing —
then put its id in `cdk.json`.

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
