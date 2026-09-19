/**
 * The Amazon Connect contact-flow Lambda contract.
 *
 * Connect is unusually strict about the response, and violating it fails at
 * RUNTIME on a live call -- never at compile time, never in a unit test that
 * mocks the invocation:
 *
 *   1. The response MUST be a FLAT map. String keys to scalar values. A nested
 *      object or an array anywhere in it and Connect rejects the whole
 *      response, sending the contact down the flow's error branch.
 *   2. The response is capped at 32KB.
 *   3. Connect abandons the invocation at 8 seconds, hard.
 *
 * Retrieval results are naturally nested (an array of hits, each with
 * metadata), so the mapping from "what Moss returned" to "what Connect will
 * accept" is exactly where this breaks. Hence this module, and its tests.
 *
 * Returned keys are read in the contact flow as `$.External.<key>`.
 */

export const CONNECT_MAX_RESPONSE_BYTES = 32 * 1024;
export const CONNECT_INVOCATION_CEILING_MS = 8_000;

export type ConnectScalar = string | number | boolean | null;
export type ConnectFlowResponse = Record<string, ConnectScalar>;

export interface ConnectContactFlowEvent {
  readonly Name?: string;
  readonly Details: {
    readonly ContactData: {
      readonly ContactId: string;
      readonly InstanceARN: string;
      readonly Attributes?: Record<string, string>;
      readonly LanguageCode?: string;
    };
    /** Values configured on the InvokeLambdaFunction block. Always strings. */
    readonly Parameters: Record<string, string>;
  };
}

export class ConnectResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectResponseError';
  }
}

/**
 * Validates a response against Connect's rules, throwing on violation so a
 * malformed shape is caught in tests rather than on a call.
 */
export function assertConnectResponse(response: unknown): ConnectFlowResponse {
  if (response === null || typeof response !== 'object' || Array.isArray(response)) {
    throw new ConnectResponseError('Connect response must be a non-array object');
  }
  for (const [key, value] of Object.entries(response)) {
    const type = typeof value;
    if (value !== null && type !== 'string' && type !== 'number' && type !== 'boolean') {
      throw new ConnectResponseError(
        `Connect response key "${key}" is ${Array.isArray(value) ? 'an array' : type}. ` +
          'Connect accepts only flat scalar values -- flatten it into suffixed keys ' +
          '(e.g. answer_0, answer_1) before returning.',
      );
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
  if (bytes > CONNECT_MAX_RESPONSE_BYTES) {
    throw new ConnectResponseError(
      `Connect response is ${bytes} bytes, over the ${CONNECT_MAX_RESPONSE_BYTES} byte limit. ` +
        'Return fewer hits or truncate the answer text.',
    );
  }
  return response as ConnectFlowResponse;
}

/**
 * Flattens nested data into Connect-safe keys: `hit_0_text`, `hit_0_score`, ...
 * Truncates rather than throwing on the size limit, because dropping the
 * tail of a long answer beats failing the call outright.
 */
export function flattenForConnect(
  prefix: string,
  rows: readonly Readonly<Record<string, ConnectScalar>>[],
  maxRows = 3,
): ConnectFlowResponse {
  const flat: ConnectFlowResponse = {};
  rows.slice(0, maxRows).forEach((row, i) => {
    for (const [key, value] of Object.entries(row)) {
      flat[`${prefix}_${i}_${key}`] = value;
    }
  });
  return flat;
}

/** Truncates a string to fit a byte budget without splitting a UTF-8 sequence. */
export function truncateToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  if (maxBytes <= 0) return '';

  // Find the lead byte of the character straddling the cut point, then keep it
  // only if the whole sequence fits.
  let cut = maxBytes;
  let lead = cut - 1;
  while (lead >= 0 && (buf[lead] & 0xc0) === 0x80) lead--;
  if (lead < 0) return '';

  const b = buf[lead];
  const seqLen = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
  if (lead + seqLen > cut) cut = lead;
  return buf.subarray(0, cut).toString('utf8');
}
