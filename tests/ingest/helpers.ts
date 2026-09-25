import { readFileSync } from 'node:fs';
import type { WebSocketLike } from '../../src/ingest/live-source.js';

/**
 * A real Blur session, from data/*.jsonl (api key replaced): connected, 60 backfill events,
 * backfill_end, then realtime token_create/pool_create/graduation/swap/transfer/meme. Among the
 * swaps there is a real two-sided pair (same signature+ix+inner_ix, different mint).
 */
export const STREAM_SAMPLE_PATH = new URL('../fixtures/stream-sample.jsonl', import.meta.url).pathname;

export const SESSION: readonly string[] = readFileSync(STREAM_SAMPLE_PATH, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '');

export const typeOf = (line: string): string => (JSON.parse(line) as { type: string }).type;
export const isBackfill = (line: string): boolean => line.includes('"backfill":true');

/** What the server does on reconnect: resends an event byte-identical, flagged as backfill (verified live). */
export function asBackfill(line: string): string {
  return isBackfill(line) ? line : `${line.slice(0, -1)},"backfill":true}`;
}

/** WebSocket double: the test drives the server side. */
export class FakeSocket implements WebSocketLike {
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onerror: WebSocketLike['onerror'] = null;
  onclose: WebSocketLike['onclose'] = null;
  closedByClient = false;

  constructor(readonly url: string) {}

  open(): void {
    this.onopen?.({});
  }

  send(...frames: string[]): void {
    for (const data of frames) this.onmessage?.({ data });
  }

  /** Server/network drops the connection. */
  drop(code = 1006, reason = ''): void {
    this.onerror?.({ message: 'connection reset' });
    this.onclose?.({ code, reason });
  }

  close(): void {
    this.closedByClient = true;
  }
}

export function fakeServer() {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    createSocket: (url: string) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    get last(): FakeSocket {
      const socket = sockets.at(-1);
      if (socket === undefined) throw new Error('no socket opened yet');
      return socket;
    },
  };
}

/** A consumer that keeps pulling into an array (a fast consumer). */
export function collect<T>(iterable: AsyncIterable<T>): { items: T[]; done: Promise<void> } {
  const items: T[] = [];
  const done = (async () => {
    for await (const item of iterable) items.push(item);
  })();
  return { items, done };
}

/** Lets pending promise callbacks run. Uses setImmediate, which the tests do NOT fake. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Fake timers for time-based logic, but real setImmediate so promises can settle. */
export const FAKE_TIMERS: { toFake: ('setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval' | 'Date')[] } = {
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
};
