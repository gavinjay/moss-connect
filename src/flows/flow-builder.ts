/**
 * Amazon Connect contact-flow content, built as typed objects rather than
 * hand-written JSON.
 *
 * SCHEMA CAVEAT: Connect's flow-content schema is detailed and validated
 * server-side at deploy time. The action types and parameter names here are
 * modelled from the documented format but have NOT been round-tripped through a
 * live Connect instance yet. Connect rejects a malformed flow with a specific
 * error, so it is a fast feedback loop -- but treat the first deploy as the
 * validation step, and see docs/MOSS_QUESTIONS.md.
 *
 * What IS verified here, by `validateFlow()` and its tests: every transition
 * target resolves to a real action, there is exactly one start action, and no
 * action is unreachable. Those are the mistakes that are easy to make and
 * tedious to diagnose from Connect's error message.
 */

export const FLOW_VERSION = '2019-10-30';

export interface FlowTransitions {
  readonly NextAction?: string;
  readonly Conditions?: readonly {
    readonly NextAction: string;
    readonly Condition: { readonly Operator: string; readonly Operands: readonly string[] };
  }[];
  readonly Errors?: readonly { readonly NextAction: string; readonly ErrorType: string }[];
}

export interface FlowAction {
  readonly Identifier: string;
  readonly Type: string;
  readonly Parameters: Record<string, unknown>;
  readonly Transitions: FlowTransitions;
}

export interface FlowContent {
  readonly Version: string;
  readonly StartAction: string;
  readonly Metadata: Record<string, unknown>;
  readonly Actions: readonly FlowAction[];
}

export class FlowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowValidationError';
  }
}

/** Every NextAction referenced anywhere in a transition. */
function transitionTargets(t: FlowTransitions): string[] {
  return [
    ...(t.NextAction ? [t.NextAction] : []),
    ...(t.Conditions ?? []).map((c) => c.NextAction),
    ...(t.Errors ?? []).map((e) => e.NextAction),
  ];
}

/**
 * Structural validation. Catches dangling transitions, duplicate identifiers,
 * a missing start action and unreachable actions -- all of which Connect either
 * rejects with an opaque message or, worse, accepts into a flow that dead-ends
 * on a live call.
 */
export function validateFlow(flow: FlowContent): FlowContent {
  const ids = flow.Actions.map((a) => a.Identifier);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new FlowValidationError(`duplicate action identifier: ${id}`);
    seen.add(id);
  }
  if (!seen.has(flow.StartAction)) {
    throw new FlowValidationError(`StartAction "${flow.StartAction}" is not a defined action`);
  }

  for (const action of flow.Actions) {
    for (const target of transitionTargets(action.Transitions)) {
      if (!seen.has(target)) {
        throw new FlowValidationError(
          `action "${action.Identifier}" (${action.Type}) transitions to "${target}", which does not exist`,
        );
      }
    }
  }

  // Reachability: an orphaned action is dead weight that still has to be
  // maintained, and usually means a transition was rewired and one branch missed.
  const reachable = new Set<string>([flow.StartAction]);
  const byId = new Map(flow.Actions.map((a) => [a.Identifier, a]));
  const queue = [flow.StartAction];
  while (queue.length > 0) {
    const current = byId.get(queue.shift()!)!;
    for (const target of transitionTargets(current.Transitions)) {
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }
  const orphans = ids.filter((id) => !reachable.has(id));
  if (orphans.length > 0) {
    throw new FlowValidationError(`unreachable action(s): ${orphans.join(', ')}`);
  }
  return flow;
}

export interface DemoFlowOptions {
  /** Lambda alias ARN to invoke. Must be associated with the instance. */
  readonly lambdaArn: string;
  /** Which arm this flow exercises -- stamped onto the contact for attribution. */
  readonly arm: string;
  /** Queue to transfer to when retrieval cannot answer confidently. */
  readonly escalationQueueArn: string;
  readonly voice?: string;
  /**
   * DTMF menu entries. Canned natural-language questions, on purpose: speech
   * recognition adds 500-1500ms of latency and a lot of variance, which would
   * completely swamp the 10ms-vs-50ms retrieval difference this project exists
   * to demonstrate. A keypad keeps the demo reproducible in front of an
   * audience. Free-form speech needs a Lex bot -- a deliberate later step.
   */
  readonly menu: readonly { readonly digit: string; readonly label: string; readonly query: string }[];
}

/**
 * The demo flow: greet, take a keypress, retrieve, read the answer back, or
 * escalate to a human.
 *
 * Note it invokes with a 7-second limit. Connect's own ceiling is 8s; leaving
 * headroom means our handler's graceful `escalate` response wins the race rather
 * than Connect abandoning the invocation with no context.
 */
export function buildDemoFlow(options: DemoFlowOptions): FlowContent {
  const { lambdaArn, arm, escalationQueueArn, menu } = options;
  const voice = options.voice ?? 'Joanna';
  if (menu.length === 0) throw new FlowValidationError('demo flow needs at least one menu entry');

  const actions: FlowAction[] = [];

  actions.push({
    Identifier: 'set-voice',
    Type: 'UpdateContactTextToSpeechVoice',
    Parameters: { TextToSpeechVoice: voice },
    Transitions: { NextAction: 'stamp-arm' },
  });

  // Stamping the arm onto the contact record is what makes a CTR comparable
  // later: without it you cannot tell which retrieval path served a call.
  actions.push({
    Identifier: 'stamp-arm',
    Type: 'UpdateContactAttributes',
    Parameters: { Attributes: { retrievalArm: arm } },
    Transitions: { NextAction: 'enable-analytics', Errors: [{ NextAction: 'enable-analytics', ErrorType: 'NoMatchingError' }] },
  });

  // Contact Lens real-time is what feeds the agent-assist surface. It is a flow
  // setting, not a CloudFormation resource, which is why it lives here.
  actions.push({
    Identifier: 'enable-analytics',
    Type: 'UpdateContactRecordingBehavior',
    Parameters: {
      RecordingBehavior: { RecordedParticipants: ['Agent', 'Customer'] },
      AnalyticsBehavior: {
        Enabled: 'True',
        AnalyticsLanguage: 'en-US',
        AnalyticsRedactionBehavior: 'Disabled',
        ChannelConfiguration: { Voice: { AnalyticsModes: ['RealTime', 'PostContact'] } },
      },
    },
    Transitions: { NextAction: 'menu', Errors: [{ NextAction: 'menu', ErrorType: 'NoMatchingError' }] },
  });

  const menuPrompt =
    `Thanks for calling. ${menu.map((m) => `For ${m.label}, press ${m.digit}.`).join(' ')}`;

  actions.push({
    Identifier: 'menu',
    Type: 'GetParticipantInput',
    Parameters: {
      Text: menuPrompt,
      InputTimeLimitSeconds: '8',
      StoreInput: 'False',
      DTMFConfiguration: { DisableCancelKey: 'False' },
    },
    Transitions: {
      NextAction: 'escalate',
      Conditions: menu.map((m) => ({
        NextAction: `query-${m.digit}`,
        Condition: { Operator: 'Equals', Operands: [m.digit] },
      })),
      Errors: [
        { NextAction: 'escalate', ErrorType: 'InputTimeLimitExceeded' },
        { NextAction: 'escalate', ErrorType: 'NoMatchingError' },
      ],
    },
  });

  for (const entry of menu) {
    actions.push({
      Identifier: `query-${entry.digit}`,
      Type: 'UpdateContactAttributes',
      Parameters: { Attributes: { query: entry.query } },
      Transitions: {
        NextAction: 'retrieve',
        Errors: [{ NextAction: 'escalate', ErrorType: 'NoMatchingError' }],
      },
    });
  }

  actions.push({
    Identifier: 'retrieve',
    Type: 'InvokeLambdaFunction',
    Parameters: {
      LambdaFunctionARN: lambdaArn,
      // 7s, under Connect's hard 8s ceiling, so our graceful escalate wins.
      InvocationTimeLimitSeconds: '7',
      LambdaInvocationAttributes: { query: '$.Attributes.query', arm },
    },
    Transitions: {
      NextAction: 'check-resolved',
      Errors: [{ NextAction: 'escalate', ErrorType: 'NoMatchingError' }],
    },
  });

  actions.push({
    Identifier: 'check-resolved',
    Type: 'Compare',
    Parameters: { ComparisonValue: '$.External.resolved' },
    Transitions: {
      NextAction: 'escalate',
      Conditions: [
        { NextAction: 'play-answer', Condition: { Operator: 'Equals', Operands: ['true'] } },
      ],
      Errors: [{ NextAction: 'escalate', ErrorType: 'NoMatchingCondition' }],
    },
  });

  actions.push({
    Identifier: 'play-answer',
    Type: 'MessageParticipant',
    Parameters: { Text: "Here's what I found. $.External.answer" },
    Transitions: {
      NextAction: 'disconnect',
      Errors: [{ NextAction: 'disconnect', ErrorType: 'NoMatchingError' }],
    },
  });

  actions.push({
    Identifier: 'escalate',
    Type: 'MessageParticipant',
    Parameters: { Text: "Let me put you through to someone who can help." },
    Transitions: {
      NextAction: 'set-queue',
      Errors: [{ NextAction: 'disconnect', ErrorType: 'NoMatchingError' }],
    },
  });

  actions.push({
    Identifier: 'set-queue',
    Type: 'UpdateContactTargetQueue',
    Parameters: { QueueId: escalationQueueArn },
    Transitions: {
      NextAction: 'transfer',
      Errors: [{ NextAction: 'disconnect', ErrorType: 'NoMatchingError' }],
    },
  });

  actions.push({
    Identifier: 'transfer',
    Type: 'TransferContactToQueue',
    Parameters: {},
    Transitions: {
      NextAction: 'disconnect',
      Errors: [
        { NextAction: 'disconnect', ErrorType: 'QueueAtCapacity' },
        { NextAction: 'disconnect', ErrorType: 'NoMatchingError' },
      ],
    },
  });

  actions.push({
    Identifier: 'disconnect',
    Type: 'DisconnectParticipant',
    Parameters: {},
    Transitions: {},
  });

  return validateFlow({
    Version: FLOW_VERSION,
    StartAction: 'set-voice',
    Metadata: { entryPointPosition: { x: 20, y: 20 }, ActionMetadata: {} },
    Actions: actions,
  });
}

/** Connect takes flow content as a JSON string. */
export function renderFlow(flow: FlowContent): string {
  return JSON.stringify(flow);
}
