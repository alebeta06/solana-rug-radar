/**
 * Observable health: `GET /health` (JSON; 200 healthy, 503 not) for Docker, plus a one-line
 * summary for the periodic log. The same server serves the phase-5 dashboard (`routes`).
 */
import { createServer, type Server } from 'node:http';
import { elapsedMillis, type Clock, type UnixMillis } from '../core/time.js';
import type { SourceHealth } from './source.js';

export function isHealthy(health: SourceHealth, now: UnixMillis, staleAfterMs: number): boolean {
  if (health.origin === 'replay') return true;
  if (health.state !== 'live' && health.state !== 'backfilling') return false;
  return health.lastFrameAt !== null && elapsedMillis(health.lastFrameAt, now) < staleAfterMs;
}

export function summarizeHealth(health: SourceHealth, now: UnixMillis): string {
  const age = health.lastFrameAt === null ? 'never' : `${elapsedMillis(health.lastFrameAt, now)}ms ago`;
  const types = Object.entries(health.byType)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, c]) => `${type}=${c.delivered}${c.duplicates ? ` dup${c.duplicates}` : ''}${c.dropped ? ` DROP${c.dropped}` : ''}`)
    .join(' ');
  const m = health.malformed;
  const malformed = m.invalidJson + m.notAnObject + m.unknownType + m.invalidShape;
  const parts = [
    `[health] ${health.origin}/${health.state}`,
    `last frame ${age}`,
    `frames=${health.frames}`,
    malformed ? `MALFORMED=${malformed}` : '',
    health.queue ? `queue=${health.queue.length}/${health.queue.capacity}` : '',
    health.connection ? `reconnects=${health.connection.reconnects}` : '',
    health.connection?.lastError ? `lastError="${health.connection.lastError}"` : '',
    health.persistence ? `disk=${(health.persistence.bytesWritten / 1e6).toFixed(1)}MB` : '',
    health.persistence?.droppedLines ? `diskDropped=${health.persistence.droppedLines}` : '',
    health.persistence?.lastError ? `diskError="${health.persistence.lastError}"` : '',
    `| ${types}`,
  ];
  return parts.filter(Boolean).join(' ');
}

/** A GET route served next to /health (the phase-5 dashboard: its page and its data). */
export type Route = () => { readonly type: string; readonly body: string };

/** `getState`: what the memory knows (phase 3), served under `state`. `routes`: path → extra GET route. */
export function startHealthServer(
  port: number,
  getHealth: () => SourceHealth,
  clock: Clock,
  staleAfterMs: number,
  getState?: () => unknown,
  routes: Readonly<Record<string, Route>> = {},
): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const route = Object.hasOwn(routes, path) ? routes[path] : undefined;
    if (req.method === 'GET' && route !== undefined) {
      try {
        const { type, body } = route();
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
      } catch (error) {
        // A bug in a view must never take the detector down with it.
        res.writeHead(500, { 'content-type': 'text/plain' }).end(error instanceof Error ? error.message : 'error');
      }
      return;
    }
    if (req.method !== 'GET' || path !== '/health') {
      res.writeHead(404).end();
      return;
    }
    const health = getHealth();
    const healthy = isHealthy(health, clock(), staleAfterMs);
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ healthy, ...health, ...(getState ? { state: getState() } : {}) }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}
