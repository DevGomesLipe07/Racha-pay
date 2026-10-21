// Métricas operacionais no formato de texto do Prometheus (sem dependência). Rótulos de baixa
// cardinalidade apenas: padrão da rota, status, resultado — nunca ids, tokens ou valores de usuário.

type Labels = Record<string, string>;

const key = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`)
    .join(',');

class Counter {
  readonly values = new Map<string, number>();
  readonly name: string;
  readonly help: string;
  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }
  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) out.push(`${this.name}${k ? `{${k}}` : ''} ${v}`);
    return out;
  }
}

class Histogram {
  readonly series = new Map<string, { buckets: number[]; sum: number; count: number }>();
  readonly name: string;
  readonly help: string;
  readonly bounds: number[];
  constructor(name: string, help: string, bounds: number[]) {
    this.name = name;
    this.help = help;
    this.bounds = bounds;
  }
  observe(labels: Labels, value: number): void {
    const k = key(labels);
    const s = this.series.get(k) ?? { buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
    this.bounds.forEach((b, i) => {
      if (value <= b) s.buckets[i] = (s.buckets[i] as number) + 1;
    });
    s.sum += value;
    s.count += 1;
    this.series.set(k, s);
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const sep = k ? `${k},` : '';
      this.bounds.forEach((b, i) => out.push(`${this.name}_bucket{${sep}le="${b}"} ${s.buckets[i]}`));
      out.push(`${this.name}_bucket{${sep}le="+Inf"} ${s.count}`);
      out.push(`${this.name}_sum${k ? `{${k}}` : ''} ${s.sum.toFixed(6)}`);
      out.push(`${this.name}_count${k ? `{${k}}` : ''} ${s.count}`);
    }
    return out;
  }
}

export class MetricsRegistry {
  readonly startedAt = Date.now();
  readonly httpRequests = new Counter('rachapay_http_requests_total', 'Requisições HTTP por rota e status');
  readonly httpDuration = new Histogram('rachapay_http_request_duration_seconds', 'Latência HTTP por rota', [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]);
  readonly workerEvents = new Counter('rachapay_worker_events_total', 'Eventos do worker por tipo e resultado');
  readonly workerErrors = new Counter('rachapay_worker_cycle_errors_total', 'Ciclos do worker que falharam');
  private readonly gauges: (() => string[])[] = [];

  /** Gauge calculado na hora da coleta (ex.: estado do pool do banco). */
  gauge(name: string, help: string, read: () => number | Record<string, number>): void {
    this.gauges.push(() => {
      const v = read();
      const out = [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`];
      if (typeof v === 'number') out.push(`${name} ${v}`);
      else for (const [state, n] of Object.entries(v)) out.push(`${name}{state="${state}"} ${n}`);
      return out;
    });
  }

  render(): string {
    const lines = [
      '# HELP rachapay_uptime_seconds Tempo desde a subida do processo',
      '# TYPE rachapay_uptime_seconds gauge',
      `rachapay_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`,
      ...this.httpRequests.render(),
      ...this.httpDuration.render(),
      ...this.workerEvents.render(),
      ...this.workerErrors.render(),
      ...this.gauges.flatMap((g) => g()),
    ];
    return `${lines.join('\n')}\n`;
  }
}
