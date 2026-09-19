#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { ConnectFoundationStack } from '../lib/connect-foundation-stack';
import { MossConnectStack, stackConfig } from '../lib/moss-connect-stack';
import { applyTrackItTags } from '../lib/tagging';

const app = new App();
const config = stackConfig(app);

/**
 * Account and region both come from configuration, never from the shell.
 *
 * CDK_DEFAULT_ACCOUNT reflects whichever credentials happen to be loaded. Using
 * it meant a `cdk diff` synthesized both stacks into the credential account
 * while every Connect reference pointed at the account in the instance ARN --
 * a cross-account stack that synthesized cleanly and would have half-deployed.
 * That is the "right in one account, wrong in the next" failure this project
 * exists downstream of, so the mismatch is now fatal at synth.
 */
const credentialAccount = process.env.CDK_DEFAULT_ACCOUNT;
if (config.account && credentialAccount && config.account !== credentialAccount) {
  throw new Error(
    `Account mismatch.\n` +
      `  This deployment targets : ${config.account} (from the Connect instance ARN)\n` +
      `  Your credentials are for: ${credentialAccount}\n\n` +
      'Deploying would create resources in the credential account while pointing them at a\n' +
      'Connect instance in another. Switch profile to one for ' +
      `${config.account}, e.g.\n` +
      `  export AWS_PROFILE=$(aws configure list-profiles | head -1)   # pick the right one\n` +
      '  aws sts get-caller-identity   # confirm Account matches before deploying',
  );
}
if (!config.account && !credentialAccount) {
  throw new Error(
    'No target account. Either set connect.existingInstanceArn in cdk.json (the account is ' +
      'read from it), or set mossConnect.account explicitly.',
  );
}

const env = {
  account: config.account ?? credentialAccount,
  // Region comes from cdk.json, NOT CDK_DEFAULT_REGION. The shell's AWS_REGION is
  // routinely wrong here: the sibling `jarvis` project deploys to us-east-2, where
  // Amazon Connect does not exist.
  region: config.region,
};

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
appStack.addStackDependency(foundation);

applyTrackItTags(app, config.tags);

app.synth();
