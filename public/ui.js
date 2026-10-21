// Construção de DOM sem innerHTML (texto do usuário nunca vira HTML) e sem estilo inline (CSP).

import { qrcode } from './vendor/qrcode.mjs';

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'value') node.value = v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(root, ...children) {
  root.replaceChildren();
  append(root, children);
}

let toastTimer;
export function toast(message, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.className = isError ? 'toast error' : 'toast';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 4000);
}

/** QR code em SVG montado por DOM (compatível com CSP estrita). */
export function qrSvg(text, label) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `-2 -2 ${n + 4} ${n + 4}`);
  svg.setAttribute('class', 'qr');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', String(c));
      rect.setAttribute('y', String(r));
      rect.setAttribute('width', '1');
      rect.setAttribute('height', '1');
      rect.setAttribute('class', 'dark');
      svg.append(rect);
    }
  }
  return svg;
}

/** Botão que se desativa enquanto a ação roda (evita clique duplo) e mostra o erro. */
export function actionButton(label, action, props = {}) {
  const btn = el('button', { type: 'button', ...props }, label);
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await action();
    } catch (e) {
      toast(e?.message ?? 'algo deu errado', true);
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  });
  return btn;
}

export const storage = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* armazenamento indisponível (aba privada): segue sem histórico */
    }
  },
};
