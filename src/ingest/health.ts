/**
 * Observable health: `GET /health` (JSON; 200 healthy, 503 not) for Docker and the phase-5
 * dashboard, plus a one-line summary for the periodic log.
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

export function startHealthServer(
  port: number,
  getHealth: () => SourceHealth,
  clock: Clock,
  staleAfterMs: number,
): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    const health = getHealth();
    const healthy = isHealthy(health, clock(), staleAfterMs);
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ healthy, ...health }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}
