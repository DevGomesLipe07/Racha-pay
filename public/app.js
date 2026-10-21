// RachaPay Web/PWA — início (criar racha), organizador (#/o/<id>/<token>), convidado (#/s/<id>/<token>)
// e painel do estabelecimento (#/b…, em business.js). Nenhuma regra financeira aqui: a API calcula,
// concilia e decide.

import { createApi, newKey } from './api.js';
import { businessView } from './business.js';
import { brl, KIND_LABEL, MODE_LABEL, parseMoney, parsePercentBp, pct, PAYMENT_LABEL, STATE_LABEL } from './format.js';
import { actionButton, el, mount, qrSvg, storage, toast } from './ui.js';

const app = document.getElementById('app');
const HISTORY_KEY = 'rachapay.bills';
let config = { sandboxEnabled: false };
let poller;

// ---------------------------------------------------------------------------
// Roteamento por fragmento: o token nunca vai para o servidor em logs nem em Referer.

function route() {
  clearInterval(poller);
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'o' && parts[1] && parts[2]) return organizerView(parts[1], parts[2]);
  if (parts[0] === 's' && parts[1] && parts[2]) return guestView(parts[1], parts[2]);
  if (parts[0] === 'b') return businessView(parts.slice(1), { app, renderOrganizer, stateBadge, remember, poll, billSignature, setPoller });
  return homeView();
}

function setPoller(id) {
  clearInterval(poller);
  poller = id;
}

function remember(entry) {
  const all = storage.get(HISTORY_KEY, []);
  const previous = all.find((b) => b.id === entry.id && b.role === entry.role);
  const list = all.filter((b) => b !== previous);
  // Mescla: reabrir a conta não pode apagar o link de convidado guardado na criação.
  list.unshift({ ...previous, ...Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined)), at: new Date().toISOString() });
  storage.set(HISTORY_KEY, list.slice(0, 30));
}

function stateBadge(state) {
  const cls = state === 'SETTLED' ? 'badge ok' : state === 'REOPENED' || state === 'SETTLEMENT_PENDING' ? 'badge warn' : 'badge';
  return el('span', { class: cls, 'data-testid': 'state' }, STATE_LABEL[state] ?? state);
}

function seal() {
  return el('div', { class: 'seal', 'data-testid': 'seal' }, 'RACHA QUITADO ✓');
}

/** Atualiza a tela só quando algo mudou (em relação ao que está desenhado) e ninguém está digitando. */
function poll(fetcher, signatureOf, render, initial) {
  let last = signatureOf(initial);
  clearInterval(poller);
  poller = setInterval(async () => {
    if (document.hidden) return;
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'SELECT')) return;
    try {
      const data = await fetcher();
      const sig = signatureOf(data);
      if (sig !== last) render(data);
      last = sig;
    } catch {
      /* silêncio: a próxima rodada tenta de novo */
    }
  }, 4000);
}

const billSignature = (bill) =>
  JSON.stringify([bill.state, bill.rowVersion, bill.split?.version, bill.payments.map((p) => [p.id, p.status, p.netPaidCents])]);

// ---------------------------------------------------------------------------
// Início

function homeView() {
  const api = createApi();
  const title = el('input', { id: 'title', 'data-testid': 'title', maxlength: 80, placeholder: 'Ex.: Pizza de sexta', required: true });
  const kind = el(
    'select',
    { id: 'kind', 'data-testid': 'kind' },
    Object.entries(KIND_LABEL).map(([v, l]) => el('option', { value: v }, l)),
  );
  kind.value = 'RESTAURANT';
  const organizer = el('input', { id: 'organizer', 'data-testid': 'organizer-name', maxlength: 60, placeholder: 'Seu nome', autocomplete: 'given-name' });
  const others = el('input', { id: 'others', 'data-testid': 'participants', placeholder: 'Bruno, Caio, Duda' });

  const create = actionButton(
    'Criar racha',
    async () => {
      const names = others.value.split(',').map((s) => s.trim()).filter(Boolean);
      if (!title.value.trim() || !organizer.value.trim()) throw new Error('preencha o nome do racha e o seu nome');
      const r = await api.post('/v1/bills', { kind: kind.value, title: title.value.trim(), organizerName: organizer.value.trim(), participants: names });
      remember({ id: r.bill.id, title: r.bill.title, role: 'o', token: r.organizerToken, share: r.shareToken });
      location.hash = `#/o/${r.bill.id}/${r.organizerToken}`;
    },
    { class: 'primary full', 'data-testid': 'create' },
  );

  const history = storage.get(HISTORY_KEY, []).filter((b) => b.role === 'o' || b.role === 's');
  mount(
    app,
    el(
      'section',
      { class: 'card stack' },
      el('h1', {}, 'Novo racha'),
      el('p', { class: 'muted small' }, 'Sem cadastro e sem app. Você monta a conta, manda o link e cada um vê e paga só a própria parte.'),
      el('div', {}, el('label', { for: 'title' }, 'O que vocês estão dividindo?'), title),
      el('div', {}, el('label', { for: 'kind' }, 'Tipo'), kind),
      el('div', {}, el('label', { for: 'organizer' }, 'Seu nome (quem pagou e vai receber)'), organizer),
      el('div', {}, el('label', { for: 'others' }, 'Quem mais? (separe por vírgula)'), others),
      create,
    ),
    history.length > 0 &&
      el(
        'section',
        { class: 'card' },
        el('h2', {}, 'Neste aparelho'),
        el(
          'ul',
          { class: 'list' },
          history.map((b) =>
            el('li', { class: 'spread' }, el('span', {}, b.title), el('a', { class: 'button', href: `#/${b.role}/${b.id}/${b.token}` }, b.role === 'o' ? 'Abrir (organizador)' : 'Abrir')),
          ),
        ),
        el('p', { class: 'muted small' }, 'O link do organizador é a única chave da conta: sem ele, não dá para administrar o racha.'),
      ),
  );
}

// ---------------------------------------------------------------------------
// Organizador

async function organizerView(id, token) {
  const api = createApi({ organizer: token });
  const load = () => api.get(`/v1/bills/${id}`).then((r) => r.bill);
  let bill;
  try {
    bill = await load();
  } catch (e) {
    return mount(app, el('section', { class: 'card' }, el('h1', {}, 'Não deu para abrir'), el('p', { class: 'muted' }, e.message)));
  }
  remember({ id, title: bill.title, role: 'o', token });
  const rerender = (b) => renderOrganizer(api, b, load, token);
  rerender(bill);
  if (bill.state !== 'DRAFT') poll(load, billSignature, rerender, bill);
}

/** Tela de gestão da conta: organizador (token rpo_) ou operador do estabelecimento (opts.business). */
function renderOrganizer(api, bill, load, token, opts = {}) {
  const refresh = async (b) => renderOrganizer(api, b ?? (await load()), load, token, opts);
  const header = el(
    'section',
    { class: 'card' },
    el('div', { class: 'spread' }, el('h1', {}, bill.title), stateBadge(bill.state)),
    el('p', { class: 'muted small' }, `${KIND_LABEL[bill.kind] ?? bill.kind} · ${MODE_LABEL[bill.splitMode]}`),
    bill.split && el('div', { class: 'big money', 'data-testid': 'total' }, brl(bill.split.totalCents)),
  );
  if (bill.state === 'CANCELLED') return mount(app, opts.back, header, el('p', { class: 'card muted' }, 'Este racha foi cancelado.'));
  if (bill.split === null) return mount(app, opts.back, header, ...draftSections(api, bill, refresh));
  return mount(app, opts.back, header, bill.state === 'SETTLED' && seal(), ...confirmedSections(api, bill, refresh, token, opts));
}

function participantsSection(api, bill, refresh, editable) {
  const name = el('input', { 'data-testid': 'new-participant', maxlength: 60, placeholder: 'Nome' });
  return el(
    'section',
    { class: 'card' },
    el('h2', {}, `Quem participa (${bill.participants.length})`),
    el(
      'ul',
      { class: 'list' },
      bill.participants.map((p) =>
        el(
          'li',
          { class: 'spread' },
          el('span', {}, p.name, p.isOrganizer && el('span', { class: 'muted small' }, ' · organizador')),
          editable && !p.isOrganizer && actionButton('remover', async () => refresh((await api.del(`/v1/bills/${bill.id}/participants/${p.id}`)).bill), { class: 'link danger' }),
        ),
      ),
    ),
    el(
      'div',
      { class: 'row' },
      name,
      actionButton('Adicionar', async () => {
        if (!name.value.trim()) return;
        refresh((await api.post(`/v1/bills/${bill.id}/participants`, { name: name.value.trim() })).bill);
      }, { 'data-testid': 'add-participant' }),
    ),
  );
}

function itemForm(api, bill, refresh, title) {
  const desc = el('input', { 'data-testid': 'item-desc', maxlength: 120, placeholder: 'Ex.: Pizza grande' });
  const price = el('input', { 'data-testid': 'item-price', inputmode: 'decimal', placeholder: '0,00' });
  const qty = el('input', { 'data-testid': 'item-qty', inputmode: 'numeric', value: '1' });
  const chosen = new Set();
  const chips = bill.participants.map((p) => {
    const chip = el('button', { type: 'button', class: 'chip', 'data-testid': `assign-${p.name}`, 'aria-pressed': 'false' }, p.name);
    chip.addEventListener('click', () => {
      if (chosen.has(p.id)) chosen.delete(p.id);
      else chosen.add(p.id);
      chip.classList.toggle('on', chosen.has(p.id));
      chip.setAttribute('aria-pressed', String(chosen.has(p.id)));
    });
    return chip;
  });
  return el(
    'section',
    { class: 'card stack' },
    el('h2', {}, title),
    el('div', { class: 'grid3' }, el('div', {}, el('label', {}, 'Item'), desc), el('div', {}, el('label', {}, 'Preço (R$)'), price), el('div', {}, el('label', {}, 'Qtd.'), qty)),
    el('div', {}, el('label', {}, 'Quem consumiu? (nenhum = todos)'), el('div', { class: 'row' }, chips)),
    actionButton(
      'Adicionar item',
      async () => {
        const cents = parseMoney(price.value);
        const quantity = Number(qty.value || '1');
        if (!desc.value.trim() || cents === null || !Number.isInteger(quantity) || quantity < 1) throw new Error('confira nome, preço e quantidade do item');
        const r = await api.post(`/v1/bills/${bill.id}/items`, {
          description: desc.value.trim(),
          unitPriceCents: cents,
          quantity,
          assignees: [...chosen].map((participantId) => ({ participantId })),
        });
        refresh(r.bill);
      },
      { class: 'primary', 'data-testid': 'add-item' },
    ),
  );
}

function itemsList(api, bill, refresh) {
  const names = new Map(bill.participants.map((p) => [p.id, p.name]));
  if (bill.items.length === 0) return el('p', { class: 'muted' }, 'Nenhum item ainda.');
  return el(
    'ul',
    { class: 'list', 'data-testid': 'items' },
    bill.items.map((it) =>
      el(
        'li',
        { class: 'spread' },
        el(
          'span',
          {},
          `${it.quantity > 1 ? `${it.quantity}× ` : ''}${it.description}`,
          el('br'),
          el('span', { class: 'muted small' }, it.assignees.length ? it.assignees.map((a) => names.get(a.participantId)).join(', ') : 'todos', it.confirmedVersion === null && bill.split ? ' · novo' : ''),
        ),
        el(
          'span',
          { class: 'row' },
          el('span', { class: 'money' }, brl(it.totalCents)),
          it.confirmedVersion === null && actionButton('×', async () => refresh((await api.del(`/v1/bills/${bill.id}/items/${it.id}`)).bill), { class: 'link danger', 'aria-label': `remover ${it.description}` }),
        ),
      ),
    ),
  );
}

function draftSections(api, bill, refresh) {
  const mode = el('select', { 'data-testid': 'mode' }, Object.entries(MODE_LABEL).map(([v, l]) => el('option', { value: v }, l)));
  mode.value = bill.splitMode;
  mode.addEventListener('change', async () => {
    try {
      refresh((await api.patch(`/v1/bills/${bill.id}`, { splitMode: mode.value })).bill);
    } catch (e) {
      toast(e.message, true);
    }
  });
  const discount = el('input', { 'data-testid': 'discount', inputmode: 'decimal', value: (bill.discountCents / 100).toFixed(2).replace('.', ',') });
  const service = el('input', { 'data-testid': 'service', inputmode: 'decimal', value: String(bill.serviceBp / 100).replace('.', ',') });
  const tip = el('input', { 'data-testid': 'tip', inputmode: 'decimal', value: (bill.tipCents / 100).toFixed(2).replace('.', ',') });

  const perPerson =
    bill.splitMode === 'PERCENT' || bill.splitMode === 'MANUAL'
      ? el(
          'div',
          { class: 'stack' },
          bill.participants.map((p) => {
            const input = el('input', {
              inputmode: 'decimal',
              'data-testid': `share-${p.name}`,
              value: bill.splitMode === 'PERCENT' ? (p.percentBp === null ? '' : String(p.percentBp / 100).replace('.', ',')) : p.manualCents === null ? '' : (p.manualCents / 100).toFixed(2).replace('.', ','),
            });
            input.addEventListener('change', async () => {
              try {
                const value = bill.splitMode === 'PERCENT' ? parsePercentBp(input.value) : parseMoney(input.value);
                if (value === null) throw new Error('valor inválido');
                await api.patch(`/v1/bills/${bill.id}/participants/${p.id}`, bill.splitMode === 'PERCENT' ? { percentBp: value } : { manualCents: value });
              } catch (e) {
                toast(e.message, true);
              }
            });
            return el('div', { class: 'spread' }, el('span', {}, p.name), el('span', {}, input));
          }),
        )
      : null;

  const previewBox = el('div', { 'data-testid': 'preview' });
  const doPreview = async () => {
    const r = await api.post(`/v1/bills/${bill.id}/splits/preview`);
    const pv = r.preview;
    const names = new Map(bill.participants.map((p) => [p.id, p.name]));
    mount(
      previewBox,
      el(
        'table',
        {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Quem'), el('th', { class: 'num' }, 'Parte'))),
        el('tbody', {}, pv.shares.map((s) => el('tr', {}, el('td', {}, names.get(s.participantId)), el('td', { class: 'num money' }, brl(s.totalCents))))),
      ),
      el(
        'p',
        { class: 'muted small' },
        `Subtotal ${brl(pv.totals.subtotalCents)} − desconto ${brl(pv.totals.discountCents)} + serviço ${brl(pv.totals.serviceCents)} + gorjeta ${brl(pv.totals.tipCents)} = `,
        el('strong', {}, brl(pv.totals.totalCents)),
      ),
      actionButton(
        `Confirmar divisão (${brl(pv.totals.totalCents)})`,
        async () => {
          await api.post(`/v1/bills/${bill.id}/splits`, { expectedTotalCents: pv.totals.totalCents });
          toast('Divisão confirmada. Mande o link para a turma.');
          route();
        },
        { class: 'primary full', 'data-testid': 'confirm-split' },
      ),
    );
  };

  return [
    participantsSection(api, bill, refresh, true),
    el('section', { class: 'card stack' }, el('h2', {}, 'Itens'), itemsList(api, bill, refresh)),
    itemForm(api, bill, refresh, 'Adicionar item'),
    el(
      'section',
      { class: 'card stack' },
      el('h2', {}, 'Como dividir'),
      mode,
      perPerson,
      el('div', { class: 'grid2' }, el('div', {}, el('label', {}, 'Desconto (R$)'), discount), el('div', {}, el('label', {}, 'Gorjeta (R$)'), tip)),
      el('div', {}, el('label', {}, 'Taxa de serviço (%)'), service),
      actionButton(
        'Salvar ajustes',
        async () => {
          const discountCents = parseMoney(discount.value || '0');
          const tipCents = parseMoney(tip.value || '0');
          const serviceBp = parsePercentBp(service.value || '0');
          if (discountCents === null || tipCents === null || serviceBp === null) throw new Error('confira desconto, gorjeta e serviço');
          refresh((await api.patch(`/v1/bills/${bill.id}`, { discountCents, tipCents, serviceBp })).bill);
          toast('Ajustes salvos');
        },
        { 'data-testid': 'save-adjustments' },
      ),
    ),
    el('section', { class: 'card stack' }, el('h2', {}, 'Conferir e confirmar'), actionButton('Ver a divisão', doPreview, { class: 'full', 'data-testid': 'preview-split' }), previewBox),
  ];
}

function confirmedSections(api, bill, refresh, token, opts = {}) {
  const role = opts.business ? 'b' : 'o';
  const share = storage.get(HISTORY_KEY, []).find((b) => b.id === bill.id && b.share)?.share;
  const shareUrl = share ? `${location.origin}/#/s/${bill.id}/${share}` : null;
  const organizerName = bill.participants.find((p) => p.isOrganizer)?.name ?? 'o organizador';
  const message = shareUrl ? `Racha "${bill.title}": veja e pague a sua parte (só a sua) ${shareUrl}` : '';

  const shareCard = el(
    'section',
    { class: 'card stack' },
    el('h2', {}, 'Mande para a turma'),
    shareUrl
      ? [
          qrSvg(shareUrl, 'QR code do link do racha'),
          el('p', { class: 'share-link', 'data-testid': 'share-link' }, shareUrl),
          el(
            'div',
            { class: 'grid2' },
            el('a', { class: 'button primary', href: `https://wa.me/?text=${encodeURIComponent(message)}`, target: '_blank', rel: 'noopener noreferrer' }, 'WhatsApp'),
            actionButton('Copiar link', async () => {
              await navigator.clipboard.writeText(shareUrl);
              toast('Link copiado');
            }),
          ),
        ]
      : [
          el('p', { class: 'muted small' }, 'O link dos convidados ficou no aparelho em que o racha foi criado. Gere um novo (o antigo continua valendo).'),
          actionButton('Gerar link para convidados', async () => {
            const r = await api.post(`/v1/bills/${bill.id}/share-links`);
            remember({ id: bill.id, title: bill.title, role, token, share: r.shareToken });
            refresh();
          }, { class: 'primary' }),
        ],
  );

  const names = new Map(bill.participants.map((p) => [p.id, p.name]));
  const balances = el(
    'section',
    { class: 'card' },
    el('h2', {}, 'Quem já pagou'),
    el(
      'table',
      { 'data-testid': 'balances' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Quem'), el('th', { class: 'num' }, 'Parte'), el('th', { class: 'num' }, 'Falta'))),
      el(
        'tbody',
        {},
        bill.participants
          .filter((p) => p.balance)
          .map((p) =>
            el(
              'tr',
              {},
              el('td', {}, p.name, p.balance.settled && el('span', { class: 'badge ok' }, ' pago')),
              el('td', { class: 'num money' }, brl(p.balance.dueCents)),
              el('td', { class: 'num money' }, brl(p.balance.unpaidCents)),
            ),
          ),
      ),
    ),
  );

  const pending = bill.payments.filter((p) => p.method === 'MANUAL' && p.status === 'PENDING');
  const pendingCard =
    pending.length > 0 &&
    el(
      'section',
      { class: 'card' },
      el('h2', {}, `Pix/dinheiro para confirmar (${pending.length})`),
      el('p', { class: 'muted small' }, opts.business ? 'Só toque "Recebi" depois de ver o dinheiro no caixa.' : `Só toque "Recebi" depois de ver o dinheiro na conta de ${organizerName}.`),
      el(
        'ul',
        { class: 'list' },
        pending.map((p) =>
          el(
            'li',
            { class: 'spread' },
            el('span', {}, `${names.get(p.participantId)} · `, el('span', { class: 'money' }, brl(p.amountCents))),
            el(
              'span',
              { class: 'row' },
              actionButton('Recebi', async () => refresh((await api.post(`/v1/bills/${bill.id}/payments/${p.id}/confirm`)).bill), { class: 'primary', 'data-testid': 'confirm-payment' }),
              actionButton('Não recebi', async () => refresh((await api.post(`/v1/bills/${bill.id}/payments/${p.id}/reject`)).bill), { class: 'danger', 'data-testid': 'reject-payment' }),
            ),
          ),
        ),
      ),
    );

  const refunds = bill.participants.filter((p) => p.balance && p.balance.refundDueCents > 0);
  const refundCard =
    refunds.length > 0 &&
    el(
      'section',
      { class: 'card' },
      el('h2', {}, 'Pagaram a mais'),
      el(
        'ul',
        { class: 'list' },
        refunds.map((p) =>
          el(
            'li',
            { class: 'spread' },
            el('span', {}, `${p.name} · devolver `, el('span', { class: 'money' }, brl(p.balance.refundDueCents))),
            actionButton('Devolvi', async () => {
              const r = await api.post('/v1/refunds', { kind: 'MANUAL_RECORD', billId: bill.id, participantId: p.id, amountCents: p.balance.refundDueCents });
              refresh(r.bill);
            }),
          ),
        ),
      ),
    );

  const pendingItems = bill.items.filter((i) => i.confirmedVersion === null);
  const complement =
    pendingItems.length > 0 &&
    el(
      'section',
      { class: 'card stack' },
      el('h2', {}, 'Mais uma rodada'),
      el('p', { class: 'muted small' }, 'Os itens novos são divididos à parte e somados a quem consumiu — nada do que já foi pago muda.'),
      actionButton(
        'Confirmar itens novos',
        async () => {
          const pv = (await api.post(`/v1/bills/${bill.id}/splits/preview`)).preview;
          refresh((await api.post(`/v1/bills/${bill.id}/splits`, { expectedTotalCents: pv.totals.totalCents })).bill);
          toast(`Nova rodada confirmada: total ${brl(pv.totals.totalCents)}`);
        },
        { class: 'primary', 'data-testid': 'confirm-complement' },
      ),
    );

  const evidence = el('p', { class: 'muted small', 'data-testid': 'evidence' }, 'Verificando o registro…');
  api
    .get(`/v1/bills/${bill.id}/ledger`)
    .then((l) => {
      evidence.textContent = l.verification.valid && l.reconstruction.consistent
        ? `Registro íntegro: ${l.verification.entries} lançamentos encadeados, conferidos agora.`
        : 'Atenção: o registro não confere. Fale com o suporte.';
    })
    .catch(() => {
      evidence.textContent = '';
    });

  const hasPayments = bill.payments.some((p) => !['FAILED', 'EXPIRED', 'REJECTED'].includes(p.status));
  const manage = el(
    'section',
    { class: 'card stack' },
    el('h2', {}, 'Mais opções'),
    !hasPayments &&
      actionButton('Editar a divisão', async () => {
        refresh((await api.post(`/v1/bills/${bill.id}/splits/unlock`)).bill);
      }),
    !hasPayments &&
      actionButton(
        'Cancelar racha',
        async () => {
          if (!confirm('Cancelar este racha? Não dá para desfazer.')) return;
          refresh((await api.post(`/v1/bills/${bill.id}/cancel`, {})).bill);
        },
        { class: 'danger' },
      ),
    evidence,
  );

  return [
    pendingCard,
    balances,
    shareCard,
    refundCard,
    el('section', { class: 'card stack' }, el('h2', {}, 'Itens'), itemsList(api, bill, refresh)),
    bill.state !== 'CANCELLED' && itemForm(api, bill, refresh, 'Pediram mais alguma coisa?'),
    complement,
    manage,
    !opts.business && el('p', { class: 'muted small' }, 'Guarde este link: ele é a chave do racha. ', el('a', { href: `#/o/${bill.id}/${token}` }, 'link do organizador')),
  ];
}

// ---------------------------------------------------------------------------
// Convidado

async function guestView(id, token) {
  const api = createApi({ share: token });
  const load = () => api.get(`/v1/bills/${id}`).then((r) => r.bill);
  let bill;
  try {
    bill = await load();
  } catch (e) {
    return mount(app, el('section', { class: 'card' }, el('h1', {}, 'Link inválido'), el('p', { class: 'muted' }, e.message)));
  }
  remember({ id, title: bill.title, role: 's', token });
  const rerender = (b) => renderGuest(api, b, load);
  rerender(bill);
  poll(load, billSignature, rerender, bill);
}

function renderGuest(api, bill, load) {
  const meKey = `rachapay.me.${bill.id}`;
  const meId = storage.get(meKey, null);
  const me = bill.participants.find((p) => p.id === meId);
  const organizer = bill.participants.find((p) => p.isOrganizer);
  const refresh = async () => renderGuest(api, await load(), load);
  const header = el(
    'section',
    { class: 'card' },
    el('div', { class: 'spread' }, el('h1', {}, bill.title), stateBadge(bill.state)),
    bill.split && el('p', { class: 'muted small' }, `Total da conta: ${brl(bill.split.totalCents)}`),
  );

  if (bill.state === 'CANCELLED') return mount(app, header, el('p', { class: 'card muted' }, 'Este racha foi cancelado.'));
  if (!bill.split) return mount(app, header, el('p', { class: 'card' }, `${organizer?.name ?? 'O organizador'} ainda está montando a conta. Esta página atualiza sozinha.`));

  if (!me) {
    return mount(
      app,
      header,
      el(
        'section',
        { class: 'card stack' },
        el('h2', {}, 'Quem é você?'),
        el(
          'div',
          { class: 'row' },
          bill.participants
            .filter((p) => !p.isOrganizer || bill.collectionModel !== 'ORGANIZER_COLLECTS')
            .map((p) =>
              el('button', { type: 'button', class: 'chip', 'data-testid': `who-${p.name}`, on: { click: () => { storage.set(meKey, p.id); renderGuest(api, bill, load); } } }, p.name),
            ),
        ),
      ),
    );
  }

  const b = me.balance;
  const s = me.share;
  const myPayments = bill.payments.filter((p) => p.participantId === me.id);
  const waiting = myPayments.filter((p) => ['CREATED', 'PENDING', 'AUTHORIZED'].includes(p.status));
  const status = b.settled
    ? el('p', { class: 'badge ok', 'data-testid': 'my-status' }, 'Sua parte está paga ✓')
    : waiting.length > 0
      ? el('p', { class: 'badge warn', 'data-testid': 'my-status' }, `Pagamento de ${brl(waiting[0].amountCents)}: ${PAYMENT_LABEL[waiting[0].status]}`)
      : el('p', { class: 'badge', 'data-testid': 'my-status' }, `Falta pagar ${brl(b.unpaidCents)}`);

  const payKey = { manual: newKey(), sandbox: newKey() };
  const payButtons =
    b.availableToPayCents > 0 &&
    el(
      'div',
      { class: 'stack' },
      bill.collectionModel === 'ORGANIZER_COLLECTS' &&
        el('p', { class: 'small' }, `Faça o Pix (ou entregue o dinheiro) para ${organizer?.name ?? 'o organizador'} e avise aqui. A confirmação é dele.`),
      actionButton(
        bill.collectionModel === 'ORGANIZER_COLLECTS' ? `Já paguei ${brl(b.availableToPayCents)} para ${organizer?.name ?? 'o organizador'}` : `Paguei ${brl(b.availableToPayCents)} no caixa`,
        async () => {
          await api.post('/v1/payments', { billId: bill.id, participantId: me.id, method: 'MANUAL' }, { 'idempotency-key': payKey.manual });
          toast('Avisado! Agora é só esperar a confirmação.');
          refresh();
        },
        { class: 'primary full', 'data-testid': 'pay-manual' },
      ),
      config.sandboxEnabled &&
        actionButton(
          `Pagar ${brl(b.availableToPayCents)} agora (teste)`,
          async () => {
            const r = await api.post('/v1/payments', { billId: bill.id, participantId: me.id, method: 'SANDBOX' }, { 'idempotency-key': payKey.sandbox });
            await api.post(`/v1/bills/${bill.id}/payments/${r.payment.id}/simulate`, { kind: 'CONFIRMED' });
            toast('Pagamento de teste confirmado.');
            refresh();
          },
          { class: 'full', 'data-testid': 'pay-sandbox' },
        ),
    );

  mount(
    app,
    header,
    bill.state === 'SETTLED' && seal(),
    el(
      'section',
      { class: 'card stack' },
      el('div', { class: 'spread' }, el('h2', {}, `Sua parte, ${me.name}`), el('button', { type: 'button', class: 'link', on: { click: () => { storage.set(meKey, null); renderGuest(api, bill, load); } } }, 'não sou eu')),
      el('div', { class: 'big money', 'data-testid': 'my-share' }, brl(b.dueCents)),
      s &&
        el(
          'table',
          {},
          el(
            'tbody',
            {},
            el('tr', {}, el('td', {}, 'Consumo'), el('td', { class: 'num money' }, brl(s.itemsCents))),
            s.discountCents > 0 && el('tr', {}, el('td', {}, 'Desconto'), el('td', { class: 'num money' }, `− ${brl(s.discountCents)}`)),
            s.serviceCents > 0 && el('tr', {}, el('td', {}, `Serviço (${pct(bill.serviceBp)})`), el('td', { class: 'num money' }, brl(s.serviceCents))),
            s.tipCents > 0 && el('tr', {}, el('td', {}, 'Gorjeta'), el('td', { class: 'num money' }, brl(s.tipCents))),
            el('tr', {}, el('td', {}, 'Já pago'), el('td', { class: 'num money' }, brl(b.paidCents))),
          ),
        ),
      status,
      payButtons,
      b.refundDueCents > 0 && el('p', { class: 'badge warn' }, `Você pagou ${brl(b.refundDueCents)} a mais — ${organizer?.name ?? 'o organizador'} vai devolver.`),
    ),
    el('p', { class: 'muted small' }, 'Você paga só a sua parte. O que outra pessoa pagar a mais nunca cobre a sua, e vice-versa.'),
  );
}

// ---------------------------------------------------------------------------

async function boot() {
  try {
    const r = await fetch('/v1/config', { cache: 'no-store' });
    if (r.ok) config = await r.json();
  } catch {
    /* sem config: segue com padrão */
  }
  document.getElementById('sandbox-banner').hidden = !config.sandboxEnabled;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  window.addEventListener('hashchange', route);
  route();
}

boot();
