import type { AddressInfo } from 'node:net';
import { buildServer, createAIProvider, createRateLimiter } from '../../src/app/app.ts';
import { DEV_SECRETS, loadConfig } from '../../src/config.ts';
import { manualClock } from '../../src/infra/clock.ts';
import { newToken } from '../../src/infra/crypto/hash.ts';
import { silentLogger } from '../../src/infra/log.ts';
import { createProviderRegistry, SandboxProvider } from '../../src/modules/payments/providers.ts';
import { expireDuePayments } from '../../src/app/worker.ts';
import { deliverWebhooks } from '../../src/modules/integrations/webhooks/delivery.ts';
import { runRetention } from '../../src/modules/privacy/retention.ts';
import { MetricsRegistry } from '../../src/infra/metrics.ts';
import { policyFor } from '../../src/modules/integrations/webhooks/ssrf.ts';
import { parseEncryptionKey } from '../../src/infra/crypto/aead.ts';
import { TEST_DATABASE_URL, type TestDb } from './helpers.ts';

export interface TestApp {
  base: string;
  clock: ReturnType<typeof manualClock>;
  sandbox: SandboxProvider;
  runExpiry(): Promise<{ expired: number; failed: number }>;
  runWebhooks(): Promise<{ delivered: number; failed: number; dead: number; fannedOut: number }>;
  runRetention(): Promise<{ anonymized: number; purgedKeys: number }>;
  close(): Promise<void>;
}

export async function startApp(db: TestDb, env: Record<string, string> = {}): Promise<TestApp> {
  // Testes usam o limitador em memória (cada app isolado); o PostgreSQL tem teste próprio (bills-flow).
  const config = loadConfig({ DATABASE_URL: TEST_DATABASE_URL, ...DEV_SECRETS, NODE_ENV: 'test', RATE_LIMIT_STORE: 'memory', ...env });
  const clock = manualClock('2026-10-21T12:00:00.000Z');
  const providers = createProviderRegistry({ sandboxEnabled: config.SANDBOX_ENABLED, sandboxSecret: config.SANDBOX_WEBHOOK_SECRET });
  const server = buildServer({ pool: db.app, config, clock, logger: silentLogger, rateLimiter: createRateLimiter(config, db.app, clock), providers, ai: createAIProvider(config), metrics: new MetricsRegistry() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    clock,
    sandbox: providers.sandbox ?? new SandboxProvider(config.SANDBOX_WEBHOOK_SECRET),
    runExpiry: () => expireDuePayments(db.app, clock, silentLogger),
    runRetention: () => runRetention(db.app, clock, silentLogger),
    runWebhooks: () =>
      deliverWebhooks({ pool: db.app, clock, logger: silentLogger, key: parseEncryptionKey(config.APP_ENCRYPTION_KEY), policy: policyFor('test') }),
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export type Credential = { organizer: string } | { share: string } | { key: string; actor?: string } | { admin: string; actor: string } | undefined;

export async function api<T = any>(app: TestApp, method: string, path: string, opts: { body?: unknown; as?: Credential; headers?: Record<string, string> } = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { ...opts.headers };
  const as = opts.as;
  if (as && 'organizer' in as) headers.authorization = `Bearer ${as.organizer}`;
  if (as && 'share' in as) headers['x-share-token'] = as.share;
  if (as && 'key' in as) {
    headers.authorization = `Bearer ${as.key}`;
    if (as.actor) headers['x-actor-id'] = as.actor;
  }
  if (as && 'admin' in as) {
    headers.authorization = `Bearer ${as.admin}`;
    headers['x-actor-id'] = as.actor;
  }
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${app.base}${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

/** Cria chave de API (como dono — é o que o script tenant:create faz). */
export async function createApiKey(db: TestDb, tenantId: string, scopes: string[], actorType: 'HUMAN' | 'SYSTEM' | 'AI' = 'SYSTEM'): Promise<string> {
  const { token, hash } = newToken('apiKey');
  await db.owner.query('INSERT INTO api_keys (tenant_id, key_hash, name, scopes, actor_type) VALUES ($1, $2, $3, $4, $5)', [
    tenantId,
    hash,
    'teste',
    scopes,
    actorType,
  ]);
  return token;
}
