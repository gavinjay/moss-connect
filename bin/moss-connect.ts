#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { ConnectFoundationStack } from '../lib/connect-foundation-stack';
import { MossConnectStack, stackConfig } from '../lib/moss-connect-stack';
import { applyTrackItTags } from '../lib/tagging';

const app = new App();
const config = stackConfig(app);

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  // Region comes from cdk.json, NOT from CDK_DEFAULT_REGION. The shell's
  // AWS_REGION is routinely wrong here: the sibling `jarvis` project deploys to
  // us-east-2, where Amazon Connect does not exist. assertConnectRegion() in
  // src/config/regions.ts fails the synth rather than letting that through.
  region: config.region,
};

// Deployed once and left alone: instance, phone number, queue. Separate from the
// application stack so iterating on a Lambda cannot roll back the demo line.
const foundation = new ConnectFoundationStack(app, 'ConnectFoundationStack', {
  env,
  connectConfig: config.connect,
  description: 'Amazon Connect instance, phone number and routing for the Moss benchmark',
});

const appStack = new MossConnectStack(app, 'MossConnectStack', {
  env,
  config,
  connectInstanceArn: foundation.instanceArn,
  escalationQueueArn: foundation.escalationQueueArn,
  description: 'Moss retrieval arms, index store and contact flows',
});
appStack.addDependency(foundation);

// Applied at app scope so it propagates to every child construct in both stacks.
applyTrackItTags(app, config.tags);

app.synth();
