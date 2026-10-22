// Painel do estabelecimento (#/b): mesas abertas, abrir mesa + QR, gestão da conta (mesma tela do
// organizador), divergências do ERP e outros casos, entregas de webhook e conciliação do dia.
// Login com a chave de API do operador (rpk_…): fica só nesta aba (sessionStorage) e vai só no cabeçalho.

import { createApi } from './api.js';
import { brl, STATE_LABEL } from './format.js';
import { actionButton, el, mount, toast } from './ui.js';

const SESSION_KEY = 'rachapay.business';

function session() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null');
  } catch {
    return null;
  }
}

function saveSession(value) {
  try {
    if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* aba privada sem storage: o login vale só até recarregar */
  }
}

const TABS = [
  ['mesas', 'Mesas'],
  ['casos', 'Casos'],
  ['webhooks', 'Webhooks'],
  ['dia', 'Dia'],
];

function nav(active) {
  return el(
    'nav',
    { class: 'row card', 'aria-label': 'Painel' },
    TABS.map(([id, label]) => el('a', { class: id === active ? 'button primary' : 'button', href: `#/b/${id}`, 'data-testid': `tab-${id}` }, label)),
    el('button', { type: 'button', class: 'link', on: { click: () => { saveSession(null); location.hash = '#/b'; } } }, 'sair'),
  );
}

export async function businessView(parts, deps) {
  const s = session();
  if (!s) return loginView(deps);
  const api = createApi({ key: s.key, actor: s.actor });
  const [tab, id] = parts;
  try {
    if (tab === 'm' && id) return await tableView(api, id, deps);
    if (tab === 'casos') return await casesView(api, deps);
    if (tab === 'webhooks') return await webhooksView(api, deps);
    if (tab === 'dia') return await dayView(api, deps);
    return await tablesView(api, deps, s);
  } catch (e) {
    if (e.status === 401) {
      saveSession(null);
      toast('Sessão inválida: entre de novo', true);
      return loginView(deps);
    }
    mount(deps.app, nav(tab ?? 'mesas'), el('section', { class: 'card' }, el('h1', {}, 'Não deu para carregar'), el('p', { class: 'muted' }, e.message)));
  }
}

function loginView(deps) {
  const key = el('input', { 'data-testid': 'biz-key', type: 'password', autocomplete: 'off', placeholder: 'rpk_…' });
  const actor = el('input', { 'data-testid': 'biz-actor', maxlength: 60, placeholder: 'Ex.: caixa-ana' });
  mount(
    deps.app,
    el(
      'section',
      { class: 'card stack' },
      el('h1', {}, 'Painel do estabelecimento'),
      el('p', { class: 'muted small' }, 'Use a chave de operador do seu estabelecimento. Ela fica só nesta aba e some ao fechar.'),
      el('div', {}, el('label', {}, 'Chave de API'), key),
      el('div', {}, el('label', {}, 'Quem está operando (aparece na auditoria)'), actor),
      actionButton(
        'Entrar',
        async () => {
          const value = { key: key.value.trim(), actor: actor.value.trim().replace(/[^A-Za-z0-9@._:-]/g, '-') || 'operador' };
          if (!/^rpk_[A-Za-z0-9_-]{43}$/.test(value.key)) throw new Error('chave inválida');
          await createApi(value).get('/v1/establishments');
          saveSession(value);
          location.hash = '#/b/mesas';
        },
        { class: 'primary full', 'data-testid': 'biz-login' },
      ),
    ),
  );
}

async function tablesView(api, deps, s) {
  const { establishments } = await api.get('/v1/establishments');
  const est = establishments.find((e) => e.id === s.establishmentId) ?? establishments[0];
  if (est && est.id !== s.establishmentId) saveSession({ ...s, establishmentId: est.id });
  const { bills } = await api.get(`/v1/bills?open=true${est ? `&establishmentId=${est.id}` : ''}`);

  const select = el('select', { 'data-testid': 'biz-establishment' }, establishments.map((e) => el('option', { value: e.id }, e.name)));
  if (est) select.value = est.id;
  select.addEventListener('change', () => {
    saveSession({ ...session(), establishmentId: select.value });
    businessView(['mesas'], deps);
  });

  const table = el('input', { 'data-testid': 'biz-table', maxlength: 40, placeholder: 'Ex.: 12' });
  const people = el('input', { 'data-testid': 'biz-people', placeholder: 'Ana, Bruno (opcional)' });
  const newEstId = el('input', { maxlength: 120, placeholder: 'código (ex.: loja-centro)' });
  const newEstName = el('input', { maxlength: 120, placeholder: 'nome' });

  mount(
    deps.app,
    nav('mesas'),
    establishments.length === 0
      ? el(
          'section',
          { class: 'card stack' },
          el('h2', {}, 'Cadastre o primeiro estabelecimento'),
          el('div', { class: 'grid2' }, newEstId, newEstName),
          actionButton('Cadastrar', async () => {
            await api.post('/v1/establishments', { externalId: newEstId.value.trim(), name: newEstName.value.trim() });
            businessView(['mesas'], deps);
          }, { class: 'primary' }),
        )
      : el('section', { class: 'card stack' }, el('label', {}, 'Estabelecimento'), select),
    est &&
      el(
        'section',
        { class: 'card stack' },
        el('h2', {}, 'Abrir mesa'),
        el('div', { class: 'grid2' }, el('div', {}, el('label', {}, 'Mesa'), table), el('div', {}, el('label', {}, 'Quem está na mesa'), people)),
        actionButton(
          'Abrir',
          async () => {
            const label = table.value.trim();
            if (!label) throw new Error('informe a mesa');
            const names = people.value.split(',').map((n) => n.trim()).filter(Boolean);
            const r = await api.post('/v1/bills', { kind: 'RESTAURANT', title: `Mesa ${label}`, tableLabel: label, establishmentId: est.id, ...(names.length ? { participants: names } : {}) });
            deps.remember({ id: r.bill.id, title: r.bill.title, role: 'b', share: r.shareToken });
            location.hash = `#/b/m/${r.bill.id}`;
          },
          { class: 'primary', 'data-testid': 'biz-open' },
        ),
      ),
    el(
      'section',
      { class: 'card' },
      el('h2', {}, `Mesas abertas (${bills.length})`),
      bills.length === 0
        ? el('p', { class: 'muted' }, 'Nenhuma mesa aberta.')
        : el(
            'ul',
            { class: 'list', 'data-testid': 'biz-bills' },
            bills.map((b) =>
              el(
                'li',
                { class: 'spread' },
                el(
                  'a',
                  { href: `#/b/m/${b.id}`, 'data-testid': `biz-bill-${b.tableLabel ?? b.id}` },
                  b.title,
                  el('br'),
                  el('span', { class: 'muted small' }, `${STATE_LABEL[b.state] ?? b.state} · ${b.participants} pessoa(s)`),
                ),
                el(
                  'span',
                  { class: 'row' },
                  b.pendingManualPayments > 0 && el('span', { class: 'badge warn' }, `${b.pendingManualPayments} a confirmar`),
                  b.openCases > 0 && el('span', { class: 'badge warn' }, `${b.openCases} caso(s)`),
                  el('span', { class: 'money' }, b.totalCents === null ? '—' : brl(b.totalCents)),
                ),
              ),
            ),
          ),
    ),
  );
  deps.setPoller(
    setInterval(async () => {
      if (document.hidden || document.activeElement?.tagName === 'INPUT') return;
      const fresh = await api.get(`/v1/bills?open=true${est ? `&establishmentId=${est.id}` : ''}`).catch(() => null);
      if (fresh && JSON.stringify(fresh.bills.map((b) => [b.id, b.state, b.pendingManualPayments, b.totalCents])) !== JSON.stringify(bills.map((b) => [b.id, b.state, b.pendingManualPayments, b.totalCents]))) {
        businessView(['mesas'], deps);
      }
    }, 5000),
  );
}

async function tableView(api, id, deps) {
  const load = () => api.get(`/v1/bills/${id}`).then((r) => r.bill);
  const bill = await load();
  const back = nav('mesas');
  const rerender = (b) => deps.renderOrganizer(api, b, load, null, { business: true, back });
  rerender(bill);
  deps.poll(load, deps.billSignature, rerender, bill);
}

async function casesView(api, deps) {
  const { cases } = await api.get('/v1/cbr/cases?status=OPEN');
  mount(
    deps.app,
    nav('casos'),
    el(
      'section',
      { class: 'card' },
      el('h2', {}, `Casos abertos (${cases.length})`),
      el('p', { class: 'muted small' }, 'Divergências do ERP, pagamentos recusados, estornos e outras exceções. A decisão é sempre humana; decisões repetidas viram sugestão de regra para revisão.'),
      cases.length === 0
        ? el('p', { class: 'muted' }, 'Nenhum caso aberto.')
        : el(
            'ul',
            { class: 'list', 'data-testid': 'biz-cases' },
            cases.map((c) => {
              const decision = el('input', { maxlength: 120, placeholder: 'decisão (ex.: CONTACT_PAYER)', 'data-testid': 'case-decision' });
              const outcome = el('input', { maxlength: 500, placeholder: 'o que aconteceu', 'data-testid': 'case-outcome' });
              return el(
                'li',
                { class: 'stack' },
                el('div', { class: 'spread' }, el('strong', {}, c.kind), el('a', { href: `#/b/m/${c.billId}` }, 'ver conta')),
                c.evidence?.divergence && el('p', { class: 'small' }, c.evidence.divergence.map((d) => `${d.itemRef ?? ''} ${d.reason}`.trim()).join(' · ')),
                el('div', { class: 'grid2' }, decision, outcome),
                actionButton('Resolver', async () => {
                  const r = await api.post(`/v1/cbr/cases/${c.id}/resolve`, { decision: decision.value.trim(), outcome: outcome.value.trim() });
                  toast(r.proposal ? 'Resolvido. Padrão detectado: proposta de regra criada para revisão.' : 'Caso resolvido.');
                  businessView(['casos'], deps);
                }),
              );
            }),
          ),
    ),
  );
}

async function webhooksView(api, deps) {
  const [{ endpoints }, { deliveries }] = [await api.get('/v1/webhook-endpoints'), await api.get('/v1/webhook-deliveries?limit=100')];
  mount(
    deps.app,
    nav('webhooks'),
    el(
      'section',
      { class: 'card' },
      el('h2', {}, 'Destinos'),
      endpoints.length === 0 ? el('p', { class: 'muted' }, 'Nenhum destino cadastrado (cadastro pela API).') : el('ul', { class: 'list' }, endpoints.map((e) => el('li', {}, e.url, el('span', { class: 'muted small' }, ` · ${e.events.length ? e.events.join(', ') : 'todos os eventos'}`)))),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', {}, 'Entregas recentes'),
      el(
        'table',
        { 'data-testid': 'biz-deliveries' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Evento'), el('th', {}, 'Situação'), el('th', { class: 'num' }, 'Tentativas'), el('th', {}, ''))),
        el(
          'tbody',
          {},
          deliveries.map((d) =>
            el(
              'tr',
              {},
              el('td', {}, d.eventType),
              el('td', {}, d.status === 'DELIVERED' ? el('span', { class: 'badge ok' }, 'entregue') : el('span', { class: 'badge warn' }, d.status), d.lastError && el('span', { class: 'muted small' }, ` ${d.lastError}`)),
              el('td', { class: 'num' }, String(d.attempts)),
              el('td', {}, d.status !== 'DELIVERED' && actionButton('reenviar', async () => {
                await api.post(`/v1/webhook-deliveries/${d.id}/retry`);
                toast('Reenvio agendado');
                businessView(['webhooks'], deps);
              }, { class: 'link' })),
            ),
          ),
        ),
      ),
    ),
  );
}

async function dayView(api, deps) {
  // Sem data, o servidor usa o "hoje" dele (fuso de São Paulo) — o relógio do aparelho não manda no relatório.
  const date = el('input', { type: 'date', 'data-testid': 'biz-date' });
  const box = el('div', {});
  const load = async () => {
    const { report } = await api.get(`/v1/reports/daily${date.value ? `?date=${date.value}` : ''}`);
    date.value = report.date;
    mount(
      box,
      report.establishments.length === 0
        ? el('p', { class: 'muted' }, 'Sem movimento neste dia.')
        : el(
            'table',
            { 'data-testid': 'biz-daily' },
            el('thead', {}, el('tr', {}, el('th', {}, 'Estabelecimento'), el('th', { class: 'num' }, 'Abertas'), el('th', { class: 'num' }, 'Quitadas'), el('th', { class: 'num' }, 'No caixa (declarado)'), el('th', { class: 'num' }, 'Teste'))),
            el(
              'tbody',
              {},
              report.establishments.map((r) =>
                el(
                  'tr',
                  {},
                  el('td', {}, r.establishmentName ?? 'sem estabelecimento'),
                  el('td', { class: 'num' }, String(r.billsOpened)),
                  el('td', { class: 'num' }, String(r.billsSettled)),
                  el('td', { class: 'num money' }, brl(r.confirmed.declaredManualCents)),
                  el('td', { class: 'num money' }, brl(r.confirmed.sandboxTestCents)),
                ),
              ),
            ),
          ),
      el('p', { class: 'muted small' }, 'Dia no fuso de São Paulo. "Declarado" é o que o caixa confirmou ter recebido; "Teste" é sandbox.'),
    );
  };
  date.addEventListener('change', () => load().catch((e) => toast(e.message, true)));
  mount(deps.app, nav('dia'), el('section', { class: 'card stack' }, el('h2', {}, 'Conciliação do dia'), date, box));
  await load();
}
