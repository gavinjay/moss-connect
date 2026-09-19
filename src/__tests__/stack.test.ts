import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ConnectFoundationStack } from '../../lib/connect-foundation-stack';
import { MossConnectStack, stackConfig } from '../../lib/moss-connect-stack';
import { applyTrackItTags } from '../../lib/tagging';

const base = {
  region: 'us-west-2',
  connect: {
    instanceAlias: 'moss-bench-demo',
    existingInstanceArn: '',
    inboundCalls: true,
    outboundCalls: false,
    phoneNumber: { enabled: true, countryCode: 'US', type: 'DID', description: 'demo line' },
  },
  voiceRetrieval: { latencyBudgetMs: 120, provisionedConcurrency: 2, memoryMb: 2048, timeoutSeconds: 6 },
  indexStore: { retainOnDelete: true, manifestKey: 'manifests/current.json' },
  benchmark: { arms: ['lexical', 'moss', 'bedrock-kb'], bedrockKnowledgeBaseId: 'KB123456' },
  tags: { project: 'Moss-Connect', owner: 'Gavin Jay', awsApnId: 'pc:95kvqdasagvgk51tnwem21dgu' },
};

function synth(overrides: Record<string, unknown> = {}) {
  const app = new App({ context: { mossConnect: { ...base, ...overrides } } });
  const config = stackConfig(app);
  const env = { account: '111122223333', region: config.region };
  const foundation = new ConnectFoundationStack(app, 'TestFoundation', { env, connectConfig: config.connect });
  const appStack = new MossConnectStack(app, 'TestApp', {
    env,
    config,
    connectInstanceArn: foundation.instanceArn,
    escalationQueueArn: foundation.escalationQueueArn,
  });
  // Same call bin/moss-connect.ts makes, so the tags under test are the tags
  // that actually deploy.
  applyTrackItTags(app, config.tags);
  return { foundation: Template.fromStack(foundation), app: Template.fromStack(appStack) };
}

/** Our handlers, identified by the env var only we set. Ignores CDK's own plumbing. */
function mossFunctions(t: Template): any[] {
  return Object.values(t.findResources('AWS::Lambda::Function')).filter(
    (fn: any) => fn.Properties?.Environment?.Variables?.MOSS_INDEX_BUCKET !== undefined,
  );
}

/** Just the benchmark-arm handlers. Agent-assist and post-call are different
 *  workloads and are legitimately sized differently, so parity checks that
 *  compare arms must exclude them. */
function armFunctions(t: Template): any[] {
  return mossFunctions(t).filter(
    (fn: any) => fn.Properties.Environment.Variables.MOSS_RETRIEVAL_ARM !== undefined,
  );
}

describe('ConnectFoundationStack', () => {
  let foundation: Template;
  beforeAll(() => {
    foundation = synth().foundation;
  });

  it('creates the Connect instance with Contact Lens enabled', () => {
    foundation.hasResourceProperties('AWS::Connect::Instance', {
      InstanceAlias: 'moss-bench-demo',
      IdentityManagementType: 'CONNECT_MANAGED',
      Attributes: { InboundCalls: true, ContactLens: true },
    });
  });

  it('claims a phone number of the configured type', () => {
    foundation.hasResourceProperties('AWS::Connect::PhoneNumber', { CountryCode: 'US', Type: 'DID' });
  });

  it('creates the escalation queue and routing profile', () => {
    foundation.resourceCountIs('AWS::Connect::Queue', 1);
    foundation.resourceCountIs('AWS::Connect::RoutingProfile', 1);
    foundation.resourceCountIs('AWS::Connect::HoursOfOperation', 1);
  });

  // The instance and the billed phone number must NOT sit in the stack that
  // gets redeployed on every Lambda change.
  it('keeps retrieval Lambdas out of the foundation stack', () => {
    foundation.resourceCountIs('AWS::Lambda::Function', 0);
  });

  it('adopts an existing instance instead of creating one when configured', () => {
    const { foundation: adopted } = synth({
      connect: {
        ...base.connect,
        instanceAlias: '',
        existingInstanceArn: 'arn:aws:connect:us-west-2:111122223333:instance/abc-123',
      },
    });
    adopted.resourceCountIs('AWS::Connect::Instance', 0);
    adopted.resourceCountIs('AWS::Connect::Queue', 1);
  });

  it('omits the phone number when disabled', () => {
    const { foundation: noPhone } = synth({
      connect: { ...base.connect, phoneNumber: { enabled: false } },
    });
    noPhone.resourceCountIs('AWS::Connect::PhoneNumber', 0);
  });
});

describe('MossConnectStack', () => {
  let app: Template;
  beforeAll(() => {
    app = synth().app;
  });

  // One Lambda per arm + agent assist + post-call.
  it('deploys one retrieval Lambda per benchmark arm', () => {
    const arms = mossFunctions(app).map((fn) => fn.Properties.Environment.Variables.MOSS_RETRIEVAL_ARM);
    expect(arms.filter(Boolean).sort()).toEqual(['bedrock-kb', 'lexical', 'moss']);
    expect(mossFunctions(app)).toHaveLength(5);
  });

  it('gives every arm its own dialable contact flow', () => {
    app.resourceCountIs('AWS::Connect::ContactFlow', 3);
  });

  // Identical memory across arms: differing memory would measure Lambda, not retrieval.
  it('sizes every arm identically so the comparison is fair', () => {
    const arms = armFunctions(app);
    expect(arms).toHaveLength(3);
    expect(new Set(arms.map((fn) => fn.Properties.MemorySize)).size).toBe(1);
    expect(new Set(arms.map((fn) => fn.Properties.Timeout)).size).toBe(1);
  });

  it('warms the in-process arms but not the managed baseline', () => {
    const aliases = Object.values(app.findResources('AWS::Lambda::Alias'));
    const warmed = aliases.filter((a: any) => a.Properties.ProvisionedConcurrencyConfig !== undefined);
    // lexical + moss hold a local index; bedrock-kb has nothing to warm.
    expect(warmed).toHaveLength(2);
  });

  it('only grants bedrock:Retrieve to the arm that needs it', () => {
    const policies = Object.values(app.findResources('AWS::IAM::Policy'));
    const granting = policies.filter((p: any) =>
      JSON.stringify(p.Properties.PolicyDocument).includes('bedrock:Retrieve'),
    );
    expect(granting).toHaveLength(1);
  });

  it('keeps the contact-flow timeout under the Connect 8s ceiling', () => {
    for (const fn of armFunctions(app)) {
      expect(fn.Properties.Timeout).toBeLessThan(8);
    }
  });

  it('associates each arm with the Connect instance', () => {
    app.resourceCountIs('AWS::Connect::IntegrationAssociation', 3);
  });

  it('wires Contact Lens realtime to Kinesis and recordings to S3', () => {
    app.resourceCountIs('AWS::Connect::InstanceStorageConfig', 2);
    app.hasResourceProperties('AWS::Connect::InstanceStorageConfig', {
      ResourceType: 'REAL_TIME_CONTACT_ANALYSIS_VOICE_SEGMENTS',
      StorageType: 'KINESIS_STREAM',
    });
  });

  it('versions the index bucket so a bad index can be rolled back', () => {
    app.hasResourceProperties('AWS::S3::Bucket', { VersioningConfiguration: { Status: 'Enabled' } });
  });

  // Three alarms per arm.
  it('alarms on every arm independently', () => {
    app.resourceCountIs('AWS::CloudWatch::Alarm', 9);
  });

  // A green alarm watching a metric nobody emits reads as proof of health.
  it('alarms against the namespace the code actually emits', () => {
    const alarms = Object.values(app.findResources('AWS::CloudWatch::Alarm'));
    const namespaces = alarms.flatMap((a: any) =>
      a.Properties.Namespace
        ? [a.Properties.Namespace]
        : (a.Properties.Metrics ?? []).map((m: any) => m.MetricStat?.Metric?.Namespace),
    );
    expect(namespaces.filter(Boolean).every((ns: string) => ns === 'MossConnect')).toBe(true);
  });

  it('scales down cleanly to a single arm', () => {
    const { app: one } = synth({ benchmark: { arms: ['lexical'], bedrockKnowledgeBaseId: '' } });
    one.resourceCountIs('AWS::Connect::ContactFlow', 1);
    one.resourceCountIs('AWS::CloudWatch::Alarm', 3);
    expect(mossFunctions(one)).toHaveLength(3);
  });

  it('applies every required TrackIt tag to taggable resources', () => {
    const buckets = Object.values(app.findResources('AWS::S3::Bucket'));
    expect(buckets.length).toBeGreaterThan(0);
    for (const b of buckets) {
      const byKey = Object.fromEntries(((b as any).Properties.Tags ?? []).map((t: any) => [t.Key, t.Value]));
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

  it('refuses a bedrock-kb arm with no knowledge base id', () => {
    expect(() => synth({ benchmark: { arms: ['bedrock-kb'], bedrockKnowledgeBaseId: '' } })).toThrow(
      /bedrockKnowledgeBaseId is blank/,
    );
  });

  it('refuses to create an instance with no alias', () => {
    expect(() => synth({ connect: { ...base.connect, instanceAlias: '' } })).toThrow(/instanceAlias/);
  });
});
