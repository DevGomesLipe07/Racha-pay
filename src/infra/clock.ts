// Relógio injetável (D15): o domínio e os serviços nunca chamam Date.now() direto.

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Relógio de teste: começa em `start` e só anda quando mandado. */
export function manualClock(start: Date | string): Clock & { advance(ms: number): void; set(at: Date | string): void } {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
    set(at: Date | string) {
      current = new Date(at);
    },
  };
}
