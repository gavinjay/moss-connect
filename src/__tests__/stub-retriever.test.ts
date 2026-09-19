import { RetrieverNotReadyError, type MossDocument } from '../moss/retriever';
import { StubRetriever } from '../moss/stub-retriever';

const docs: MossDocument[] = [
  { id: 'refund', text: 'You can request a refund within 30 days of purchase.', metadata: { locale: 'en-US' } },
  { id: 'shipping', text: 'Standard shipping takes three to five business days.', metadata: { locale: 'en-US' } },
  { id: 'refund-fr', text: 'Remboursement possible sous trente jours.', metadata: { locale: 'fr-FR' } },
];

async function ready(): Promise<StubRetriever> {
  const r = new StubRetriever();
  await r.load({ kind: 'documents', version: 'v1', documents: docs });
  return r;
}

describe('StubRetriever', () => {
  it('refuses to retrieve before load, rather than returning nothing', async () => {
    const r = new StubRetriever();
    await expect(r.retrieve('refund')).rejects.toBeInstanceOf(RetrieverNotReadyError);
    expect(r.stats().state).toBe('unloaded');
  });

  it('reports stats after load', async () => {
    const r = await ready();
    const stats = r.stats();
    expect(stats.state).toBe('ready');
    expect(stats.indexVersion).toBe('v1');
    expect(stats.documentCount).toBe(3);
    expect(stats.loadMs).not.toBeNull();
  });

  it('ranks the relevant document first', async () => {
    const r = await ready();
    const res = await r.retrieve('how do I get a refund');
    expect(res.hits[0].id).toBe('refund');
    expect(res.indexVersion).toBe('v1');
  });

  it('honours a metadata filter', async () => {
    const r = await ready();
    const res = await r.retrieve('remboursement', { filter: { locale: 'fr-FR' } });
    expect(res.hits.every((h) => h.id === 'refund-fr')).toBe(true);
  });

  it('returns nothing rather than a bad answer when nothing clears the threshold', async () => {
    const r = await ready();
    const res = await r.retrieve('quantum chromodynamics', { minScore: 0.5 });
    expect(res.hits).toHaveLength(0);
  });

  it('respects topK', async () => {
    const r = await ready();
    const res = await r.retrieve('refund shipping days', { topK: 2 });
    expect(res.hits.length).toBeLessThanOrEqual(2);
  });

  it('is deterministic across identical queries', async () => {
    const r = await ready();
    const a = await r.retrieve('refund policy');
    const b = await r.retrieve('refund policy');
    expect(a.hits.map((h) => h.id)).toEqual(b.hits.map((h) => h.id));
  });

  it('loads from serialised bytes', async () => {
    const r = new StubRetriever();
    const bytes = new TextEncoder().encode(JSON.stringify(docs));
    await r.load({ kind: 'bytes', version: 'v2', bytes });
    expect(r.stats().documentCount).toBe(3);
    expect((await r.retrieve('shipping')).indexVersion).toBe('v2');
  });

  it('records a failed load instead of pretending to be ready', async () => {
    const r = new StubRetriever();
    const bad = new TextEncoder().encode('{"not":"an array"}');
    await expect(r.load({ kind: 'bytes', version: 'v3', bytes: bad })).rejects.toThrow();
    expect(r.stats().state).toBe('failed');
    expect(r.stats().lastError).not.toBeNull();
  });
});
