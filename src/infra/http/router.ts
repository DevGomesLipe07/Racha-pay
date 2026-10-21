// Roteador mínimo: método + padrão com parâmetros (/v1/bills/:id). Sem regex do usuário.

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpRequest {
  method: Method;
  path: string;
  /** Padrão da rota casada — é o que vai para o log (nunca o path com IDs). */
  route: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: unknown;
  rawBody: Buffer;
  clientKey: string;
  correlationId: string;
}

export interface HttpResponse {
  status: number;
  body?: unknown;
  /** Resposta em texto (ex.: /metrics); tem precedência sobre `body`. */
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export type Handler = (req: HttpRequest) => Promise<HttpResponse>;

export interface RouteOptions {
  /** Limite de corpo desta rota (padrão do servidor: 256 KiB). */
  maxBodyBytes?: number;
}

interface Route {
  method: Method;
  pattern: string;
  segments: string[];
  handler: Handler;
  maxBodyBytes?: number;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: Method, pattern: string, handler: Handler, opts: RouteOptions = {}): this {
    this.routes.push({ method, pattern, segments: pattern.split('/').filter(Boolean), handler, ...(opts.maxBodyBytes ? { maxBodyBytes: opts.maxBodyBytes } : {}) });
    return this;
  }

  get(p: string, h: Handler) {
    return this.add('GET', p, h);
  }
  post(p: string, h: Handler, opts?: RouteOptions) {
    return this.add('POST', p, h, opts);
  }
  put(p: string, h: Handler) {
    return this.add('PUT', p, h);
  }
  patch(p: string, h: Handler) {
    return this.add('PATCH', p, h);
  }
  delete(p: string, h: Handler) {
    return this.add('DELETE', p, h);
  }

  /** Casa método + caminho. `allowed` lista os métodos do caminho quando só o método não bate (405). */
  match(method: string, path: string): { route: Route; params: Record<string, string> } | { allowed: Method[] } | undefined {
    const parts = path.split('/').filter(Boolean);
    const allowed: Method[] = [];
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i] as string;
        const part = parts[i] as string;
        if (seg.startsWith(':')) {
          let value: string;
          try {
            value = decodeURIComponent(part);
          } catch {
            ok = false;
            break;
          }
          params[seg.slice(1)] = value;
        } else if (seg !== part) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (route.method === method) return { route, params };
      allowed.push(route.method);
    }
    return allowed.length > 0 ? { allowed } : undefined;
  }

  count(): number {
    return this.routes.length;
  }
}
