/**
 * Onglet « Sorts » : réserve du joueur, lancement (avec choix des paramètres) et liste de tous les sorts.
 */

import { COLORS } from '../../config/pieces';
import { COL_LABELS, GRID_SIZE, SPELLS, cellLabel, spellDef, type Edge, type Side, type SpellDef } from '../../engine';
import type { PlayerSession } from '../../game/session';
import type { SpellAction } from '../../game/protocol';
import type { App } from '../app';
import { confirmBox, h, icon, toast } from '../dom';
import { ICONS } from '../icons';

// ---------- fenêtre de choix (se ferme dès qu'on touche une option) ----------

function pickModal<T>(title: string, build: (done: (v: T) => void) => (Node | null)[]): Promise<T | null> {
  return new Promise((resolve) => {
    const close = (v: T | null) => {
      overlay.classList.remove('show');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => overlay.remove(), 200);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close(null);
    const dialog = h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', null, title),
      h('div', { class: 'modal-body' }, ...build((v) => close(v))),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn btn-secondary', onclick: () => close(null) }, 'Annuler')),
    );
    const overlay = h('div', { class: 'overlay', onclick: (e: Event) => e.target === overlay && close(null) }, dialog);
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => overlay.classList.add('show'));
  });
}

function options<T>(title: string, items: { label: string; value: T; swatch?: string }[], cols = 2, intro?: string): Promise<T | null> {
  return pickModal<T>(title, (done) => [
    intro ? h('p', { class: 'muted small' }, intro) : null,
    h(
      'div',
      { class: 'pick-grid', style: { gridTemplateColumns: `repeat(${cols}, 1fr)` } },
      ...items.map((it) =>
        h('button', { class: 'btn btn-secondary pick-btn', onclick: () => done(it.value) }, it.swatch ? h('span', { class: 'pick-dot', style: { background: it.swatch } }) : null, it.label),
      ),
    ),
  ]);
}

function pickCell(title: string): Promise<{ r: number; c: number } | null> {
  return pickModal<{ r: number; c: number }>(title, (done) => {
    const grid = h('div', { class: 'cell-picker', style: { gridTemplateColumns: `1.4em repeat(${GRID_SIZE}, 1fr)` } }, h('span', null));
    for (let c = 0; c < GRID_SIZE; c++) grid.append(h('span', { class: 'cp-head' }, COL_LABELS[c]));
    for (let r = 0; r < GRID_SIZE; r++) {
      grid.append(h('span', { class: 'cp-head' }, String(r + 1)));
      for (let c = 0; c < GRID_SIZE; c++) grid.append(h('button', { class: 'cp-cell', 'aria-label': cellLabel({ r, c }), onclick: () => done({ r, c }) }));
    }
    return [h('p', { class: 'muted small' }, 'Touche une case de la grille adverse.'), grid];
  });
}

const SIDE_NAMES: { side: Side; label: string }[] = [
  { side: 'top', label: 'Haut' },
  { side: 'right', label: 'Droite' },
  { side: 'bottom', label: 'Bas' },
  { side: 'left', label: 'Gauche' },
];
const indexName = (side: Side, i: number) => (side === 'top' || side === 'bottom' ? COL_LABELS[i] : String(i + 1));

async function pickEdge(title: string): Promise<Edge | null> {
  const side = await options<Side>(`${title} : quel côté ?`, SIDE_NAMES.map((s) => ({ label: s.label, value: s.side })));
  if (!side) return null;
  const index = await options<number>(`${title} : quelle position ?`, Array.from({ length: GRID_SIZE }, (_, i) => ({ label: indexName(side, i), value: i })), 5);
  return index === null ? null : { side, index };
}

/** Demande les paramètres d'un sort. null = annulé. */
async function askParams(def: SpellDef, session: PlayerSession): Promise<Partial<SpellAction> | null> {
  switch (def.param) {
    case 'none':
      return {};
    case 'cell': {
      const cell = await pickCell(def.name);
      return cell;
    }
    case 'line': {
      const items: { label: string; value: Partial<SpellAction> }[] = [
        ...Array.from({ length: GRID_SIZE }, (_, i) => ({ label: `Ligne ${i + 1}`, value: { axis: 'row' as const, index: i } })),
        ...Array.from({ length: GRID_SIZE }, (_, i) => ({ label: `Colonne ${COL_LABELS[i]}`, value: { axis: 'col' as const, index: i } })),
      ];
      return options(def.name, items, 4, 'Quelle ligne ou colonne de la grille adverse ?');
    }
    case 'diag':
      return options<Partial<SpellAction>>(def.name, [
        { label: '↘ de A1 à J10', value: { opt: 'main' } },
        { label: '↗ de A10 à J1', value: { opt: 'anti' } },
      ]);
    case 'half':
      return options<Partial<SpellAction>>(def.name, [
        { label: 'Moitié haute', value: { opt: 'top' } },
        { label: 'Moitié basse', value: { opt: 'bottom' } },
        { label: 'Moitié gauche', value: { opt: 'left' } },
        { label: 'Moitié droite', value: { opt: 'right' } },
      ]);
    case 'color': {
      const colors = [...new Set(session.oppPieces.map((p) => p.color))];
      return options<Partial<SpellAction>>(
        def.name,
        colors.map((c) => ({ label: COLORS[c]?.name ?? c, value: { color: c }, swatch: COLORS[c]?.hex })),
        2,
        'Quelle couleur chercher chez l’adversaire ?',
      );
    }
    case 'edge2': {
      const e1 = await pickEdge('Premier tir');
      if (!e1) return null;
      for (;;) {
        const e2 = await pickEdge('Second tir');
        if (!e2) return null;
        if (e2.side === e1.side && e2.index === e1.index) {
          toast('Choisis un autre bord.', 'warn', 1800);
          continue;
        }
        return { edges: [e1, e2] };
      }
    }
    case 'salve': {
      const side = await options<Side>('Salve : quel côté ?', SIDE_NAMES.map((s) => ({ label: s.label, value: s.side })));
      if (!side) return null;
      const start = await options<number>(
        'Salve : trois bords voisins',
        Array.from({ length: GRID_SIZE - 2 }, (_, i) => ({ label: `${indexName(side, i)} à ${indexName(side, i + 2)}`, value: i })),
        2,
      );
      if (start === null) return null;
      return { edges: [0, 1, 2].map((k) => ({ side, index: start + k })) };
    }
  }
}

// ---------- onglet ----------

async function play(app: App, session: PlayerSession, def: SpellDef): Promise<void> {
  const why = session.spellBlocked(def.id);
  if (why) {
    toast(why, 'warn', 2500);
    return;
  }
  const params = await askParams(def, session);
  if (!params) return;
  const ok = await confirmBox(`Lancer « ${def.name} » ?`, `${def.desc} Lancer un sort remplace ton tir de ce tour.`, 'Lancer');
  if (!ok) return;
  if (session.cast(def.id, params)) app.setUi({ tab: 'shoot', selectedPiece: null });
  else toast('Impossible de lancer ce sort maintenant.', 'warn');
}

export function spellsTab(app: App, session: PlayerSession): HTMLElement {
  const st = session.state;
  const cfg = st.spellCfg;
  const counts = new Map<string, number>();
  for (const id of st.spells) counts.set(id, (counts.get(id) ?? 0) + 1);
  const canAct = session.isMyTurn && !st.pending;

  const rules: string[] = [];
  if (cfg.everyTurns > 0) rules.push(`un sort tous les ${cfg.everyTurns} de tes tours`);
  if (cfg.onSink) rules.push('un sort à chaque pièce adverse coulée');

  const card = (def: SpellDef, count: number | null) => {
    const blocked = count !== null ? session.spellBlocked(def.id) : 'x';
    return h(
      'article',
      { class: `spell-card${count === null ? ' spell-ref' : ''}` },
      h(
        'div',
        { class: 'spell-head' },
        h('strong', null, def.name),
        h('span', { class: `tag ${def.target === 'self' ? 'tag-muted' : 'tag-ok'}` }, def.target === 'self' ? 'secret' : 'vise l’adversaire'),
        count !== null && count > 1 ? h('span', { class: 'count' }, `×${count}`) : null,
      ),
      h('p', { class: 'muted small' }, def.desc),
      count !== null
        ? h('button', { class: 'btn btn-primary btn-sm', disabled: !!blocked, title: blocked ?? undefined, onclick: () => void play(app, session, def) }, icon(ICONS.wand), 'Lancer')
        : null,
    );
  };

  const mine = SPELLS.filter((d) => counts.has(d.id));
  const all = SPELLS.filter((d) => cfg.pool.includes(d.id));

  return h(
    'div',
    { class: 'tab-content' },
    h('h2', { class: 'screen-title' }, 'Sorts', h('span', { class: 'count' }, `${st.spells.length} en réserve`)),
    h('p', { class: 'muted small' }, rules.length ? `Tu gagnes ${rules.join(' et ')}. Lancer un sort remplace ton tir.` : 'Aucun sort n’est distribué automatiquement dans cette partie.'),
    st.silenced ? h('p', { class: 'notice' }, 'Réduit au silence : tu ne peux pas lancer de sort à ce tour.') : null,
    !canAct && mine.length ? h('p', { class: 'muted small' }, 'Tu pourras lancer tes sorts à ton tour.') : null,
    mine.length ? h('div', { class: 'spell-list' }, ...mine.map((d) => card(d, counts.get(d.id)!))) : h('p', { class: 'card' }, 'Ta réserve est vide pour l’instant.'),
    h('details', { class: 'spell-all' }, h('summary', null, `Tous les sorts de la partie (${all.length})`), h('div', { class: 'spell-list' }, ...all.map((d) => card(d, null)))),
  );
}

export { spellDef };
