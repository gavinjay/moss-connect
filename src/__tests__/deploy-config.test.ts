import { loadConfig, type ContextReader } from '../config/deploy-config';

const valid = {
  region: 'us-west-2',
  connect: {
    instanceAlias: 'moss-bench-demo',
    existingInstanceArn: '',
    inboundCalls: true,
    outboundCalls: false,
    phoneNumber: { enabled: true, countryCode: 'US', type: 'DID', description: 'demo' },
  },
  voiceRetrieval: { latencyBudgetMs: 120, provisionedConcurrency: 2, memoryMb: 2048, timeoutSeconds: 6 },
  indexStore: { retainOnDelete: true, manifestKey: 'manifests/current.json' },
  benchmark: { arms: ['lexical', 'moss', 'bedrock-kb'], bedrockKnowledgeBaseId: 'KB123456' },
  tags: { project: 'Moss-Connect', owner: 'Gavin Jay', awsApnId: 'pc:95kvqdasagvgk51tnwem21dgu' },
};

const reader = (ctx: unknown): ContextReader => ({ tryGetContext: () => ctx });
const withConnect = (o: Record<string, unknown>) => ({ ...valid, connect: { ...valid.connect, ...o } });
const withBench = (o: Record<string, unknown>) => ({ ...valid, benchmark: { ...valid.benchmark, ...o } });

describe('loadConfig', () => {
  it('loads a complete config', () => {
    const cfg = loadConfig(reader(valid));
    expect(cfg.region).toBe('us-west-2');
    expect(cfg.connect.instanceAlias).toBe('moss-bench-demo');
    expect(cfg.benchmark.arms).toEqual(['lexical', 'moss', 'bedrock-kb']);
  });

  it('throws when the context block is absent entirely', () => {
    expect(() => loadConfig(reader(undefined))).toThrow(/missing the "mossConnect" context block/);
  });

  it.each([
    ['region', { ...valid, region: '' }],
    ['tags.project', { ...valid, tags: { ...valid.tags, project: '' } }],
    ['indexStore.manifestKey', { ...valid, indexStore: { ...valid.indexStore, manifestKey: '' } }],
  ])('throws on missing %s rather than substituting a default', (field, ctx) => {
    expect(() => loadConfig(reader(ctx))).toThrow(new RegExp(field.replace('.', '\\.')));
  });

  it('refuses a Lambda timeout at or above the Connect 8s ceiling', () => {
    const ctx = { ...valid, voiceRetrieval: { ...valid.voiceRetrieval, timeoutSeconds: 8 } };
    expect(() => loadConfig(reader(ctx))).toThrow(/abandons a contact-flow Lambda invocation at 8 seconds/);
  });

  it('refuses an unsupported region even when everything else is valid', () => {
    expect(() => loadConfig(reader({ ...valid, region: 'us-east-2' }))).toThrow(/us-east-2/);
  });
});

describe('Connect instance: create vs adopt', () => {
  // Neither set would silently build a stack attached to nothing.
  it('requires an alias when creating a new instance', () => {
    expect(() => loadConfig(reader(withConnect({ instanceAlias: '' })))).toThrow(/connect\.instanceAlias/);
  });

  it('does not require an alias when adopting an existing instance', () => {
    const cfg = loadConfig(
      reader(withConnect({ instanceAlias: '', existingInstanceArn: 'arn:aws:connect:us-west-2:111122223333:instance/abc' })),
    );
    expect(cfg.connect.existingInstanceArn).toContain('instance/abc');
  });

  it('treats a whitespace-only ARN as absent', () => {
    expect(() => loadConfig(reader(withConnect({ instanceAlias: '', existingInstanceArn: '   ' })))).toThrow(
      /connect\.instanceAlias/,
    );
  });
});

describe('phone number config', () => {
  it('rejects a phone number type that is neither DID nor TOLL_FREE', () => {
    expect(() =>
      loadConfig(reader(withConnect({ phoneNumber: { enabled: true, countryCode: 'US', type: 'MOBILE' } }))),
    ).toThrow(/must be "DID" or "TOLL_FREE"/);
  });

  it('requires a country code when a number is being claimed', () => {
    expect(() =>
      loadConfig(reader(withConnect({ phoneNumber: { enabled: true, countryCode: '', type: 'DID' } }))),
    ).toThrow(/countryCode/);
  });

  it('skips phone validation entirely when disabled', () => {
    const cfg = loadConfig(reader(withConnect({ phoneNumber: { enabled: false } })));
    expect(cfg.connect.phoneNumber.enabled).toBe(false);
  });
});

describe('benchmark arms', () => {
  it('rejects an unknown arm instead of ignoring it', () => {
    expect(() => loadConfig(reader(withBench({ arms: ['lexical', 'pinecone'] })))).toThrow(
      /Unknown benchmark arm\(s\): pinecone/,
    );
  });

  it('rejects an empty arm list', () => {
    expect(() => loadConfig(reader(withBench({ arms: [] })))).toThrow(/benchmark\.arms/);
  });

  it('deduplicates arms', () => {
    expect(loadConfig(reader(withBench({ arms: ['lexical', 'lexical'] }))).benchmark.arms).toEqual(['lexical']);
  });

  // A bedrock-kb arm with no KB id would deploy and fail at runtime on every call.
  it('requires a knowledge base id when the bedrock-kb arm is enabled', () => {
    expect(() =>
      loadConfig(reader(withBench({ arms: ['bedrock-kb'], bedrockKnowledgeBaseId: '' }))),
    ).toThrow(/bedrockKnowledgeBaseId is blank/);
  });

  it('does not require a knowledge base id when that arm is absent', () => {
    const cfg = loadConfig(reader(withBench({ arms: ['lexical', 'moss'], bedrockKnowledgeBaseId: '' })));
    expect(cfg.benchmark.bedrockKnowledgeBaseId).toBeNull();
  });
});

describe('target account', () => {
  const arn = 'arn:aws:connect:us-west-2:111122223333:instance/2b88db70-9667-404a-b9ba-634da2adbfa6';

  // The bug this guards: account came from CDK_DEFAULT_ACCOUNT, so a diff
  // synthesized into whichever account the shell's credentials were for while
  // every Connect reference pointed at the ARN's account. Nothing failed.
  it('derives the account from the Connect instance ARN', () => {
    const cfg = loadConfig(reader(withConnect({ instanceAlias: '', existingInstanceArn: arn })));
    expect(cfg.account).toBe('111122223333');
  });

  it('rejects an instance ARN whose region disagrees with cdk.json', () => {
    const wrongRegion = arn.replace('us-west-2', 'us-east-1');
    expect(() =>
      loadConfig(reader(withConnect({ instanceAlias: '', existingInstanceArn: wrongRegion }))),
    ).toThrow(/cannot be adopted across regions/);
  });

  it('rejects an explicit account that disagrees with the ARN', () => {
    expect(() =>
      loadConfig(
        reader({ ...withConnect({ instanceAlias: '', existingInstanceArn: arn }), account: '999988887777' }),
      ),
    ).toThrow(/These must agree/);
  });

  it('rejects a malformed instance ARN outright', () => {
    expect(() =>
      loadConfig(reader(withConnect({ instanceAlias: '', existingInstanceArn: 'not-an-arn' }))),
    ).toThrow(/Not a valid Amazon Connect instance ARN/);
  });

  it('has no account to derive when creating a fresh instance', () => {
    expect(loadConfig(reader(valid)).account).toBeNull();
  });
});
