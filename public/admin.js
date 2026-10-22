// Painel do administrador da plataforma (#/admin): regras compartilhadas da Expert Library (com quatro
// olhos), casos do tenant Pessoal e North Star. Login com ADMIN_TOKEN + identificação de quem opera;
// fica só nesta aba (sessionStorage). Toda regra de governança é decidida pela API e pelo banco.

import { createApi } from './api.js';
import { brl } from './format.js';
import { actionButton, el, mount, toast } from './ui.js';

const SESSION_KEY = 'rachapay.admin';
const PERSONAL_TENANT = '00000000-0000-4000-8000-000000000001';
const SHARED_SCOPES = ['GLOBAL', 'COUNTRY', 'SEGMENT', 'ERP', 'PSP'];
const STATUS_LABEL = { DRAFT: 'rascunho', REVIEW: 'em revisão', APPROVED: 'aprovada', ACTIVE: 'ativa', SUPERSEDED: 'substituída', REVOKED: 'revogada', EXPIRED: 'expirada' };
const NEXT = {
  DRAFT: [['REVIEW', 'Enviar para revisão'], ['REVOKED', 'Revogar']],
  REVIEW: [['APPROVED', 'Aprovar'], ['DRAFT', 'Devolver'], ['REVOKED', 'Revogar']],
  APPROVED: [['ACTIVE', 'Ativar'], ['REVOKED', 'Revogar']],
  ACTIVE: [['REVOKED', 'Revogar']],
};

function session() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null');
  } catch {
    return null;
  }
}
function saveSession(v) {
  try {
    if (v) sessionStorage.setItem(SESSION_KEY, JSON.stringify(v));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* sem storage: vale até recarregar */
  }
}

function nav(active) {
  return el(
    'nav',
    { class: 'row card', 'aria-label': 'Administração' },
    [
      ['regras', 'Regras'],
      ['casos', 'Casos (Pessoal)'],
      ['metricas', 'Métricas'],
    ].map(([id, label]) => el('a', { class: id === active ? 'button primary' : 'button', href: `#/admin/${id}`, 'data-testid': `admin-tab-${id}` }, label)),
    el('span', { class: 'muted small' }, `operando como ${session()?.actor ?? ''}`),
    el('button', { type: 'button', class: 'link', on: { click: () => { saveSession(null); location.hash = '#/admin'; } } }, 'sair'),
  );
}

export async function adminView(parts, deps) {
  const s = session();
  if (!s) return loginView(deps);
  const api = createApi({ key: s.token, actor: s.actor });
  try {
    if (parts[0] === 'casos') return await casesView(api, deps);
    if (parts[0] === 'metricas') return await metricsView(api, deps);
    return await rulesView(api, deps);
  } catch (e) {
    if (e.status === 401) {
      saveSession(null);
      toast('Credencial inválida: entre de novo', true);
      return loginView(deps);
    }
    mount(deps.app, nav(parts[0] ?? 'regras'), el('section', { class: 'card' }, el('p', {}, e.message)));
  }
}

function loginView(deps) {
  const token = el('input', { type: 'password', autocomplete: 'off', 'data-testid': 'admin-token' });
  const actor = el('input', { maxlength: 60, placeholder: 'Ex.: ana', 'data-testid': 'admin-actor' });
  mount(
    deps.app,
    el(
      'section',
      { class: 'card stack' },
      el('h1', {}, 'Administração da plataforma'),
      el('p', { class: 'muted small' }, 'Regras compartilhadas e casos do RachaPay Pessoal. Cada pessoa entra com o próprio nome: regra crítica precisa de aprovador diferente de quem propôs.'),
      el('div', {}, el('label', {}, 'Token de administrador'), token),
      el('div', {}, el('label', {}, 'Seu identificador (vai para a auditoria)'), actor),
      actionButton(
        'Entrar',
        async () => {
          const v = { token: token.value.trim(), actor: actor.value.trim().replace(/[^A-Za-z0-9@._:-]/g, '-') };
          if (!v.token || !v.actor) throw new Error('informe token e identificador');
          await createApi({ key: v.token, actor: v.actor }).get('/v1/knowledge?status=ACTIVE');
          saveSession(v);
          location.hash = '#/admin/regras';
        },
        { class: 'primary full', 'data-testid': 'admin-login' },
      ),
    ),
  );
}

async function rulesView(api, deps) {
  const { knowledge } = await api.get('/v1/knowledge');
  const shared = knowledge.filter((k) => k.shared);
  const keys = [...new Set(shared.map((k) => k.key))].sort();

  const keySel = el('select', { 'data-testid': 'rule-key' }, keys.map((k) => el('option', { value: k }, k)));
  const scopeSel = el('select', { 'data-testid': 'rule-scope' }, SHARED_SCOPES.map((s) => el('option', { value: s }, s)));
  const scopeValue = el('input', { 'data-testid': 'rule-scope-value', placeholder: 'ex.: RESTAURANT, BR, sandbox (vazio para GLOBAL)' });
  const content = el('textarea', { 'data-testid': 'rule-content', rows: 4, class: 'full' });
  const rationale = el('input', { 'data-testid': 'rule-rationale', placeholder: 'por que mudar (fica no histórico)' });
  const fill = () => {
    const active = shared.find((k) => k.key === keySel.value && k.status === 'ACTIVE' && k.scopeType === 'GLOBAL') ?? shared.find((k) => k.key === keySel.value);
    content.value = JSON.stringify(active?.content ?? {}, null, 2);
  };
  keySel.addEventListener('change', fill);
  fill();

  const rows = keys.map((key) => {
    const versions = shared.filter((k) => k.key === key);
    return el(
      'li',
      { class: 'stack', 'data-testid': `rule-${key}` },
      el('strong', {}, key),
      el(
        'table',
        {},
        el('tbody', {},
          versions.map((k) =>
            el(
              'tr',
              { 'data-testid': `rule-row-${k.id}` },
              el('td', {}, `${k.scope} · v${k.version}`),
              el('td', {}, el('span', { class: k.status === 'ACTIVE' ? 'badge ok' : 'badge' }, STATUS_LABEL[k.status] ?? k.status), k.critical && el('span', { class: 'muted small' }, ' crítica')),
              el('td', { class: 'small' }, JSON.stringify(k.content)),
              el('td', { class: 'small muted' }, `por ${k.author}${k.approvedBy ? `, aprovada por ${k.approvedBy}` : ''}`),
              el(
                'td',
                {},
                (NEXT[k.status] ?? []).map(([to, label]) =>
                  actionButton(label, async () => {
                    await api.post(`/v1/knowledge/${k.id}/transition`, { to });
                    toast(`Regra: ${STATUS_LABEL[to]}`);
                    adminView(['regras'], deps);
                  }, { class: 'link', 'data-testid': `rule-${to}` }),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  });

  mount(
    deps.app,
    nav('regras'),
    el(
      'section',
      { class: 'card stack' },
      el('h2', {}, 'Propor nova versão'),
      el('p', { class: 'muted small' }, 'Toda mudança nasce como rascunho e só vale depois de revisada, aprovada e ativada. O conteúdo é validado pelo formato da regra.'),
      el('div', { class: 'grid2' }, keySel, scopeSel),
      scopeValue,
      content,
      rationale,
      actionButton(
        'Propor',
        async () => {
          let parsed;
          try {
            parsed = JSON.parse(content.value);
          } catch {
            throw new Error('conteúdo não é JSON válido');
          }
          await api.post('/v1/knowledge', {
            key: keySel.value,
            scopeType: scopeSel.value,
            scopeValue: scopeSel.value === 'GLOBAL' ? '' : scopeValue.value.trim(),
            content: parsed,
            rationale: rationale.value.trim(),
          });
          toast('Proposta criada como rascunho');
          adminView(['regras'], deps);
        },
        { class: 'primary', 'data-testid': 'rule-propose' },
      ),
    ),
    el('section', { class: 'card' }, el('h2', {}, 'Regras compartilhadas'), el('ul', { class: 'list' }, rows)),
  );
}

async function casesView(api, deps) {
  const { cases } = await api.get(`/v1/cbr/cases?tenantId=${PERSONAL_TENANT}&status=OPEN`);
  mount(
    deps.app,
    nav('casos'),
    el(
      'section',
      { class: 'card' },
      el('h2', {}, `Casos abertos do RachaPay Pessoal (${cases.length})`),
      cases.length === 0
        ? el('p', { class: 'muted' }, 'Nenhum caso aberto.')
        : el(
            'ul',
            { class: 'list', 'data-testid': 'admin-cases' },
            cases.map((c) => {
              const decision = el('input', { maxlength: 120, placeholder: 'decisão', 'data-testid': 'admin-case-decision' });
              const outcome = el('input', { maxlength: 500, placeholder: 'resultado', 'data-testid': 'admin-case-outcome' });
              return el(
                'li',
                { class: 'stack' },
                el('strong', {}, c.kind),
                el('span', { class: 'muted small' }, c.features.join(' · ')),
                el('div', { class: 'grid2' }, decision, outcome),
                actionButton('Resolver', async () => {
                  await api.post(`/v1/cbr/cases/${c.id}/resolve?tenantId=${PERSONAL_TENANT}`, { decision: decision.value.trim(), outcome: outcome.value.trim() });
                  toast('Caso resolvido');
                  adminView(['casos'], deps);
                }, { 'data-testid': 'admin-case-resolve' }),
              );
            }),
          ),
    ),
  );
}

async function metricsView(api, deps) {
  const { metrics: m } = await api.get(`/v1/metrics?tenantId=${PERSONAL_TENANT}`);
  const pct = (v) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
  mount(
    deps.app,
    nav('metricas'),
    el(
      'section',
      { class: 'card stack', 'data-testid': 'admin-metrics' },
      el('h2', {}, `RachaPay Pessoal — ${m.month}`),
      el('div', { class: 'big' }, `${m.settledBills} rachas quitados`),
      el(
        'table',
        {},
        el(
          'tbody',
          {},
          el('tr', {}, el('td', {}, 'Rachas confirmados'), el('td', { class: 'num' }, String(m.confirmedBills))),
          el('tr', {}, el('td', {}, 'Taxa de conclusão'), el('td', { class: 'num' }, pct(m.completionRate))),
          el('tr', {}, el('td', {}, 'Participantes por racha'), el('td', { class: 'num' }, m.averageParticipants === null ? '—' : String(m.averageParticipants))),
          el('tr', {}, el('td', {}, 'Mediana até quitar (min)'), el('td', { class: 'num' }, m.medianMinutesToSettle === null ? '—' : String(m.medianMinutesToSettle))),
          el('tr', {}, el('td', {}, 'Volume declarado (Pix/dinheiro ao organizador)'), el('td', { class: 'num money' }, brl(m.volume.declaredManualCents))),
          el('tr', {}, el('td', {}, 'Volume de teste (sandbox)'), el('td', { class: 'num money' }, brl(m.volume.sandboxTestCents))),
        ),
      ),
      el('p', { class: 'muted small' }, `Exceções no mês: ${Object.entries(m.exceptions).map(([k, n]) => `${k} ${n}`).join(', ') || 'nenhuma'}`),
    ),
  );
}
