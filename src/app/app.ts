// Montagem da aplicação: rotas + servidor HTTP + Web/PWA estática. Sem efeitos colaterais na importação.

import type { Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { unauthorized } from './errors.ts';
import { fileURLToPath } from 'node:url';
import { createHttpServer } from '../infra/http/server.ts';
import { Router } from '../infra/http/router.ts';
import { createStaticHandler } from '../infra/http/static.ts';
import { MemoryRateLimiter, PostgresRateLimiter, rateLimitSalt, type RateLimiter } from '../infra/http/rate-limit.ts';
import type { Pool } from '../infra/db/pool.ts';
import type { Clock } from '../infra/clock.ts';

/** Rate limit conforme a configuração: PostgreSQL (compartilhado) ou memória (por instância). */
export function createRateLimiter(config: Config, pool: Pool, clock: Clock): RateLimiter {
  return config.RATE_LIMIT_STORE === 'memory' ? new MemoryRateLimiter(() => clock.now().getTime()) : new PostgresRateLimiter(pool, () => clock.now().getTime());
}
import type { AppDeps } from './deps.ts';
import { registerBillRoutes } from './routes/bills.ts';
import { registerPaymentRoutes } from './routes/payments.ts';
import { registerWebhookRoutes } from './routes/webhooks.ts';
import { registerErpRoutes } from './routes/erp.ts';
import { registerIntelligenceRoutes } from './routes/intelligence.ts';
import { registerAssistRoutes } from './routes/assist.ts';
import type { Config } from '../config.ts';
import { AnthropicProvider } from '../modules/ai/anthropic-provider.ts';
import { NullAIProvider, type AIProvider } from '../modules/ai/provider.ts';

/** IA conforme a configuração; sem chave, o sistema roda com o NullAIProvider. */
export function createAIProvider(config: Config): AIProvider {
  if (config.AI_PROVIDER === 'anthropic' && config.ANTHROPIC_API_KEY) {
    return new AnthropicProvider({ apiKey: config.ANTHROPIC_API_KEY, model: config.AI_MODEL, ...(config.ANTHROPIC_BASE_URL ? { baseURL: config.ANTHROPIC_BASE_URL } : {}) });
  }
  return new NullAIProvider();
}

export const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

export function buildRouter(deps: AppDeps): Router {
  const router = new Router();

  router.get('/health', async () => ({ status: 200, body: { status: 'ok' } }));
  router.get('/ready', async () => {
    try {
      await deps.pool.query('SELECT 1');
      return { status: 200, body: { status: 'ready' } };
    } catch {
      return { status: 503, body: { status: 'unavailable' } };
    }
  });
  // Prometheus: só com o token de administrador (métricas operacionais, sem dado de cliente).
  router.get('/metrics', async (req) => {
    const auth = req.headers.authorization ?? '';
    const expected = `Bearer ${deps.config.ADMIN_TOKEN}`;
    const a = Buffer.from(auth);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw unauthorized();
    return { status: 200, text: deps.metrics.render(), contentType: 'text/plain; version=0.0.4; charset=utf-8' };
  });

  router.get('/v1/config', async () => ({
    status: 200,
    body: { currency: 'BRL', sandboxEnabled: deps.config.SANDBOX_ENABLED, aiEnabled: deps.config.AI_PROVIDER !== 'none' },
  }));

  registerBillRoutes(router, deps);
  registerPaymentRoutes(router, deps);
  registerWebhookRoutes(router, deps);
  registerErpRoutes(router, deps);
  registerIntelligenceRoutes(router, deps);
  registerAssistRoutes(router, deps);
  return router;
}

export function buildServer(deps: AppDeps): Server {
  const https = deps.config.PUBLIC_BASE_URL.startsWith('https://');
  deps.metrics.gauge('rachapay_db_pool_connections', 'Conexões do pool do banco por estado', () => ({
    total: deps.pool.totalCount,
    idle: deps.pool.idleCount,
    waiting: deps.pool.waitingCount,
  }));
  return createHttpServer({
    router: buildRouter(deps),
    logger: deps.logger,
    https,
    trustProxy: deps.config.TRUST_PROXY,
    staticHandler: createStaticHandler(PUBLIC_DIR, { https }),
    metrics: deps.metrics,
    clientKeySalt: rateLimitSalt(deps.config.APP_ENCRYPTION_KEY),
  });
}
