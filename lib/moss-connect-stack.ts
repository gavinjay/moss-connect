import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { loadConfig, type MossConnectConfig } from '../src/config/deploy-config';
import { AgentAssist } from './constructs/agent-assist';
import { IndexStore } from './constructs/index-store';
import { PostCallIndex } from './constructs/post-call-index';
import { VoiceRetrieval } from './constructs/voice-retrieval';

export interface MossConnectStackProps extends StackProps {
  readonly config: MossConnectConfig;
}

export class MossConnectStack extends Stack {
  constructor(scope: Construct, id: string, props: MossConnectStackProps) {
    super(scope, id, props);
    const { config } = props;

    const indexStore = new IndexStore(this, 'IndexStore', {
      retainOnDelete: config.indexStore.retainOnDelete,
    });

    const voice = new VoiceRetrieval(this, 'VoiceRetrieval', {
      connectInstanceArn: config.connectInstanceArn,
      indexBucket: indexStore.bucket,
      manifestKey: config.indexStore.manifestKey,
      latencyBudgetMs: config.voiceRetrieval.latencyBudgetMs,
      provisionedConcurrency: config.voiceRetrieval.provisionedConcurrency,
      memoryMb: config.voiceRetrieval.memoryMb,
      timeoutSeconds: config.voiceRetrieval.timeoutSeconds,
    });

    const postCall = new PostCallIndex(this, 'PostCallIndex', {
      indexBucket: indexStore.bucket,
      manifestKey: config.indexStore.manifestKey,
      analysisPrefix: 'Analysis/',
    });

    new CfnOutput(this, 'IndexBucketName', { value: indexStore.bucket.bucketName });
    new CfnOutput(this, 'VoiceRetrievalAliasArn', { value: voice.alias.functionArn });
    new CfnOutput(this, 'AnalysisBucketName', { value: postCall.analysisBucket.bucketName });

    if (config.contactLensRealtimeEnabled) {
      const assist = new AgentAssist(this, 'AgentAssist', {
        indexBucket: indexStore.bucket,
        manifestKey: config.indexStore.manifestKey,
        memoryMb: config.voiceRetrieval.memoryMb,
      });
      new CfnOutput(this, 'TranscriptStreamName', { value: assist.stream.streamName });
    }
  }
}

/** Reads cdk.json context. Exported so tests can build the stack the same way. */
export function stackConfig(scope: Construct): MossConnectConfig {
  return loadConfig(scope.node);
}
