// Arquivos estáticos da Web/PWA (sem build). Só serve arquivos dentro de `root`; nada de listagem.

import { open } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { SECURITY_HEADERS } from './server.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Sempre revalidados (shell do app e service worker); o resto pode ficar 1 h em cache. */
const NO_CACHE = new Set(['/index.html', '/sw.js', '/manifest.webmanifest']);

export function createStaticHandler(root: string, opts: { https: boolean }) {
  const base = normalize(root.endsWith(sep) ? root : root + sep);
  return async (path: string, res: ServerResponse): Promise<boolean> => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return false;
    }
    if (decoded.includes('\0')) return false;
    const rel = decoded === '/' ? '/index.html' : decoded;
    const file = normalize(join(base, rel));
    if (!file.startsWith(base)) return false;
    const ext = extname(file).toLowerCase();
    const type = TYPES[ext];
    if (!type) return false;
    let handle;
    try {
      // Abre uma vez e checa/lê pelo mesmo descritor (sem janela entre "é arquivo?" e "ler").
      handle = await open(file, 'r');
      const info = await handle.stat();
      if (!info.isFile()) return false;
      const body = await handle.readFile();
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        ...(opts.https ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
        'Content-Type': type,
        'Content-Length': String(body.length),
        'Cache-Control': NO_CACHE.has(rel) ? 'no-cache' : 'public, max-age=3600',
      });
      res.end(body);
      return true;
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };
}
