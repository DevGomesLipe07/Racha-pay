// Log estruturado em JSON (uma linha por evento). Nunca registrar corpo, query string, token ou IP.
// IDs (uuid) são mascarados para os 8 primeiros caracteres.

export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const UUID = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TOKEN = /\b(rp[osk]_)[A-Za-z0-9_-]{10,}/g;

export function maskValue(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(TOKEN, '$1***').replace(UUID, '$1…');
  return value;
}

export function createLogger(level: Level = 'info', write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Logger {
  const log = (lvl: Level, msg: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const masked: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) masked[k] = k === 'correlationId' ? v : maskValue(v);
    write(JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...masked }));
  };
  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
