import {
  customerUtterances,
  parseContactLensEvent,
  type ContactLensEvent,
} from '../handlers/contact-lens-contract';

const event: ContactLensEvent = {
  ContactId: 'c-1',
  LanguageCode: 'en-US',
  EventType: 'SEGMENTS',
  Segments: [
    { Transcript: { ParticipantRole: 'CUSTOMER', Content: 'I want a refund', Id: 't1', BeginOffsetMillis: 1000 } },
    { Transcript: { ParticipantRole: 'AGENT', Content: 'Let me check that', Id: 't2' } },
    { Utterance: { ParticipantRole: 'CUSTOMER', PartialContent: 'within thirty', Id: 'u1', BeginOffsetMillis: 2000 } },
    { Categories: { MatchedCategories: ['Escalation'] } },
  ],
};

describe('customerUtterances', () => {
  it('keeps only customer speech', () => {
    const out = customerUtterances(event);
    expect(out.map((u) => u.text)).toEqual(['I want a refund', 'within thirty']);
  });

  // Indexing the agent's own words creates a loop where the assistant
  // re-suggests whatever the agent just read aloud.
  it('excludes agent speech', () => {
    expect(customerUtterances(event).some((u) => u.text.includes('Let me check'))).toBe(false);
  });

  it('marks partial utterances', () => {
    const out = customerUtterances(event);
    expect(out[0].partial).toBe(false);
    expect(out[1].partial).toBe(true);
  });

  it('carries contactId and locale through', () => {
    expect(customerUtterances(event)[0]).toMatchObject({ contactId: 'c-1', locale: 'en-US' });
  });

  it('ignores unrecognised segment types instead of throwing', () => {
    const odd = { ContactId: 'c-2', Segments: [{ SomethingNew: { x: 1 } } as never] };
    expect(customerUtterances(odd)).toEqual([]);
  });

  it.each([
    ['no contact id', { Segments: event.Segments }],
    ['no segments', { ContactId: 'c-3' }],
    ['empty segments', { ContactId: 'c-3', Segments: [] }],
  ])('returns nothing for %s', (_label, partial) => {
    expect(customerUtterances(partial as ContactLensEvent)).toEqual([]);
  });

  it('drops whitespace-only content', () => {
    const blank = { ContactId: 'c-4', Segments: [{ Transcript: { ParticipantRole: 'CUSTOMER', Content: '   ' } }] };
    expect(customerUtterances(blank)).toEqual([]);
  });
});

describe('parseContactLensEvent', () => {
  it('parses a valid payload', () => {
    expect(parseContactLensEvent('{"ContactId":"x"}').ContactId).toBe('x');
  });

  it('throws on a non-object payload', () => {
    expect(() => parseContactLensEvent('null')).toThrow(/did not decode to an object/);
  });

  it('throws on malformed json', () => {
    expect(() => parseContactLensEvent('{oops')).toThrow();
  });
});
