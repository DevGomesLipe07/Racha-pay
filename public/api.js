// Cliente da API. O token de capacidade vem do fragmento da URL (#) e vai só no cabeçalho.

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function createApi(cred) {
  async function request(method, path, body, headers = {}) {
    const h = { ...headers };
    if (cred?.organizer) h.authorization = `Bearer ${cred.organizer}`;
    if (cred?.share) h['x-share-token'] = cred.share;
    if (body !== undefined) h['content-type'] = 'application/json';
    let res;
    try {
      res = await fetch(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
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
