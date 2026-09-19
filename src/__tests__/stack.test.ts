import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { MossConnectStack, stackConfig } from '../../lib/moss-connect-stack';
import { applyTrackItTags } from '../../lib/tagging';

const context = {
  mossConnect: {
    region: 'us-west-2',
    connectInstanceArn: 'arn:aws:connect:us-west-2:111122223333:instance/11111111-2222-3333-4444-555555555555',
    contactLensRealtimeEnabled: true,
    voiceRetrieval: { latencyBudgetMs: 120, provisionedConcurrency: 2, memoryMb: 2048, timeoutSeconds: 6 },
    indexStore: { retainOnDelete: true, manifestKey: 'manifests/current.json' },
    tags: { project: 'Moss-Connect', owner: 'Gavin Jay', awsApnId: 'pc:95kvqdasagvgk51tnwem21dgu' },
  },
};

function synth(overrides: Record<string, unknown> = {}) {
  const app = new App({ context: { mossConnect: { ...context.mossConnect, ...overrides } } });
  const config = stackConfig(app);
  const stack = new MossConnectStack(app, 'TestStack', {
    config,
    env: { account: '111122223333', region: config.region },
  });
  // Same call bin/moss-connect.ts makes, so the tags under test are the
  // tags that actually deploy.
  applyTrackItTags(app, config.tags);
  return Template.fromStack(stack);
}

/** Our handlers, identified by the env var only we set. Ignores CDK's own plumbing. */
function mossFunctionCount(t: Template): number {
  return Object.values(t.findResources('AWS::Lambda::Function')).filter(
    (fn: any) => fn.Properties?.Environment?.Variables?.MOSS_INDEX_BUCKET !== undefined,
  ).length;
}

describe('MossConnectStack', () => {
  let template: Template;
  beforeAll(() => {
    template = synth();
  });

  it('creates the three Lambda surfaces', () => {
    expect(mossFunctionCount(template)).toBe(3);
  });

  // Provisioned concurrency only works on an alias. If this regresses to
  // $LATEST the index loads on a caller's first word and nothing else breaks.
  it('puts provisioned concurrency on an alias, not $LATEST', () => {
    template.hasResourceProperties('AWS::Lambda::Alias', {
      Name: 'live',
      ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: 2 },
    });
  });

  it('keeps the contact-flow timeout under the Connect 8s ceiling', () => {
    template.hasResourceProperties('AWS::Lambda::Function', { Timeout: 6 });
  });

  it('lets only the configured Connect instance invoke the retrieval alias', () => {
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Principal: 'connect.amazonaws.com',
      SourceArn: context.mossConnect.connectInstanceArn,
    });
  });

  it('associates the alias with the Connect instance', () => {
    template.hasResourceProperties('AWS::Connect::IntegrationAssociation', {
      IntegrationType: 'LAMBDA_FUNCTION',
    });
  });

  it('versions the index bucket so a bad index can be rolled back', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  it('alarms on the degradation paths', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
  });

  // A green alarm watching a metric nobody emits reads as proof of health.
  it('alarms against the namespace the code actually emits', () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const namespaces = Object.values(alarms).flatMap((a: any) =>
      a.Properties.Namespace ? [a.Properties.Namespace] : (a.Properties.Metrics ?? []).map((m: any) => m.MetricStat?.Metric?.Namespace),
    );
    expect(namespaces.filter(Boolean).every((ns: string) => ns === 'MossConnect')).toBe(true);
  });

  it('creates the transcript stream when realtime assist is enabled', () => {
    template.resourceCountIs('AWS::Kinesis::Stream', 1);
  });

  it('omits the stream when realtime assist is disabled', () => {
    const off = synth({ contactLensRealtimeEnabled: false });
    off.resourceCountIs('AWS::Kinesis::Stream', 0);
    expect(mossFunctionCount(off)).toBe(2);
  });

  // Guards the tagging rule: these must be in IaC, never applied by CLI.
  it('applies every required TrackIt tag to taggable resources', () => {
    const buckets = template.findResources('AWS::S3::Bucket');
    const tagSets = Object.values(buckets).map((b: any) => b.Properties.Tags ?? []);
    expect(tagSets.length).toBeGreaterThan(0);
    for (const tags of tagSets) {
      const byKey = Object.fromEntries(tags.map((t: any) => [t.Key, t.Value]));
      expect(byKey.Project).toBe('Moss-Connect');
      expect(byKey.Owner).toBe('Gavin Jay');
      expect(byKey.TrackitPersistent).toBe('yes');
      expect(byKey['aws-apn-id']).toBe('pc:95kvqdasagvgk51tnwem21dgu');
    }
  });
});

describe('fail-closed synth', () => {
  it('refuses to synth into a region without Amazon Connect', () => {
    expect(() => synth({ region: 'us-east-2' })).toThrow(/us-east-2/);
  });

  it('refuses to synth without a Connect instance ARN', () => {
    expect(() => synth({ connectInstanceArn: '' })).toThrow(/connectInstanceArn/);
  });
});
