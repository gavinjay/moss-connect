import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import { Construct } from 'constructs';

export interface PostCallIndexProps {
  readonly indexBucket: s3.Bucket;
  readonly manifestKey: string;
  /** Prefix Contact Lens writes post-call analysis under. */
  readonly analysisPrefix: string;
}

/**
 * Surface 3: post-call analysis -> Moss documents -> new versioned index.
 *
 * The transcript bucket is separate from the index bucket on purpose: raw call
 * transcripts are customer PII with a retention clock, while index artifacts are
 * derived build output. One lifecycle policy cannot serve both.
 */
export class PostCallIndex extends Construct {
  public readonly analysisBucket: s3.Bucket;
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: PostCallIndexProps) {
    super(scope, id);

    this.analysisBucket = new s3.Bucket(this, 'AnalysisBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'transcript-retention',
          // Raw transcripts are PII. Derived index artifacts outlive them.
          expiration: Duration.days(400),
        },
      ],
    });

    this.fn = new NodejsFunction(this, 'Fn', {
      entry: 'src/handlers/post-call-index.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 1024,
      timeout: Duration.minutes(5),
      environment: {
        MOSS_INDEX_BUCKET: props.indexBucket.bucketName,
        MOSS_INDEX_MANIFEST_KEY: props.manifestKey,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: { minify: true, sourceMap: true, target: 'node20' },
    });

    this.analysisBucket.grantRead(this.fn);
    // The only writer of the index bucket and its manifest.
    props.indexBucket.grantWrite(this.fn);
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['cloudwatch:PutMetricData'], resources: ['*'] }),
    );

    this.analysisBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(this.fn),
      { prefix: props.analysisPrefix, suffix: '.json' },
    );
  }
}
