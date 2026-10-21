import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsRegistry } from '../../src/infra/metrics.ts';

test('Prometheus: contador, histograma e gauge no formato de texto', () => {
  const m = new MetricsRegistry();
  m.httpRequests.inc({ route: 'GET /v1/bills/:id', status: '200' });
  m.httpRequests.inc({ route: 'GET /v1/bills/:id', status: '200' });
  m.httpDuration.observe({ route: 'GET /health' }, 0.003);
  m.httpDuration.observe({ route: 'GET /health' }, 0.2);
  m.gauge('rachapay_db_pool_connections', 'pool', () => ({ idle: 2, waiting: 0 }));
  const text = m.render();
  assert.match(text, /# TYPE rachapay_http_requests_total counter/);
  assert.match(text, /rachapay_http_requests_total\{route="GET \/v1\/bills\/:id",status="200"\} 2/);
  assert.match(text, /rachapay_http_request_duration_seconds_bucket\{route="GET \/health",le="0.005"\} 1/);
  assert.match(text, /rachapay_http_request_duration_seconds_bucket\{route="GET \/health",le="0.25"\} 2/);
  assert.match(text, /rachapay_http_request_duration_seconds_count\{route="GET \/health"\} 2/);
  assert.match(text, /rachapay_db_pool_connections\{state="idle"\} 2/);
  assert.match(text, /rachapay_uptime_seconds \d+/);
});

test('rótulos com aspas e barras são escapados', () => {
  const m = new MetricsRegistry();
  m.workerEvents.inc({ kind: 'a"b\\c', result: 'ok' });
  assert.match(m.render(), /kind="a\\"b\\\\c"/);
});
