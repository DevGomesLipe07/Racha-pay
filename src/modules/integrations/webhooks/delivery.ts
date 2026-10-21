// Entrega dos webhooks de saída (03 § Webhooks; D17). At-least-once, assinada, com retentativa.
// Fan-out (evento → entrega por endpoint) e envio ficam fora da transação de negócio. A entrega é
// "reservada" por lease (next_attempt_at no futuro) antes do HTTP, para não segurar trava durante a rede.

import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../../../infra/crypto/aead.ts';
import { hmacSha256Hex } from '../../../infra/crypto/hash.ts';
import type { Clock } from '../../../infra/clock.ts';
import type { Pool, PoolClient } from '../../../infra/db/pool.ts';
import { withoutScope, withScope } from '../../../infra/db/tx.ts';
import type { Logger } from '../../../infra/log.ts';
import { resolveKnowledge } from '../../expert/library.ts';
import { WEBHOOK_EVENT_TYPES, WEBHOOK_PAYLOAD_VERSION, type WebhookEventType } from './outbox.ts';
import { assertDeliverable, validateEndpointUrl, type DestinationPolicy } from './ssrf.ts';

const LEASE_MS = 60_000;
const TIMEOUT_MS = 10_000;

export interface RetryRule {
  maxAttempts: number;
  baseSeconds: number;
  maxIntervalSeconds: number;
}

/** Atraso até a próxima tentativa depois da falha número `attempt` (1-based), ou null = DEAD. */
export function nextDelaySeconds(attempt: number, rule: RetryRule): number | null {
  if (attempt >= rule.maxAttempts) return null;
  return Math.min(rule.baseSeconds * 2 ** (attempt - 1), rule.maxIntervalSeconds);
}

export function signWebhook(secret: string, body: string, unixSeconds: number): string {
  return `t=${unixSeconds},v1=${hmacSha256Hex(secret, `${unixSeconds}.${body}`)}`;
}

// ---------------------------------------------------------------------------
// Endpoints

export async function createEndpoint(
  client: PoolClient,
  tenantId: string,
  input: { url: string; events: WebhookEventType[]; description?: string },
  key: Buffer,
  policy: DestinationPolicy,
): Promise<{ id: string; secret: string }> {
  validateEndpointUrl(input.url, policy);
  for (const e of input.events) if (!WEBHOOK_EVENT_TYPES.includes(e)) throw new Error(`evento desconhecido: ${e}`);
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  const { rows } = await client.query<{ id: string }>('SELECT gen_random_uuid() AS id');
  const id = (rows[0] as { id: string }).id;
  await client.query(
    'INSERT INTO webhook_endpoints (id, tenant_id, url, secret_encrypted, events, description) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, tenantId, input.url, encryptSecret(key, secret, `endpoint:${id}`), input.events, input.description ?? null],
  );
  return { id, secret };
}

// ---------------------------------------------------------------------------
// Worker

interface DeliveryJob {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  attempts: number;
  url: string;
  secret_encrypted: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

export interface DeliveryDeps {
  pool: Pool;
  clock: Clock;
  logger: Logger;
  key: Buffer;
  policy: DestinationPolicy;
  fetchImpl?: typeof fetch;
}

async function fanOut(client: PoolClient, tenantId: string, now: Date): Promise<number> {
  const events = await client.query<{ id: string; type: string }>(
    `SELECT id, type FROM outbox_events WHERE tenant_id = $1 AND dispatched_at IS NULL ORDER BY created_at LIMIT 200 FOR UPDATE SKIP LOCKED`,
    [tenantId],
  );
  if (events.rowCount === 0) return 0;
  const endpoints = await client.query<{ id: string; events: string[] }>('SELECT id, events FROM webhook_endpoints WHERE tenant_id = $1 AND active', [tenantId]);
  for (const ev of events.rows) {
    for (const ep of endpoints.rows) {
      if (ep.events.length > 0 && !ep.events.includes(ev.type)) continue;
      await client.query(
        `INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, status, next_attempt_at, created_at)
         VALUES ($1, $2, $3, $4, 'PENDING', $5, $5) ON CONFLICT (endpoint_id, event_id) DO NOTHING`,
        [tenantId, ep.id, ev.id, ev.type, now],
      );
    }
    await client.query('UPDATE outbox_events SET dispatched_at = $2 WHERE id = $1', [ev.id, now]);
  }
  return events.rowCount ?? 0;
}

async function claim(client: PoolClient, tenantId: string, now: Date): Promise<DeliveryJob[]> {
  const { rows } = await client.query<DeliveryJob>(
    `SELECT d.id, d.endpoint_id, d.event_id, d.event_type, d.attempts, e.url, e.secret_encrypted, o.payload, o.created_at
       FROM webhook_deliveries d
       JOIN webhook_endpoints e ON e.id = d.endpoint_id
       JOIN outbox_events o ON o.id = d.event_id
      WHERE d.tenant_id = $1 AND d.status IN ('PENDING', 'RETRYING') AND d.next_attempt_at <= $2 AND e.active
      ORDER BY d.next_attempt_at LIMIT 50
      FOR UPDATE OF d SKIP LOCKED`,
    [tenantId, now],
  );
  for (const job of rows) {
    await client.query('UPDATE webhook_deliveries SET next_attempt_at = $2 WHERE id = $1', [job.id, new Date(now.getTime() + LEASE_MS)]);
  }
  return rows;
}

async function send(job: DeliveryJob, deps: DeliveryDeps, now: Date): Promise<{ ok: boolean; status?: number; error?: string }> {
  const body = JSON.stringify({
    id: job.event_id,
    type: job.event_type,
    version: WEBHOOK_PAYLOAD_VERSION,
    createdAt: job.created_at.toISOString(),
    data: job.payload,
  });
  try {
    const url = new URL(job.url);
    await assertDeliverable(url, deps.policy);
    const secret = decryptSecret(deps.key, job.secret_encrypted, `endpoint:${job.endpoint_id}`);
    const res = await (deps.fetchImpl ?? fetch)(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'RachaPay-Webhooks/1',
        'x-rachapay-event': job.event_type,
        'x-rachapay-event-id': job.event_id,
        'x-rachapay-delivery': job.id,
        'x-rachapay-signature': signWebhook(secret, body, Math.floor(now.getTime() / 1000)),
      },
      body,
    });
    await res.body?.cancel().catch(() => undefined);
    return res.status >= 200 && res.status < 300 ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: ((e as Error).message ?? 'erro').slice(0, 300) };
  }
}

export async function deliverWebhooks(deps: DeliveryDeps): Promise<{ delivered: number; failed: number; dead: number; fannedOut: number }> {
  const now = deps.clock.now();
  const result = { delivered: 0, failed: 0, dead: 0, fannedOut: 0 };
  const { rows: tenants } = await withoutScope(deps.pool, (c) => c.query<{ tenant_id: string }>('SELECT * FROM rp_webhook_work($1)', [now]));
  for (const { tenant_id: tenantId } of tenants) {
    const scope = { kind: 'tenant' as const, tenantId };
    const { jobs, rule } = await withScope(deps.pool, scope, async (client) => {
      result.fannedOut += await fanOut(client, tenantId, now);
      const retry = await resolveKnowledge(client, 'WEBHOOK.RETRY', { tenantId }, now);
      return { jobs: await claim(client, tenantId, now), rule: retry.content };
    });
    for (const job of jobs) {
      const outcome = await send(job, deps, now);
      const attempt = job.attempts + 1;
      await withScope(deps.pool, scope, async (client) => {
        if (outcome.ok) {
          result.delivered++;
          await client.query(
            "UPDATE webhook_deliveries SET status = 'DELIVERED', attempts = $2, last_status_code = $3, last_error = NULL, delivered_at = $4 WHERE id = $1",
            [job.id, attempt, outcome.status, now],
          );
          return;
        }
        const delay = nextDelaySeconds(attempt, rule);
        if (delay === null) result.dead++;
        else result.failed++;
        await client.query(
          `UPDATE webhook_deliveries SET status = $2, attempts = $3, last_status_code = $4, last_error = $5, next_attempt_at = $6 WHERE id = $1`,
          [job.id, delay === null ? 'DEAD' : 'RETRYING', attempt, outcome.status ?? null, outcome.error ?? null, new Date(now.getTime() + (delay ?? 0) * 1000)],
        );
      });
      if (!outcome.ok) deps.logger.warn('webhook_delivery_failed', { deliveryId: job.id, attempt, error: outcome.error });
    }
  }
  return result;
}
