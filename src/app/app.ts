// Montagem da aplicação: rotas + servidor HTTP. Sem efeitos colaterais na importação (testável).

import type { Server } from 'node:http';
import { createHttpServer } from '../infra/http/server.ts';
import { Router } from '../infra/http/router.ts';
import type { AppDeps } from './deps.ts';
import { registerBillRoutes } from './routes/bills.ts';

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
  return router;
}

export function buildServer(deps: AppDeps): Server {
  return createHttpServer({
    router: buildRouter(deps),
    logger: deps.logger,
    https: deps.config.PUBLIC_BASE_URL.startsWith('https://'),
    trustProxy: deps.config.TRUST_PROXY,
  });
}
