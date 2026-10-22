// Cliente da API. O token de capacidade vem do fragmento da URL (#) e vai só no cabeçalho.

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Só caminhos da própria API, sem "..", sem esquema/host e sem caracteres de controle: um link malicioso
// (#/o/../outra-rota/…) não consegue fazer o navegador chamar outra rota com a credencial da vítima.
const SAFE_PATH = /^\/v1\/[A-Za-z0-9\-_/]*(\?[A-Za-z0-9\-_=&.:%]*)?$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safePath(path) {
  if (typeof path !== 'string' || !SAFE_PATH.test(path) || path.includes('..') || path.includes('//')) {
    throw new ApiError(0, 'INVALID_PATH', 'endereço inválido');
  }
  return path;
}

export function createApi(cred) {
  async function request(method, path, body, headers = {}) {
    const url = safePath(path);
    const h = { ...headers };
    if (cred?.organizer) h.authorization = `Bearer ${cred.organizer}`;
    if (cred?.share) h['x-share-token'] = cred.share;
    if (cred?.key) h.authorization = `Bearer ${cred.key}`;
    if (cred?.actor) h['x-actor-id'] = cred.actor;
    if (body !== undefined) h['content-type'] = 'application/json';
    let res;
    try {
      res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'omit' });
    } catch {
      throw new ApiError(0, 'NETWORK', 'sem conexão com o servidor');
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const e = data?.error ?? {};
      throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? `erro ${res.status}`, e.details);
    }
    return data;
  }
  return {
    get: (p) => request('GET', p),
    post: (p, b, h) => request('POST', p, b ?? {}, h),
    patch: (p, b) => request('PATCH', p, b),
    put: (p, b) => request('PUT', p, b),
    del: (p) => request('DELETE', p),
  };
}

export function newKey() {
  return crypto.randomUUID();
}
