#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { MossConnectStack, stackConfig } from '../lib/moss-connect-stack';
import { applyTrackItTags } from '../lib/tagging';

const app = new App();
const config = stackConfig(app);

new MossConnectStack(app, 'MossConnectStack', {
  config,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // Region comes from cdk.json, NOT from CDK_DEFAULT_REGION. The shell's
    // AWS_REGION is routinely wrong here: the sibling `jarvis` project deploys
    // to us-east-2, where Amazon Connect does not exist. assertConnectRegion()
    // in src/config/regions.ts fails the synth rather than letting that through.
    region: config.region,
  },
  description: 'Amazon Connect <-> Moss: sub-10ms semantic retrieval for contact-center voice agents',
});

// Applied at app scope so it propagates to every child construct.
applyTrackItTags(app, config.tags);

app.synth();
