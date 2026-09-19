import {
  FLOW_VERSION,
  FlowValidationError,
  buildDemoFlow,
  renderFlow,
  validateFlow,
  type FlowContent,
} from '../flows/flow-builder';
import { DEMO_MENU } from '../../lib/constructs/voice-retrieval';

const options = {
  lambdaArn: 'arn:aws:lambda:us-west-2:111122223333:function:retrieve:live',
  arm: 'lexical',
  escalationQueueArn: 'arn:aws:connect:us-west-2:111122223333:instance/abc/queue/def',
  menu: [...DEMO_MENU],
};

describe('buildDemoFlow', () => {
  let flow: FlowContent;
  beforeAll(() => {
    flow = buildDemoFlow(options);
  });

  it('produces a structurally valid flow', () => {
    expect(() => validateFlow(flow)).not.toThrow();
    expect(flow.Version).toBe(FLOW_VERSION);
  });

  it('invokes the Lambda alias, not $LATEST', () => {
    const invoke = flow.Actions.find((a) => a.Type === 'InvokeLambdaFunction')!;
    expect(invoke.Parameters.LambdaFunctionARN).toBe(options.lambdaArn);
    expect(String(invoke.Parameters.LambdaFunctionARN).endsWith(':live')).toBe(true);
  });

  // Connect abandons at 8s; we must return first so our escalate flag wins.
  it('leaves headroom under the Connect 8s invocation ceiling', () => {
    const invoke = flow.Actions.find((a) => a.Type === 'InvokeLambdaFunction')!;
    expect(Number(invoke.Parameters.InvocationTimeLimitSeconds)).toBeLessThan(8);
  });

  it('stamps the arm onto the contact so calls are attributable later', () => {
    const stamp = flow.Actions.find((a) => a.Identifier === 'stamp-arm')!;
    expect((stamp.Parameters.Attributes as Record<string, string>).retrievalArm).toBe('lexical');
  });

  it('enables Contact Lens realtime, which feeds agent assist', () => {
    const analytics = flow.Actions.find((a) => a.Type === 'UpdateContactRecordingBehavior')!;
    expect(JSON.stringify(analytics.Parameters)).toContain('RealTime');
  });

  it('branches on resolved and escalates otherwise', () => {
    const compare = flow.Actions.find((a) => a.Type === 'Compare')!;
    expect(compare.Parameters.ComparisonValue).toBe('$.External.resolved');
    expect(compare.Transitions.Conditions?.[0].NextAction).toBe('play-answer');
    expect(compare.Transitions.NextAction).toBe('escalate');
  });

  it('gives every menu digit its own query action', () => {
    for (const entry of DEMO_MENU) {
      expect(flow.Actions.some((a) => a.Identifier === `query-${entry.digit}`)).toBe(true);
    }
  });

  it('routes a timeout or bad key to escalation rather than dead-ending', () => {
    const menu = flow.Actions.find((a) => a.Type === 'GetParticipantInput')!;
    const errorTargets = (menu.Transitions.Errors ?? []).map((e) => e.NextAction);
    expect(errorTargets).toContain('escalate');
  });

  it('renders to a JSON string Connect can take as content', () => {
    const rendered = renderFlow(flow);
    expect(typeof rendered).toBe('string');
    expect(JSON.parse(rendered).StartAction).toBe(flow.StartAction);
  });

  it('rejects an empty menu', () => {
    expect(() => buildDemoFlow({ ...options, menu: [] })).toThrow(FlowValidationError);
  });
});

describe('validateFlow', () => {
  const action = (id: string, next?: string) => ({
    Identifier: id,
    Type: 'MessageParticipant',
    Parameters: {},
    Transitions: next ? { NextAction: next } : {},
  });
  const flow = (actions: any[], start = 'a'): FlowContent => ({
    Version: FLOW_VERSION,
    StartAction: start,
    Metadata: {},
    Actions: actions,
  });

  it('catches a transition to an action that does not exist', () => {
    expect(() => validateFlow(flow([action('a', 'ghost')]))).toThrow(/transitions to "ghost"/);
  });

  it('catches a StartAction that is not defined', () => {
    expect(() => validateFlow(flow([action('a')], 'nope'))).toThrow(/StartAction "nope"/);
  });

  it('catches duplicate identifiers', () => {
    expect(() => validateFlow(flow([action('a'), action('a')]))).toThrow(/duplicate action identifier/);
  });

  // An orphan usually means a branch was rewired and one path was missed.
  it('catches unreachable actions', () => {
    expect(() => validateFlow(flow([action('a'), action('orphan')]))).toThrow(/unreachable action\(s\): orphan/);
  });

  it('accepts a minimal valid flow', () => {
    expect(() => validateFlow(flow([action('a', 'b'), action('b')]))).not.toThrow();
  });
});
