import fc from 'fast-check';
import {
  buildIndexArtifact,
  documentsFromAnalysis,
  manifestFor,
  type PostCallAnalysis,
} from '../handlers/post-call-index';
import { parseManifest } from '../moss/index-loader';
import { StubRetriever } from '../moss/stub-retriever';

const analysis: PostCallAnalysis = {
  CustomerMetadata: { ContactId: 'c-9' },
  LanguageCode: 'en-US',
  Transcript: [
    { Id: 't1', ParticipantRole: 'CUSTOMER', Content: 'How long does shipping take?', BeginOffsetMillis: 500 },
    { Id: 't2', ParticipantRole: 'AGENT', Content: 'Three to five business days.' },
    { Id: 't3', ParticipantRole: 'CUSTOMER', Content: 'And returns?' },
    { Id: 't4', ParticipantRole: 'CUSTOMER', Content: 'Hello?' },
  ],
};

describe('documentsFromAnalysis', () => {
  it('pairs each customer question with the agent reply that followed it', () => {
    const docs = documentsFromAnalysis(analysis);
    expect(docs).toHaveLength(1);
    expect(docs[0].text).toBe('Q: How long does shipping take?\nA: Three to five business days.');
    expect(docs[0].id).toBe('c-9:t1');
    expect(docs[0].metadata).toMatchObject({ contactId: 'c-9', locale: 'en-US' });
  });

  // An unanswered question indexed alone teaches the assistant to echo it back.
  it('drops a customer question with no agent reply after it', () => {
    const docs = documentsFromAnalysis(analysis);
    expect(docs.some((d) => d.text.includes('And returns?'))).toBe(false);
  });

  it.each([
    ['missing contact id', { Transcript: analysis.Transcript }],
    ['missing transcript', { CustomerMetadata: { ContactId: 'c-1' } }],
  ])('returns nothing for %s', (_l, input) => {
    expect(documentsFromAnalysis(input as PostCallAnalysis)).toEqual([]);
  });
});

describe('manifestFor', () => {
  it('is content-addressed, so an identical corpus does not churn the live pointer', () => {
    const docs = documentsFromAnalysis(analysis);
    const a = manifestFor(docs, buildIndexArtifact(docs));
    const b = manifestFor(docs, buildIndexArtifact(docs));
    expect(a.version).toBe(b.version);
    expect(a.key).toBe(b.key);
  });

  it('changes version when the corpus changes', () => {
    const docs = documentsFromAnalysis(analysis);
    const a = manifestFor(docs, buildIndexArtifact(docs));
    const more = [...docs, { id: 'x', text: 'Q: a\nA: b' }];
    expect(manifestFor(more, buildIndexArtifact(more)).version).not.toBe(a.version);
  });

  it('produces a manifest the loader accepts', () => {
    const docs = documentsFromAnalysis(analysis);
    const m = manifestFor(docs, buildIndexArtifact(docs));
    expect(parseManifest(JSON.stringify(m))).toEqual(m);
  });
});

describe('build -> load round trip', () => {
  // The contract that actually matters: what the builder writes, the retriever reads.
  it('produces an artifact the retriever can load and search', async () => {
    const docs = documentsFromAnalysis(analysis);
    const bytes = buildIndexArtifact(docs);
    const manifest = manifestFor(docs, bytes);

    const r = new StubRetriever();
    await r.load({ kind: 'bytes', version: manifest.version, bytes });
    const res = await r.retrieve('shipping time');
    expect(res.hits[0].text).toContain('Three to five business days');
    expect(res.indexVersion).toBe(manifest.version);
  });

  it('round-trips any generated corpus', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.string({ minLength: 1 }), text: fc.string() }), { minLength: 1, maxLength: 20 }),
        (docs) => {
          const bytes = buildIndexArtifact(docs);
          const m = manifestFor(docs, bytes);
          expect(m.documentCount).toBe(docs.length);
          expect(m.sha256).toHaveLength(64);
          expect(() => parseManifest(JSON.stringify(m))).not.toThrow();
        },
      ),
    );
  });
});
