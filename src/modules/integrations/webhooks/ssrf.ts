// Proteção contra SSRF nos webhooks de saída: em produção, só https para endereço público.
// Checado no cadastro e de novo na entrega (resolução DNS na hora, contra DNS rebinding).

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class DestinationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DestinationError';
    this.code = code;
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (ipv4ToInt(base) >>> (32 - bits)));
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1] as string);
    if (lower === '::' || lower === '::1') return true;
    const first = parseInt(lower.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
    if ((first & 0xff00) === 0xff00) return true; // multicast
    return false;
  }
  return true; // não é IP: trata como bloqueado
}

export interface DestinationPolicy {
  allowPrivate: boolean;
  requireHttps: boolean;
}

export function policyFor(env: 'development' | 'test' | 'production'): DestinationPolicy {
  return env === 'production' ? { allowPrivate: false, requireHttps: true } : { allowPrivate: true, requireHttps: false };
}

/** Validação estática do cadastro (formato, esquema, host literal). */
export function validateEndpointUrl(raw: string, policy: DestinationPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DestinationError('INVALID_URL', 'URL inválida');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new DestinationError('INVALID_URL', 'use http(s)');
  if (policy.requireHttps && url.protocol !== 'https:') throw new DestinationError('HTTPS_REQUIRED', 'em produção o webhook exige https');
  if (url.username || url.password) throw new DestinationError('INVALID_URL', 'credenciais na URL não são aceitas');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!policy.allowPrivate) {
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
      throw new DestinationError('PRIVATE_DESTINATION', 'destino interno não é permitido');
    }
    if (isIP(host) && isPrivateAddress(host)) throw new DestinationError('PRIVATE_DESTINATION', 'destino privado não é permitido');
  }
  return url;
}

/** Na entrega: resolve o host e recusa se qualquer endereço for privado. */
export async function assertDeliverable(url: URL, policy: DestinationPolicy): Promise<void> {
  if (policy.allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new DestinationError('PRIVATE_DESTINATION', 'o host resolve para endereço privado');
  }
}
