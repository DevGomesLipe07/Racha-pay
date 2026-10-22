import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRouter } from '../../src/app/app.ts';
import { buildOpenApi, OPERATIONS } from '../../src/app/openapi.ts';
import { DEV_SECRETS, loadConfig } from '../../src/config.ts';
import { systemClock } from '../../src/infra/clock.ts';
import { MemoryRateLimiter } from '../../src/infra/http/rate-limit.ts';
import { silentLogger } from '../../src/infra/log.ts';
import { MetricsRegistry } from '../../src/infra/metrics.ts';
import { NullAIProvider } from '../../src/modules/ai/provider.ts';
import { createProviderRegistry } from '../../src/modules/payments/providers.ts';
import type { Pool } from '../../src/infra/db/pool.ts';

test('OpenAPI cobre exatamente as rotas registradas (nem a mais, nem a menos)', () => {
  const config = loadConfig({ DATABASE_URL: 'postgresql://x@localhost/x', ...DEV_SECRETS });
  const router = buildRouter({
    pool: {} as Pool,
    config,
    clock: systemClock,
    logger: silentLogger,
    rateLimiter: new MemoryRateLimiter(),
    providers: createProviderRegistry({ sandboxEnabled: true, sandboxSecret: DEV_SECRETS.SANDBOX_WEBHOOK_SECRET }),
    ai: new NullAIProvider(),
    metrics: new MetricsRegistry(),
  });
  const registered = router
    .list()
    .map((r) => `${r.method} ${r.pattern.replace(/:(\w+)/g, '{$1}')}`)
    .sort();
  const documented = OPERATIONS.map((o) => `${o.method.toUpperCase()} ${o.path}`).sort();
  assert.deepEqual(documented, registered);
});

test('OpenAPI 3.1 válido no essencial: corpos vindos dos schemas Zod, segurança e Idempotency-Key', () => {
  const doc = buildOpenApi('https://rachapay.example') as any;
  assert.equal(doc.openapi, '3.1.0');
  const create = doc.paths['/v1/payments'].post;
  assert.ok(create.parameters.some((p: { name: string; required: boolean }) => p.name === 'Idempotency-Key' && p.required));
  const body = create.requestBody.content['application/json'].schema;
  assert.deepEqual(body.required.sort(), ['billId', 'participantId']);
  assert.equal(body.properties.amountCents.type, 'integer');
  assert.ok(doc.paths['/v1/integrations/erp/{provider}/sync'].post.requestBody.content['application/json'].schema.properties.externalReference);
  for (const [path, ops] of Object.entries<any>(doc.paths)) {
    for (const op of Object.values<any>(ops)) {
      assert.ok(op.summary, `${path} sem resumo`);
      assert.ok(op.security.length > 0, `${path} sem segurança declarada`);
    }
  }
  assert.ok(doc.components.securitySchemes.apiKey);
});
