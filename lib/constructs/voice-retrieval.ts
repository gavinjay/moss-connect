import { Duration, Stack } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { NAMESPACE } from '../../src/observability/metrics';

export interface VoiceRetrievalProps {
  readonly connectInstanceArn: string;
  readonly indexBucket: s3.Bucket;
  readonly manifestKey: string;
  readonly latencyBudgetMs: number;
  readonly provisionedConcurrency: number;
  readonly memoryMb: number;
  readonly timeoutSeconds: number;
}

/**
 * Surface 1: the contact-flow Lambda that answers callers from the in-process
 * Moss index.
 */
export class VoiceRetrieval extends Construct {
  public readonly fn: NodejsFunction;
  public readonly alias: lambda.Alias;

  constructor(scope: Construct, id: string, props: VoiceRetrievalProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, 'Fn', {
      entry: 'src/handlers/voice-retrieval.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      // Memory buys CPU, and the index load at init is CPU-bound. Undersizing
      // this shows up as cold-start latency, not as an out-of-memory error.
      memorySize: props.memoryMb,
      timeout: Duration.seconds(props.timeoutSeconds),
      environment: {
        MOSS_INDEX_BUCKET: props.indexBucket.bucketName,
        MOSS_INDEX_MANIFEST_KEY: props.manifestKey,
        MOSS_LATENCY_BUDGET_MS: String(props.latencyBudgetMs),
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: { minify: true, sourceMap: true, target: 'node20' },
    });

    props.indexBucket.grantRead(this.fn);
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['cloudwatch:PutMetricData'], resources: ['*'] }),
    );

    // Provisioned concurrency attaches to an alias, never to $LATEST. Without
    // this the index load happens on a caller's first word.
    this.alias = new lambda.Alias(this, 'Live', {
      aliasName: 'live',
      version: this.fn.currentVersion,
      ...(props.provisionedConcurrency > 0
        ? { provisionedConcurrentExecutions: props.provisionedConcurrency }
        : {}),
    });

    // Let the Connect instance -- and only that instance -- invoke us.
    this.alias.addPermission('ConnectInvoke', {
      principal: new iam.ServicePrincipal('connect.amazonaws.com'),
      sourceArn: props.connectInstanceArn,
    });

    /**
     * Associate the function with the Connect instance so it appears in the
     * InvokeLambdaFunction block's dropdown.
     *
     * OPEN QUESTION (docs/MOSS_QUESTIONS.md): we associate the ALIAS arn, since
     * invoking $LATEST would make provisioned concurrency useless. Confirm on
     * first deploy that Connect accepts a qualified ARN here; if it rejects it,
     * associate `this.fn.functionArn` and accept cold starts, or front the
     * alias differently. Do not silently switch to $LATEST -- that throws away
     * the warm path while every test still passes.
     */
    new connect.CfnIntegrationAssociation(this, 'ConnectAssociation', {
      instanceId: props.connectInstanceArn,
      integrationType: 'LAMBDA_FUNCTION',
      integrationArn: this.alias.functionArn,
    });

    this.addAlarms(props.latencyBudgetMs);
  }

  /**
   * Alarms on the degradation paths. Each metric must exist with exactly this
   * namespace and dimension set -- a green alarm watching a metric nobody emits
   * is worse than no alarm, because it reads as proof the path is healthy.
   */
  private addAlarms(latencyBudgetMs: number): void {
    const dims = { Surface: 'VoiceRetrieval' };
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
        'Voice retrieval is escalating to a human more than 25% of the time -- the ' +
        'self-service path is not working, even though no errors are being thrown.',
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
      alarmDescription: `Retrieval p99 exceeded the ${latencyBudgetMs}ms budget -- the latency claim is failing.`,
      metric: metric('Retrieval.Slow', 'p99'),
      threshold: latencyBudgetMs,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'IndexLoadFailed', {
      alarmDescription: 'The Moss index failed to load at init. Every call is escalating.',
      metric: metric('Index.LoadFailed'),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }

  /** Region-agnostic helper for the contact-flow author. */
  public get invokeHint(): string {
    return `Set the InvokeLambdaFunction block to ${this.alias.functionArn} in ${Stack.of(this).region}`;
  }
}
