import { CONNECT_SUPPORTED_REGIONS, assertConnectRegion, isConnectRegion } from '../config/regions';

describe('Connect region guard', () => {
  // The whole point of this file. us-east-2 is where `jarvis` lives, so it is
  // the region a returning engineer types from muscle memory.
  it('rejects us-east-2 with a pointed message', () => {
    expect(() => assertConnectRegion('us-east-2')).toThrow(/not available in "us-east-2"/);
    expect(() => assertConnectRegion('us-east-2')).toThrow(/jarvis/);
  });

  it('accepts the two US Connect regions', () => {
    expect(assertConnectRegion('us-west-2')).toBe('us-west-2');
    expect(assertConnectRegion('us-east-1')).toBe('us-east-1');
  });

  it('rejects nonsense', () => {
    expect(() => assertConnectRegion('moon-base-1')).toThrow();
    expect(isConnectRegion('eu-west-1')).toBe(false); // Ireland genuinely is not a Connect region
  });

  it('has no duplicates', () => {
    expect(new Set(CONNECT_SUPPORTED_REGIONS).size).toBe(CONNECT_SUPPORTED_REGIONS.length);
  });
});
