/**
 * The normalization border for stream frames. Input: a parsed JSON value (use
 * `parseJsonLossless`, never plain JSON.parse). Output: a normalized event or a structured error.
 * Never throws on bad data: at ~1 event/s per type one malformed frame must not kill ingestion.
 */
import { formatIssues } from '../core/schema.js';
import type { UnixMillis } from '../core/time.js';
import { EVENT_SCHEMAS } from './schemas.js';
import type { EventType, SolamiEvent } from './types.js';

export interface NormalizeError {
  readonly reason: 'not_an_object' | 'unknown_type' | 'invalid_shape';
  readonly type: string | null;
  readonly issues: readonly string[];
}

export type NormalizeResult =
  | { readonly ok: true; readonly event: SolamiEvent }
  | { readonly ok: false; readonly error: NormalizeError };

function isEventType(type: string): type is EventType {
  return Object.hasOwn(EVENT_SCHEMAS, type);
}

export function normalizeEvent(value: unknown, receivedAt: UnixMillis): NormalizeResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: { reason: 'not_an_object', type: null, issues: [] } };
  }
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string' || !isEventType(type)) {
    return {
      ok: false,
      error: {
        reason: 'unknown_type',
        type: typeof type === 'string' ? type : null,
        issues: [`unknown event type: ${JSON.stringify(type)}`],
      },
    };
  }

  const parsed = EVENT_SCHEMAS[type].safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: { reason: 'invalid_shape', type, issues: formatIssues(parsed.error) },
    };
  }
  // Each schema's output is checked against its own event type in schemas.ts (`satisfies`);
  // TypeScript cannot correlate the union of 18 schemas with the union of events here.
  return { ok: true, event: { ...parsed.data, receivedAt } as SolamiEvent };
}
