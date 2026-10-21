// Montagem da aplicação: rotas + servidor HTTP + Web/PWA estática. Sem efeitos colaterais na importação.

import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHttpServer } from '../infra/http/server.ts';
import { Router } from '../infra/http/router.ts';
import { createStaticHandler } from '../infra/http/static.ts';
import type { AppDeps } from './deps.ts';
import { registerBillRoutes } from './routes/bills.ts';
import { registerPaymentRoutes } from './routes/payments.ts';
import { registerWebhookRoutes } from './routes/webhooks.ts';
import { registerErpRoutes } from './routes/erp.ts';
import { registerIntelligenceRoutes } from './routes/intelligence.ts';

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
  router.get('/v1/config', async () => ({
    status: 200,
    body: { currency: 'BRL', sandboxEnabled: deps.config.SANDBOX_ENABLED, aiEnabled: deps.config.AI_PROVIDER !== 'none' },
  }));

  registerBillRoutes(router, deps);
  registerPaymentRoutes(router, deps);
  registerWebhookRoutes(router, deps);
  registerErpRoutes(router, deps);
  registerIntelligenceRoutes(router, deps);
  return router;
}

export function buildServer(deps: AppDeps): Server {
  const https = deps.config.PUBLIC_BASE_URL.startsWith('https://');
  return createHttpServer({
    router: buildRouter(deps),
    logger: deps.logger,
    https,
    trustProxy: deps.config.TRUST_PROXY,
    staticHandler: createStaticHandler(PUBLIC_DIR, { https }),
  });
}
