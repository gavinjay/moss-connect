/**
 * Contact Lens real-time event shape, as delivered to a Kinesis Data Stream.
 *
 * VERIFY AGAINST A LIVE STREAM BEFORE TRUSTING THE FIELD NAMES. These are
 * modelled from the documented payload, but Contact Lens has versioned its
 * segment shape before. `parseContactLensEvent` is deliberately tolerant: it
 * skips segments it does not recognise rather than throwing, because one
 * unexpected segment type must not stall a Kinesis shard on a live call.
 */

export type ParticipantRole = 'CUSTOMER' | 'AGENT' | 'SYSTEM' | string;

export interface ContactLensUtterance {
  readonly ParticipantId?: string;
  readonly ParticipantRole?: ParticipantRole;
  readonly PartialContent?: string;
  readonly BeginOffsetMillis?: number;
  readonly EndOffsetMillis?: number;
  readonly Id?: string;
}

export interface ContactLensTranscript {
  readonly ParticipantId?: string;
  readonly ParticipantRole?: ParticipantRole;
  readonly Content?: string;
  readonly Id?: string;
  readonly BeginOffsetMillis?: number;
  readonly EndOffsetMillis?: number;
  readonly Sentiment?: string;
}

export interface ContactLensSegment {
  readonly Utterance?: ContactLensUtterance;
  readonly Transcript?: ContactLensTranscript;
  readonly Categories?: unknown;
}

export interface ContactLensEvent {
  readonly Version?: string;
  readonly Channel?: string;
  readonly AccountId?: string;
  readonly InstanceId?: string;
  readonly ContactId?: string;
  readonly LanguageCode?: string;
  readonly EventType?: string;
  readonly Segments?: readonly ContactLensSegment[];
}

/** One thing the customer said, normalised across Utterance and Transcript segments. */
export interface CustomerUtterance {
  readonly contactId: string;
  readonly text: string;
  readonly partial: boolean;
  readonly offsetMillis: number;
  readonly locale: string | undefined;
}

export function parseContactLensEvent(json: string): ContactLensEvent {
  const parsed = JSON.parse(json) as ContactLensEvent;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Contact Lens payload did not decode to an object');
  }
  return parsed;
}

/**
 * Extracts only what the customer said. Agent speech is excluded on purpose:
 * retrieving against the agent's own words creates a feedback loop where the
 * assistant keeps re-suggesting what the agent just read out.
 */
export function customerUtterances(event: ContactLensEvent): CustomerUtterance[] {
  const contactId = event.ContactId;
  if (!contactId || !Array.isArray(event.Segments)) return [];

  const out: CustomerUtterance[] = [];
  for (const segment of event.Segments) {
    const source = segment.Transcript ?? segment.Utterance;
    if (!source) continue;
    if (source.ParticipantRole !== 'CUSTOMER') continue;

    const text =
      (segment.Transcript?.Content ?? segment.Utterance?.PartialContent ?? '').trim();
    if (!text) continue;

    out.push({
      contactId,
      text,
      partial: segment.Transcript === undefined,
      offsetMillis: source.BeginOffsetMillis ?? 0,
      locale: event.LanguageCode,
    });
  }
  return out;
}
