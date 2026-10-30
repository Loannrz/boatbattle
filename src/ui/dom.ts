/** Petits utilitaires DOM (pas de framework). */

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown>;

function apply(el: Element, attrs: Attrs | null | undefined) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      el.setAttribute('class', String(v));
    } else if (k === 'html') {
      el.innerHTML = String(v);
    } else if (k === 'style' && typeof v === 'object') {
      Object.assign((el as HTMLElement).style, v);
    } else if (v === true) {
      el.setAttribute(k, '');
    } else {
      el.setAttribute(k, String(v));
    }
  }
}

function append(el: Element, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'number' ? String(c) : c);
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

/** Icône SVG à partir d'un ou plusieurs tracés (style trait, 24x24). */
export function icon(paths: string, label?: string): SVGSVGElement {
  const el = s('svg', {
    viewBox: '0 0 24 24',
    class: 'icon',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': label ? undefined : 'true',
    role: label ? 'img' : undefined,
    'aria-label': label,
  });
  el.innerHTML = paths;
  return el;
}

// ---------- notifications ----------

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: 'info' | 'ok' | 'warn' | 'error' = 'info', ms = 3200): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', 'aria-live': 'polite', role: 'status' });
    document.body.append(toastHost);
  }
  // Au plus 2 notifications à l'écran : la plus ancienne laisse sa place.
  while (toastHost.children.length >= 2) toastHost.firstElementChild?.remove();
  const el = h('div', { class: `toast toast-${kind}` }, message);
  toastHost.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, ms);
}

// ---------- fenêtres modales ----------

export interface ModalButton {
  label: string;
  kind?: 'primary' | 'secondary' | 'danger';
  value: string;
}

export function modal(title: string, body: Child | Child[], buttons: ModalButton[]): Promise<string | null> {
  return new Promise((resolve) => {
    const close = (v: string | null) => {
      overlay.classList.remove('show');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => overlay.remove(), 200);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close(null);
    const titleId = `m${Math.random().toString(36).slice(2)}`;
    const dialog = h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('h2', { id: titleId }, title),
      h('div', { class: 'modal-body' }, ...(Array.isArray(body) ? body : [body])),
      h(
        'div',
        { class: 'modal-actions' },
        ...buttons.map((b) => h('button', { class: `btn btn-${b.kind ?? 'secondary'}`, onclick: () => close(b.value) }, b.label)),
      ),
    );
    const overlay = h('div', { class: 'overlay', onclick: (e: Event) => e.target === overlay && close(null) }, dialog);
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => {
      overlay.classList.add('show');
      (dialog.querySelector('.btn-primary, .btn-danger, .btn') as HTMLElement | null)?.focus();
    });
  });
}

export async function confirmBox(title: string, text: string, ok = 'Confirmer', danger = false): Promise<boolean> {
  const v = await modal(title, h('p', null, text), [
    { label: 'Annuler', value: 'no' },
    { label: ok, value: 'yes', kind: danger ? 'danger' : 'primary' },
  ]);
  return v === 'yes';
}

/** Petite vibration (si le téléphone le permet ; ignoré sur iOS). */
export function buzz(ms = 15): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* non supporté */
  }
}
