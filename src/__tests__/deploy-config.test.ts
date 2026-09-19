import { loadConfig, type ContextReader } from '../config/deploy-config';

const valid = {
  region: 'us-west-2',
  connectInstanceArn: 'arn:aws:connect:us-west-2:111122223333:instance/abc',
  contactLensRealtimeEnabled: true,
  voiceRetrieval: { latencyBudgetMs: 120, provisionedConcurrency: 2, memoryMb: 2048, timeoutSeconds: 6 },
  indexStore: { retainOnDelete: true, manifestKey: 'manifests/current.json' },
  tags: { project: 'Moss-Connect', owner: 'Gavin Jay', awsApnId: 'pc:95kvqdasagvgk51tnwem21dgu' },
};

const reader = (ctx: unknown): ContextReader => ({ tryGetContext: () => ctx });

describe('loadConfig', () => {
  it('loads a complete config', () => {
    const cfg = loadConfig(reader(valid));
    expect(cfg.region).toBe('us-west-2');
    expect(cfg.voiceRetrieval.timeoutSeconds).toBe(6);
  });

  it('throws when the context block is absent entirely', () => {
    expect(() => loadConfig(reader(undefined))).toThrow(/missing the "mossConnect" context block/);
  });

  // Every one of these silently "worked" in past projects by falling back.
  it.each([
    ['connectInstanceArn', { ...valid, connectInstanceArn: '' }],
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
