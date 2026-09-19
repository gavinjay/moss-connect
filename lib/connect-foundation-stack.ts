import { ArnFormat, CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import { Construct } from 'constructs';
import type { ConnectFoundationConfig } from '../src/config/deploy-config';

export interface ConnectFoundationStackProps extends StackProps {
  readonly connectConfig: ConnectFoundationConfig;
}

/**
 * The slow, stateful half of the deployment: the Connect instance itself, its
 * phone number, and the routing skeleton an escalation needs.
 *
 * WHY THIS IS A SEPARATE STACK
 * ----------------------------
 * Connect instances take minutes to create and delete, deleted aliases linger,
 * and a claimed phone number is a real billed resource you do not want to lose.
 * Keeping them out of the fast-iterating application stack means a rolled-back
 * Lambda change cannot take the demo line with it. Deploy this once; then
 * iterate on MossConnectStack freely.
 */
export class ConnectFoundationStack extends Stack {
  /** ARN of the instance, whether created here or adopted from config. */
  public readonly instanceArn: string;
  /** Bare instance id -- several Connect APIs want this rather than the ARN. */
  public readonly instanceId: string;
  public readonly escalationQueueArn: string;

  constructor(scope: Construct, id: string, props: ConnectFoundationStackProps) {
    super(scope, id, props);
    const cfg = props.connectConfig;

    let instance: connect.CfnInstance | undefined;
    if (cfg.existingInstanceArn) {
      this.instanceArn = cfg.existingInstanceArn;
      this.instanceId = Stack.of(this).splitArn(cfg.existingInstanceArn, ArnFormat.SLASH_RESOURCE_NAME)
        .resourceName!;
    } else {
      instance = new connect.CfnInstance(this, 'Instance', {
        // Globally unique across AWS. A collision fails the deploy minutes in.
        instanceAlias: cfg.instanceAlias,
        identityManagementType: 'CONNECT_MANAGED',
        attributes: {
          inboundCalls: cfg.inboundCalls,
          outboundCalls: cfg.outboundCalls,
          // Required for the agent-assist surface; also what produces the
          // post-call analysis the index is rebuilt from.
          contactflowLogs: true,
          contactLens: true,
          autoResolveBestVoices: true,
        },
      });
      this.instanceArn = instance.attrArn;
      this.instanceId = instance.attrId;
    }

    const hours = new connect.CfnHoursOfOperation(this, 'Hours', {
      instanceArn: this.instanceArn,
      name: 'moss-connect-always-open',
      description: 'Always open -- this is a demo and benchmark instance',
      timeZone: 'America/Los_Angeles',
      config: (['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const).map(
        (day) => ({
          day,
          startTime: { hours: 0, minutes: 0 },
          endTime: { hours: 23, minutes: 59 },
        }),
      ),
    });

    // Retrieval that cannot answer confidently transfers here rather than
    // reading out a low-confidence guess.
    const queue = new connect.CfnQueue(this, 'EscalationQueue', {
      instanceArn: this.instanceArn,
      name: 'moss-connect-escalation',
      description: 'Calls the retrieval path could not answer confidently',
      hoursOfOperationArn: hours.attrHoursOfOperationArn,
    });
    this.escalationQueueArn = queue.attrQueueArn;

    new connect.CfnRoutingProfile(this, 'RoutingProfile', {
      instanceArn: this.instanceArn,
      name: 'moss-connect-agents',
      description: 'Agents handling escalations and exercising agent assist',
      defaultOutboundQueueArn: queue.attrQueueArn,
      mediaConcurrencies: [{ channel: 'VOICE', concurrency: 1 }],
      queueConfigs: [
        {
          queueReference: { channel: 'VOICE', queueArn: queue.attrQueueArn },
          priority: 1,
          delay: 0,
        },
      ],
    });

    if (cfg.phoneNumber.enabled) {
      // A real billed resource: US DID is roughly $1/month plus per-minute
      // inbound. Claimed here so the demo line is reproducible rather than
      // hand-clicked, but it is the one resource in this stack that costs money
      // whether or not anyone calls it.
      const number = new connect.CfnPhoneNumber(this, 'DemoNumber', {
        targetArn: this.instanceArn,
        countryCode: cfg.phoneNumber.countryCode,
        type: cfg.phoneNumber.type,
        description: cfg.phoneNumber.description,
      });
      new CfnOutput(this, 'DemoPhoneNumber', {
        value: number.attrAddress,
        description: 'Call this number to reach the demo flow',
      });
    }

    new CfnOutput(this, 'ConnectInstanceArn', { value: this.instanceArn });
    new CfnOutput(this, 'ConnectInstanceId', { value: this.instanceId });
    new CfnOutput(this, 'EscalationQueueArn', { value: this.escalationQueueArn });
    if (instance) {
      new CfnOutput(this, 'ConnectConsoleUrl', {
        value: `https://${cfg.instanceAlias}.my.connect.aws/`,
        description: 'Agent workspace / admin console for the created instance',
      });
    }
  }
}
