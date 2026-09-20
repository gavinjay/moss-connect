import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import { Construct } from 'constructs';
import { loadConfig, type MossConnectConfig } from '../src/config/deploy-config';
import { AgentAssist } from './constructs/agent-assist';
import { IndexStore } from './constructs/index-store';
import { PostCallIndex } from './constructs/post-call-index';
import { VoiceRetrieval } from './constructs/voice-retrieval';

export interface MossConnectStackProps extends StackProps {
  readonly config: MossConnectConfig;
  readonly connectInstanceArn: string;
  readonly escalationQueueArn: string;
}

/**
 * The fast-iterating half: retrieval Lambdas, index storage, contact flows and
 * the Contact Lens plumbing. Safe to redeploy repeatedly -- the Connect instance
 * and phone number live in ConnectFoundationStack precisely so a rollback here
 * cannot take the demo line down.
 */
export class MossConnectStack extends Stack {
  constructor(scope: Construct, id: string, props: MossConnectStackProps) {
    super(scope, id, props);
    const { config, connectInstanceArn, escalationQueueArn } = props;

    const indexStore = new IndexStore(this, 'IndexStore', {
      retainOnDelete: config.indexStore.retainOnDelete,
    });

    // One complete voice path per benchmark arm: own Lambda, own cold-start
    // profile, own dialable flow. Switching arms mid-demo is a flow change, not
    // a redeploy.
    const arms = config.benchmark.arms.map((arm) => {
      const surface = new VoiceRetrieval(this, `Voice-${arm}`, {
        arm,
        connectInstanceArn,
        escalationQueueArn,
        indexBucket: indexStore.bucket,
        manifestKey: config.indexStore.manifestKey,
        latencyBudgetMs: config.voiceRetrieval.latencyBudgetMs,
        provisionedConcurrency: config.voiceRetrieval.provisionedConcurrency,
        memoryMb: config.voiceRetrieval.memoryMb,
        timeoutSeconds: config.voiceRetrieval.timeoutSeconds,
        bedrockKnowledgeBaseId: config.benchmark.bedrockKnowledgeBaseId,
      });
      new CfnOutput(this, `Arm${arm.replace(/[^A-Za-z0-9]/g, '')}AliasArn`, {
        value: surface.alias.functionArn,
        description: `Retrieval Lambda alias for the ${arm} arm -- benchmark target`,
      });
      new CfnOutput(this, `Arm${arm.replace(/[^A-Za-z0-9]/g, '')}FlowArn`, {
        value: surface.flow.attrContactFlowArn,
        description: `Contact flow exercising the ${arm} arm`,
      });
      return surface;
    });

    const postCall = new PostCallIndex(this, 'PostCallIndex', {
      indexBucket: indexStore.bucket,
      manifestKey: config.indexStore.manifestKey,
      analysisPrefix: 'Analysis/',
    });

    // Connect allows exactly ONE storage config per resource type per instance.
    // An instance created in the console already has CALL_RECORDINGS, and adding
    // a second returns 409 AlreadyExists and fails the whole stack -- which is
    // exactly what happened on the first real deploy against trackit-demo.
    if (config.connect.storageConfigs.callRecordings) {
      new connect.CfnInstanceStorageConfig(this, 'CallRecordingStorage', {
        instanceArn: connectInstanceArn,
        resourceType: 'CALL_RECORDINGS',
        storageType: 'S3',
        s3Config: {
          bucketName: postCall.analysisBucket.bucketName,
          bucketPrefix: 'Analysis',
        },
      });
    }

    const assist = new AgentAssist(this, 'AgentAssist', {
      indexBucket: indexStore.bucket,
      manifestKey: config.indexStore.manifestKey,
      memoryMb: config.voiceRetrieval.memoryMb,
    });

    // Real-time analytics streaming. The flow must ALSO enable analytics
    // (flow-builder.ts does) -- this config alone is not enough, and neither is
    // the flow alone. Miss either and the agent-assist Lambda simply never fires.
    if (config.connect.storageConfigs.realtimeAnalytics) {
      new connect.CfnInstanceStorageConfig(this, 'RealtimeAnalyticsStorage', {
        instanceArn: connectInstanceArn,
        resourceType: 'REAL_TIME_CONTACT_ANALYSIS_VOICE_SEGMENTS',
        storageType: 'KINESIS_STREAM',
        kinesisStreamConfig: { streamArn: assist.stream.streamArn },
      });
    }

    new CfnOutput(this, 'IndexBucketName', { value: indexStore.bucket.bucketName });
    new CfnOutput(this, 'AnalysisBucketName', { value: postCall.analysisBucket.bucketName });
    new CfnOutput(this, 'TranscriptStreamName', { value: assist.stream.streamName });
    new CfnOutput(this, 'DeployedArms', { value: config.benchmark.arms.join(',') });
    new CfnOutput(this, 'ArmCount', { value: String(arms.length) });
  }
}

/** Reads cdk.json context. Exported so tests build the stack the same way. */
export function stackConfig(scope: Construct): MossConnectConfig {
  return loadConfig(scope.node);
}
