import { Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { KinesisEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface AgentAssistProps {
  readonly indexBucket: s3.Bucket;
  readonly manifestKey: string;
  readonly memoryMb: number;
}

/**
 * Surface 2: Contact Lens real-time -> Kinesis -> retrieval -> suggestion.
 *
 * The stream is created here but NOT wired to Contact Lens by this stack:
 * enabling real-time analytics is a Connect instance / contact-flow setting, not
 * a CloudFormation resource. docs/DEPLOY.md covers the manual step. If that step
 * is skipped the Lambda simply never fires -- silent, so the alarm on
 * IteratorAge plus a smoke test is how you find out.
 */
export class AgentAssist extends Construct {
  public readonly stream: kinesis.Stream;
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: AgentAssistProps) {
    super(scope, id);

    this.stream = new kinesis.Stream(this, 'TranscriptStream', {
      streamMode: kinesis.StreamMode.ON_DEMAND,
      encryption: kinesis.StreamEncryption.MANAGED,
      retentionPeriod: Duration.hours(24),
    });

    this.fn = new NodejsFunction(this, 'Fn', {
      entry: 'src/handlers/agent-assist.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      memorySize: props.memoryMb,
      timeout: Duration.seconds(30),
      environment: {
        MOSS_INDEX_BUCKET: props.indexBucket.bucketName,
        MOSS_INDEX_MANIFEST_KEY: props.manifestKey,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: { minify: true, sourceMap: true, target: 'node24' },
    });

    props.indexBucket.grantRead(this.fn);
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['cloudwatch:PutMetricData'], resources: ['*'] }),
    );

    this.fn.addEventSource(
      new KinesisEventSource(this.stream, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        // A live call is worthless once it has ended -- never retry a stale batch
        // into a dead conversation.
        maxRecordAge: Duration.minutes(2),
        retryAttempts: 1,
        reportBatchItemFailures: true,
      }),
    );
  }
}
