// Servidor HTTP sobre node:http: headers de segurança, limite de corpo, JSON, correlationId,
// envelope de erro e log sem corpo, sem query string e com o padrão da rota (não o path com IDs).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AppError, toAppError } from '../../app/errors.ts';
import type { Logger } from '../log.ts';
import { clientKeyFromIp } from './rate-limit.ts';
import type { HttpRequest, HttpResponse, Method, Router } from './router.ts';

const MAX_BODY_BYTES = 256 * 1024;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const CORRELATION = /^[A-Za-z0-9._-]{8,100}$/;

export interface ServerOptions {
  router: Router;
  logger: Logger;
  https: boolean;
  trustProxy: boolean;
  /** Arquivos estáticos (PWA); chamado para GET fora de /v1, /health e /ready. */
  staticHandler?: (path: string, res: ServerResponse) => Promise<boolean>;
}

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'corpo da requisição grande demais');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'corpo da requisição grande demais');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, response: HttpResponse, correlationId: string, https: boolean): void {
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'X-Correlation-Id': correlationId,
    ...(https ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
    ...response.headers,
  };
  if (response.body === undefined) {
    res.writeHead(response.status, headers);
    res.end();
    return;
  }
  const payload = JSON.stringify(response.body);
  res.writeHead(response.status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(payload)) });
  res.end(payload);
}

export function errorBody(error: AppError, correlationId: string) {
  return { error: { code: error.code, message: error.message, details: error.details, correlationId } };
}

export function createHttpServer(opts: ServerOptions): Server {
  return createServer((req, res) => {
    void handle(req, res, opts);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, opts: ServerOptions): Promise<void> {
  const started = performance.now();
  const incoming = req.headers['x-correlation-id'];
  const correlationId = typeof incoming === 'string' && CORRELATION.test(incoming) ? incoming : randomUUID();
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  let route = 'unmatched';
  let status = 500;
  try {
    const method = (req.method ?? 'GET').toUpperCase();
    const isApi = path.startsWith('/v1/') || path === '/health' || path === '/ready';
    if (!isApi && method === 'GET' && opts.staticHandler) {
      route = 'static';
      if (await opts.staticHandler(path, res)) {
        status = res.statusCode;
        return;
      }
    }
    if (!METHODS.has(method)) throw new AppError(405, 'METHOD_NOT_ALLOWED', 'método não permitido');
    const matched = opts.router.match(method, path);
    if (!matched) throw new AppError(404, 'NOT_FOUND', 'rota não encontrada');
    if ('allowed' in matched) {
      throw new AppError(405, 'METHOD_NOT_ALLOWED', 'método não permitido', { allowed: matched.allowed });
    }
    route = `${method} ${matched.route.pattern}`;

    const rawBody = method === 'GET' || method === 'DELETE' ? Buffer.alloc(0) : await readBody(req, matched.route.maxBodyBytes ?? MAX_BODY_BYTES);
    let body: unknown;
    if (rawBody.length > 0) {
      const type = req.headers['content-type'] ?? '';
      if (!type.toLowerCase().startsWith('application/json')) {
        throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'envie application/json');
      }
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw new AppError(400, 'INVALID_JSON', 'JSON inválido');
      }
    }
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;

    const request: HttpRequest = {
      method: method as Method,
      path,
      route: matched.route.pattern,
      params: matched.params,
      query: url.searchParams,
      headers,
      body,
      rawBody,
      clientKey: clientKeyFromIp(clientIp(req, opts.trustProxy)),
      correlationId,
    };
    const response = await matched.route.handler(request);
    status = response.status;
    send(res, response, correlationId, opts.https);
  } catch (error) {
    const appError = toAppError(error);
    status = appError.status;
    if (status >= 500) {
      opts.logger.error('request_failed', { correlationId, route, error: (error as Error)?.name, message: (error as Error)?.message });
    }
    if (!res.headersSent) {
      send(res, { status, body: errorBody(appError, correlationId), ...(status === 429 && appError.details.retryAfterSeconds ? { headers: { 'Retry-After': String(appError.details.retryAfterSeconds) } } : {}) }, correlationId, opts.https);
    } else {
      res.destroy();
    }
  } finally {
    opts.logger.info('request', { route, status, ms: Math.round(performance.now() - started), correlationId });
  }
}
