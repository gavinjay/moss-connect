import {
  CONNECT_SUPPORTED_REGIONS,
  assertConnectRegion,
  isConnectRegion,
  parseConnectInstanceArn,
} from '../config/regions';

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

describe('parseConnectInstanceArn', () => {
  const arn = 'arn:aws:connect:us-west-2:184670915146:instance/2b88db70-9667-404a-b9ba-634da2adbfa6';

  it('extracts region, account and instance id', () => {
    expect(parseConnectInstanceArn(arn)).toEqual({
      region: 'us-west-2',
      account: '184670915146',
      instanceId: '2b88db70-9667-404a-b9ba-634da2adbfa6',
    });
  });

  it('tolerates surrounding whitespace from a copy-paste', () => {
    expect(parseConnectInstanceArn(`  ${arn}\n`).account).toBe('184670915146');
  });

  it.each([
    ['a queue arn', 'arn:aws:connect:us-west-2:184670915146:instance/abc/queue/def'],
    ['a lambda arn', 'arn:aws:lambda:us-west-2:184670915146:function:foo'],
    ['an 11-digit account', 'arn:aws:connect:us-west-2:18467091514:instance/abc'],
    ['bare text', 'trackit-demo'],
  ])('rejects %s', (_label, bad) => {
    expect(() => parseConnectInstanceArn(bad)).toThrow(/Not a valid Amazon Connect instance ARN/);
  });
});
