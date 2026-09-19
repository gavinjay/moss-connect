import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type { RetrievalArmName } from '../../src/config/deploy-config';
import { buildDemoFlow, renderFlow } from '../../src/flows/flow-builder';
import { NAMESPACE } from '../../src/observability/metrics';

export interface VoiceRetrievalProps {
  readonly arm: RetrievalArmName;
  readonly connectInstanceArn: string;
  readonly escalationQueueArn: string;
  readonly indexBucket: s3.Bucket;
  readonly manifestKey: string;
  readonly latencyBudgetMs: number;
  readonly provisionedConcurrency: number;
  readonly memoryMb: number;
  readonly timeoutSeconds: number;
  readonly bedrockKnowledgeBaseId: string | null;
}

/**
 * One benchmark arm's complete voice path: Lambda, alias, Connect association
 * and its own contact flow.
 *
 * Deployed once per arm so each has an independent cold-start profile and its own
 * dialable flow. That is what makes the comparison legitimate -- and what lets
 * you switch arms mid-demo by dialing a different number or transferring flows,
 * rather than redeploying in front of an audience.
 */
export class VoiceRetrieval extends Construct {
  public readonly fn: NodejsFunction;
  public readonly alias: lambda.Alias;
  public readonly flow: connect.CfnContactFlow;

  constructor(scope: Construct, id: string, props: VoiceRetrievalProps) {
    super(scope, id);
    const { arm } = props;

    // The managed baseline holds no local index, so warming it buys nothing and
    // paying for provisioned concurrency on it would distort the cost comparison.
    const needsWarmth = arm !== 'bedrock-kb';

    this.fn = new NodejsFunction(this, 'Fn', {
      entry: 'src/handlers/voice-retrieval.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      // Memory buys CPU, and index hydration is CPU-bound. Undersizing shows up
      // as cold-start latency, not as an out-of-memory error. Identical across
      // arms on purpose: differing memory would measure Lambda, not retrieval.
      memorySize: props.memoryMb,
      timeout: Duration.seconds(props.timeoutSeconds),
      environment: {
        MOSS_RETRIEVAL_ARM: arm,
        MOSS_INDEX_BUCKET: props.indexBucket.bucketName,
        MOSS_INDEX_MANIFEST_KEY: props.manifestKey,
        MOSS_LATENCY_BUDGET_MS: String(props.latencyBudgetMs),
        ...(props.bedrockKnowledgeBaseId ? { MOSS_BEDROCK_KB_ID: props.bedrockKnowledgeBaseId } : {}),
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: { minify: true, sourceMap: true, target: 'node24' },
    });

    props.indexBucket.grantRead(this.fn);
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['cloudwatch:PutMetricData'], resources: ['*'] }),
    );
    if (arm === 'bedrock-kb') {
      this.fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['bedrock:Retrieve'],
          // Scoped to the one knowledge base under test.
          resources: props.bedrockKnowledgeBaseId
            ? [
                `arn:aws:bedrock:${process.env.CDK_DEFAULT_REGION ?? '*'}:*:knowledge-base/${props.bedrockKnowledgeBaseId}`,
              ]
            : ['*'],
        }),
      );
    }

    // Provisioned concurrency attaches to an alias, never $LATEST. Without this
    // the index load happens on a caller's first word.
    this.alias = new lambda.Alias(this, 'Live', {
      aliasName: 'live',
      version: this.fn.currentVersion,
      ...(needsWarmth && props.provisionedConcurrency > 0
        ? { provisionedConcurrentExecutions: props.provisionedConcurrency }
        : {}),
    });

    this.alias.addPermission('ConnectInvoke', {
      principal: new iam.ServicePrincipal('connect.amazonaws.com'),
      sourceArn: props.connectInstanceArn,
    });

    /**
     * OPEN QUESTION (docs/MOSS_QUESTIONS.md): we associate the ALIAS arn, since
     * invoking $LATEST would make provisioned concurrency useless. Confirm on
     * first deploy that Connect accepts a qualified ARN. If it rejects it,
     * associate `this.fn.functionArn` and accept cold starts -- but do NOT
     * silently switch, because that discards the warm path while every test
     * still passes and the benchmark would quietly measure the wrong thing.
     */
    new connect.CfnIntegrationAssociation(this, 'ConnectAssociation', {
      instanceId: props.connectInstanceArn,
      integrationType: 'LAMBDA_FUNCTION',
      integrationArn: this.alias.functionArn,
    });

    this.flow = new connect.CfnContactFlow(this, 'Flow', {
      instanceArn: props.connectInstanceArn,
      name: `moss-connect-${arm}`,
      description: `Retrieval demo flow -- ${arm} arm`,
      type: 'CONTACT_FLOW',
      content: renderFlow(
        buildDemoFlow({
          lambdaArn: this.alias.functionArn,
          arm,
          escalationQueueArn: props.escalationQueueArn,
          menu: DEMO_MENU,
        }),
      ),
    });

    this.addAlarms(arm, props.latencyBudgetMs);
  }

  private addAlarms(arm: RetrievalArmName, latencyBudgetMs: number): void {
    const dims = { Surface: 'VoiceRetrieval', RetrievalArm: arm };
    const metric = (name: string, stat = 'Sum') =>
      new cloudwatch.Metric({
        namespace: NAMESPACE,
        metricName: name,
        dimensionsMap: dims,
        statistic: stat,
        period: Duration.minutes(5),
      });

    const success = metric('Retrieval.Success');
    const fallback = metric('Retrieval.FallbackToAgent');

    // The +0.0001 keeps a zero-traffic period from reading as 100% failure.
    new cloudwatch.Alarm(this, 'HighFallbackRate', {
      alarmDescription:
        `[${arm}] escalating to a human more than 25% of the time -- self-service is ` +
        'not working, even though no errors are being thrown.',
      metric: new cloudwatch.MathExpression({
        expression: '100*(fallback/(fallback+success+0.0001))',
        usingMetrics: { fallback, success },
        period: Duration.minutes(5),
      }),
      threshold: 25,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'RetrievalOverBudget', {
      alarmDescription: `[${arm}] retrieval p99 exceeded the ${latencyBudgetMs}ms budget.`,
      metric: metric('Retrieval.LatencyMs', 'p99'),
      threshold: latencyBudgetMs,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'IndexLoadFailed', {
      alarmDescription: `[${arm}] index failed to load at init. Every call is escalating.`,
      metric: metric('Index.LoadFailed'),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}

/**
 * Canned questions behind a keypad menu.
 *
 * Deliberately not speech recognition: ASR adds 500-1500ms and substantial
 * variance, which would completely swamp the 10ms-vs-50ms retrieval difference
 * this project exists to show. A keypad makes the demo reproducible in front of
 * an audience and keeps the measured leg the one under test.
 */
export const DEMO_MENU = [
  { digit: '1', label: 'refunds', query: 'How do I request a refund?' },
  { digit: '2', label: 'shipping times', query: 'How long does standard shipping take?' },
  { digit: '3', label: 'order changes', query: 'Can I change the address on an order already placed?' },
] as const;
