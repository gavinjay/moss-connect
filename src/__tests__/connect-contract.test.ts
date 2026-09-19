import fc from 'fast-check';
import {
  CONNECT_MAX_RESPONSE_BYTES,
  ConnectResponseError,
  assertConnectResponse,
  flattenForConnect,
  truncateToBytes,
} from '../handlers/connect-contract';

describe('assertConnectResponse', () => {
  it('accepts a flat scalar map', () => {
    expect(assertConnectResponse({ resolved: true, answer: 'hi', score: 0.5, note: null }))
      .toEqual({ resolved: true, answer: 'hi', score: 0.5, note: null });
  });

  // This is the rule that fails at runtime on a live call and nowhere else.
  it('rejects a nested object', () => {
    expect(() => assertConnectResponse({ hit: { id: 'a' } })).toThrow(ConnectResponseError);
  });

  it('rejects an array value, naming the offending key', () => {
    expect(() => assertConnectResponse({ hits: ['a', 'b'] })).toThrow(/"hits" is an array/);
  });

  it('rejects a top-level array', () => {
    expect(() => assertConnectResponse([{ a: 1 }])).toThrow(/non-array object/);
  });

  it('rejects a response over the 32KB cap', () => {
    const big = { answer: 'x'.repeat(CONNECT_MAX_RESPONSE_BYTES + 1) };
    expect(() => assertConnectResponse(big)).toThrow(/over the 32768 byte limit/);
  });
});

describe('flattenForConnect', () => {
  it('flattens rows into indexed scalar keys', () => {
    expect(flattenForConnect('alt', [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.7 }])).toEqual({
      alt_0_id: 'a',
      alt_0_score: 0.9,
      alt_1_id: 'b',
      alt_1_score: 0.7,
    });
  });

  it('caps the number of rows', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(Object.keys(flattenForConnect('alt', rows, 2))).toHaveLength(2);
  });

  it('always produces something Connect accepts', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.string(), score: fc.double({ noNaN: true }) }), { maxLength: 10 }),
        (rows) => {
          expect(() => assertConnectResponse(flattenForConnect('h', rows))).not.toThrow();
        },
      ),
    );
  });
});

describe('truncateToBytes', () => {
  it('leaves a short string alone', () => {
    expect(truncateToBytes('hello', 100)).toBe('hello');
  });

  it('does not split a multi-byte character', () => {
    // 'é' is 2 bytes; cutting at 3 must drop it rather than emit half of it.
    expect(truncateToBytes('aé', 2)).toBe('a');
    expect(truncateToBytes('aé', 3)).toBe('aé');
  });

  it('handles 4-byte characters', () => {
    expect(truncateToBytes('a🎧', 3)).toBe('a');
    expect(truncateToBytes('a🎧', 5)).toBe('a🎧');
  });

  it('never exceeds the budget and never emits a replacement char', () => {
    fc.assert(
      fc.property(fc.fullUnicodeString(), fc.integer({ min: 0, max: 64 }), (text, max) => {
        const out = truncateToBytes(text, max);
        expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(max);
        // A split sequence would round-trip as U+FFFD.
        if (!text.includes('�')) expect(out).not.toContain('�');
        expect(text.startsWith(out)).toBe(true);
      }),
    );
  });
});
