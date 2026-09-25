/**
 * Lossless JSON parsing.
 *
 * Solami sends raw token amounts (reserves, swap amounts) as JSON numbers. Some exceed
 * Number.MAX_SAFE_INTEGER (2^53 - 1): e.g. `"base_reserve":11196105564446459` becomes
 * 11196105564446460 after a plain JSON.parse — silently, before our code ever sees it.
 *
 * Node 24+ passes the original source text to the reviver (`context.source`, TC39
 * "JSON.parse source text access"), so unsafe integers are rebuilt exactly as bigint.
 * Safe integers and decimals stay as `number`; the schemas decide what each field may be.
 */

interface ReviverContext {
  readonly source?: string;
}

const INTEGER_LITERAL = /^-?\d+$/;

function reviver(_key: string, value: unknown, context?: ReviverContext): unknown {
  if (typeof value !== 'number' || Number.isSafeInteger(value)) return value;
  const source = context?.source;
  if (source === undefined) {
    throw new Error('Lossless JSON parsing requires Node.js >= 24 (JSON.parse source text access)');
  }
  return INTEGER_LITERAL.test(source) ? BigInt(source) : value;
}

export function parseJsonLossless(text: string): unknown {
  return JSON.parse(text, reviver as Parameters<typeof JSON.parse>[1]);
}
