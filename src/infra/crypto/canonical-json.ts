// JSON canônico para hash do ledger e assinaturas. Regras (reproduzíveis em qualquer linguagem):
// - chaves de objeto ordenadas por code unit UTF-16 (como Array.prototype.sort padrão), sem espaços;
// - strings escapadas como JSON.stringify;
// - números: só inteiros seguros; bigint é emitido como inteiro (dígitos, sem aspas);
// - propriedades `undefined` são omitidas; `undefined` em array é proibido;
// - NaN, Infinity, frações, Date, Map, Set, funções e símbolos são recusados (o chamador converte antes).

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

export type CanonicalValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

export function canonicalJson(value: unknown): string {
  return encode(value, '$');
}

function encode(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      return value.toString(10);
    case 'number':
      if (!Number.isSafeInteger(value)) throw new CanonicalJsonError(`${path}: só inteiros seguros são permitidos`);
      return Object.is(value, -0) ? '0' : String(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value
          .map((v, i) => {
            if (v === undefined) throw new CanonicalJsonError(`${path}[${i}]: undefined em array`);
            return encode(v, `${path}[${i}]`);
          })
          .join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError(`${path}: só objetos simples são permitidos`);
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${encode(record[k], `${path}.${k}`)}`).join(',')}}`;
    }
    default:
      throw new CanonicalJsonError(`${path}: tipo ${typeof value} não permitido`);
  }
}
