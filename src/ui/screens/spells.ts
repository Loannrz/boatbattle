/**
 * Onglet « Sorts » : réserve du joueur, lancement (avec choix des paramètres) et liste de tous les sorts.
 */

import { COLORS } from '../../config/pieces';
import { COL_LABELS, GRID_SIZE, SPELLS, cellLabel, catalogOf, spellDef, validatePlacement, type Edge, type Rotation, type Side, type SpellDef } from '../../engine';
import type { PlayerSession } from '../../game/session';
import type { SpellAction } from '../../game/protocol';
import type { App } from '../app';
import { confirmBox, h, icon, toast } from '../dom';
import { ICONS } from '../icons';
import { createPieceEditor } from '../pieceEditor';
import { createBoard } from '../boardView';
import { demoOverlays } from '../spellVisual';
import type { BoardPiece } from '../boardView';

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
interface Spot {
  r: number;
  c: number;
  rot: Rotation;
}

/** Choix de la pièce à ajouter puis de son emplacement sur ma grille. */
async function pickPieceAndSpot(app: App, session: PlayerSession): Promise<{ params: Partial<SpellAction>; spot: Spot } | null> {
  const set = session.state.pieceSet;
  if (!set) return null;
  const pairs = set.entries.map((e) => ({ shape: e.shape, color: e.color }));
  const choice = await options<{ shape: string; color: string }>(
    'Quelle pièce ajouter à ta grille ?',
    pairs.map((p) => ({
      label: `${set.shapes.find((s) => s.id === p.shape)?.name ?? p.shape} ${(COLORS[p.color]?.name ?? p.color).toLowerCase()}`,
      value: p,
      swatch: COLORS[p.color]?.hex,
    })),
    1,
    'Elle s’ajoute aux pièces de ton adversaire à trouver. Tu la poses où tu veux (même sur une pièce coulée), il ne verra pas où.',
  );
  if (!choice) return null;
  const n = session.state.log.length;
  const def = { id: `x${n}.${choice.shape}.${choice.color}`, shape: choice.shape, color: choice.color };
  const base = session.catalog!;
  const cat = { ...catalogOf(set), pieces: [...base.pieces, def], shapes: base.shapes };
  const fixed: BoardPiece[] = session.state.placement.map((p) => ({ ...p, style: session.mySunk.has(p.pieceId) ? 'sunk' : 'normal' }));
  const spot = await pickModal<Spot>('Place la nouvelle pièce', (done) => {
    const holder = h('div', null);
    let current: Spot | null = null;
    const okBtn = h('button', { class: 'btn btn-primary', disabled: true, onclick: () => current && done(current) }, icon(ICONS.check), 'Poser ici');
    const draw = () => {
      holder.replaceChildren(
        createPieceEditor({
          key: `spell-add-${session.state.me}`,
          catalog: cat,
          board: { gutter: 'labels', label: 'Ma grille' },
          placements: current ? [{ pieceId: def.id, ...current }] : [],
          fixed,
          trayIds: [def.id],
          trayTitle: 'Pièce à poser',
          selectedId: def.id,
          isValid: (ps) => validatePlacement([...session.alivePlacement(), ...ps], cat).length === 0,
          onCommit: (ps) => {
            const p = ps.find((x) => x.pieceId === def.id);
            current = p ? { r: p.r, c: p.c, rot: p.rot } : null;
            okBtn.disabled = !current;
            draw();
          },
          onSelect: () => {},
          setDragging: (d) => app.setDragging(d),
        }),
      );
    };
    draw();
    return [h('p', { class: 'muted small' }, 'Glisse la pièce sur ta grille (touche-la pour la faire pivoter), puis valide.'), holder, okBtn];
  });
  return spot ? { params: { shape: choice.shape, color: choice.color }, spot } : null;
}

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
    case 'run': {
      const count = def.count ?? 3;
      const side = await options<Side>(`${def.name} : quel côté ?`, SIDE_NAMES.map((s) => ({ label: s.label, value: s.side })));
      if (!side) return null;
      const start = await options<number>(
        `${def.name} : ${count} bords voisins`,
        Array.from({ length: GRID_SIZE - count + 1 }, (_, i) => ({ label: `${indexName(side, i)} à ${indexName(side, i + count - 1)}`, value: i })),
        2,
      );
      if (start === null) return null;
      return { edges: Array.from({ length: count }, (_, k) => ({ side, index: start + k })) };
    }
    case 'axis':
      return options<Partial<SpellAction>>(def.name, [
        { label: 'Toutes les lignes', value: { opt: 'row' } },
        { label: 'Toutes les colonnes', value: { opt: 'col' } },
      ]);
    case 'revived':
      return {}; // la pièce est tirée au hasard au moment du lancer
    case 'piece':
      return {}; // géré à part (choix de la pièce puis de l'emplacement)
  }
}

// ---------- onglet ----------

async function play(app: App, session: PlayerSession, def: SpellDef): Promise<void> {
  const why = session.spellBlocked(def.id);
  if (why) {
    toast(why, 'warn', 2500);
    return;
  }
  let params: Partial<SpellAction> | null;
  let spot: Spot | undefined;
  if (def.param === 'piece') {
    const res = await pickPieceAndSpot(app, session);
    if (!res) return;
    params = res.params;
    spot = res.spot;
  } else {
    params = await askParams(def, session);
    if (!params) return;
  }
  const cost = def.id === 'freeze' ? 'Ce sort ne prend pas ton tour.' : 'Lancer un sort remplace ton tir de ce tour.';
  const ok = await confirmBox(`Lancer « ${def.name} » ?`, `${def.desc} ${cost}`, 'Lancer');
  if (!ok) return;
  if (session.cast(def.id, params, spot)) app.setUi({ tab: 'shoot', selectedPiece: null });
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
    const demo = createBoard({ catalog: null, gutter: 'none', overlays: demoOverlays(def.id), label: `Schéma du sort ${def.name}`, className: 'spell-demo' });
    return h(
      'article',
      { class: `spell-card has-demo${count === null ? ' spell-ref' : ''}` },
      h('div', { class: 'spell-demo-wrap' }, demo.root),
      h(
        'div',
        { class: 'spell-body' },
        h(
          'div',
          { class: 'spell-head' },
          h('strong', null, def.name),
          h('span', { class: `tag ${def.target === 'self' ? 'tag-muted' : 'tag-ok'}` }, def.target === 'self' ? 'secret' : ['addpiece', 'revive', 'shuffle'].includes(def.id) ? 'public' : 'vise l’adversaire'),
          count !== null && count > 1 ? h('span', { class: 'count' }, `×${count}`) : null,
        ),
        h('p', { class: 'muted small' }, def.desc),
        count !== null
          ? h('button', { class: 'btn btn-primary btn-sm', disabled: !!blocked, title: blocked ?? undefined, onclick: () => void play(app, session, def) }, icon(ICONS.wand), 'Lancer')
          : null,
      ),
    );
  };

  const mine = SPELLS.filter((d) => counts.has(d.id));
  const all = SPELLS.filter((d) => cfg.pool.includes(d.id));

  return h(
    'div',
    { class: 'tab-content' },
    h('h2', { class: 'screen-title' }, 'Sorts', h('span', { class: 'count' }, `${st.spells.length} en réserve`)),
    h('p', { class: 'muted small' }, rules.length ? `Tu gagnes ${rules.join(' et ')}. Lancer un sort remplace ton tir (sauf Gel).` : 'Aucun sort n’est distribué automatiquement dans cette partie.'),
    st.silenced ? h('p', { class: 'notice' }, 'Réduit au silence : tu ne peux pas lancer de sort à ce tour.') : null,
    !canAct && mine.length ? h('p', { class: 'muted small' }, 'Tu pourras lancer tes sorts à ton tour.') : null,
    mine.length ? h('div', { class: 'spell-list' }, ...mine.map((d) => card(d, counts.get(d.id)!))) : h('p', { class: 'card' }, 'Ta réserve est vide pour l’instant.'),
    h('details', { class: 'spell-all' }, h('summary', null, `Tous les sorts de la partie (${all.length})`), h('div', { class: 'spell-list' }, ...all.map((d) => card(d, null)))),
  );
}

export { spellDef };
