/**
 * Écrans de partie : acceptation du jeu, placement, attente, jeu (3 onglets), fin.
 */

import { COLORS } from '../../config/pieces';
import { RULES } from '../../config/rules';
import {
  GRID_SIZE,
  cellKey,
  cellLabel,
  edgeLabel,
  pieceDef,
  placementParts,
  randomPlacement,
  rotateParts,
  sameEdge,
  setStats,
  validatePlacement,
  type Catalog,
  type Claim,
  type Edge,
  type Part,
  type Side,
} from '../../engine';
import type { GuessShape, NoteMark, PlayerSession, TurnEntry } from '../../game/session';
import type { PlayerIndex } from '../../game/protocol';
import { createBoard, describePieces, edgeAt, type BoardPiece, type EdgeShade } from '../boardView';
import { confirmBox, h, icon, modal, toast } from '../dom';
import { ICONS } from '../icons';
import { allSets, isBuiltinSet, setErrors } from '../library';
import { createPieceEditor, pieceName } from '../pieceEditor';
import { setDetails } from './settings';
import { spellsTab } from './spells';
import { describeSpell } from '../spellText';
import { activeEffects, spellOverlays } from '../spellVisual';
import type { App, GameCtx } from '../app';

// ---------- textes ----------

export function claimRuleText(): string {
  return RULES.correctClaimPassesTurn
    ? 'Si c’est juste, la pièce est coulée et c’est ensuite au tour de l’adversaire. Si c’est faux, tu perds ton tour.'
    : 'Si c’est juste, la pièce est coulée et tu rejoues. Si c’est faux, tu perds ton tour.';
}

function claimText(c: Claim, catalog: Catalog | null): string {
  const shape = catalog?.shapes[c.shape]?.name ?? c.shape;
  return `${shape} ${(COLORS[c.color]?.name ?? c.color).toLowerCase()} en ${c.cells.map(cellLabel).join(', ')}`;
}

function colorChips(colors: string[]): HTMLElement {
  if (colors.length === 0) return h('span', { class: 'muted' }, 'rien touché');
  return h(
    'span',
    { class: 'chips' },
    ...colors.map((c) => {
      const col = COLORS[c];
      return h('span', { class: 'chip' }, h('span', { class: 'chip-dot', style: { background: col?.hex ?? '#888' } }, col?.letter ?? '?'), col?.name ?? c);
    }),
  );
}

function turnSummary(e: TurnEntry, catalog: Catalog | null, session?: PlayerSession): HTMLElement {
  if (e.action.kind === 'spell') {
    const self = session && e.by === session.state.me ? session.state.selfLog[String(e.n)] : undefined;
    return h('span', { class: 'turn-desc' }, h('span', { class: 'tag tag-spell' }, 'Sort'), ' ', describeSpell(e, catalog, self));
  }
  if (e.action.kind === 'shot' && e.result.kind === 'shot') {
    const same = sameEdge(e.action.edge, e.result.exit);
    return h(
      'span',
      { class: 'turn-desc' },
      h('strong', null, edgeLabel(e.action.edge)),
      ' → ',
      same ? h('span', null, 'revient au départ') : h('span', null, 'ressort en ', h('strong', null, edgeLabel(e.result.exit))),
      ' · ',
      colorChips(e.result.colors),
    );
  }
  if (e.action.kind === 'claim' && e.result.kind === 'claim') {
    return h(
      'span',
      { class: 'turn-desc' },
      'Déclare ',
      h('strong', null, claimText(e.action.claim, catalog)),
      ' · ',
      e.result.ok ? h('span', { class: 'tag tag-ok' }, 'coulée') : h('span', { class: 'tag tag-bad' }, 'ratée'),
    );
  }
  return h('span', null, '?');
}

/** Retrouve, pour chaque pièce adverse coulée, une pièce du jeu et sa position. */
function sunkAsPlacements(claims: Claim[], catalog: Catalog): { placements: BoardPiece[]; ids: Set<string> } {
  const ids = new Set<string>();
  const placements: BoardPiece[] = [];
  for (const c of claims) {
    const def = catalog.pieces.find((p) => p.color === c.color && p.shape === c.shape && !ids.has(p.id));
    const shape = def && catalog.shapes[def.shape];
    if (!def || !shape) continue;
    const want = c.cells.map((x) => cellKey(x) + (x.corner ?? '')).sort().join('|');
    const wantCells = c.cells.map(cellKey).sort().join('|');
    const minR = Math.min(...c.cells.map((x) => x.r));
    const minC = Math.min(...c.cells.map((x) => x.c));
    let found: BoardPiece | null = null;
    for (let rot = 0; rot < 4 && !found; rot++) {
      const parts = rotateParts(shape.parts, rot as 0 | 1 | 2 | 3).map((p) => ({ ...p, r: p.r + minR, c: p.c + minC }));
      const got = parts.map((x) => cellKey(x) + (x.corner ?? '')).sort().join('|');
      const gotCells = parts.map(cellKey).sort().join('|');
      if (got === want || (gotCells === wantCells && !found)) found = { pieceId: def.id, r: minR, c: minC, rot: rot as 0 | 1 | 2 | 3, style: 'normal' };
    }
    if (found) {
      ids.add(def.id);
      placements.push(found);
    }
  }
  return { placements, ids };
}

/** Mes tirs (simples ou multiples) : entrée choisie et sortie. Un tour = un groupe. */
function myShots(session: PlayerSession): { edge: Edge; exit: Edge }[][] {
  const groups: { edge: Edge; exit: Edge }[][] = [];
  const resetAt = session.notesResetAt;
  for (const e of session.state.log) {
    if (e.by !== session.state.me || e.n < resetAt) continue; // tirs d'avant un mélange de la grille adverse : périmés
    if (e.action.kind === 'shot' && e.result.kind === 'shot') groups.push([{ edge: e.action.edge, exit: e.result.exit }]);
    else if (e.action.kind === 'spell' && e.result.kind === 'spell' && e.result.shots && e.action.edges) {
      const edges = e.action.edges;
      groups.push(e.result.shots.map((sh, i) => ({ edge: edges[i], exit: sh.exit })).filter((x) => x.edge));
    }
  }
  return groups;
}

function shotShades(session: PlayerSession): EdgeShade[] {
  const groups = myShots(session);
  const out: EdgeShade[] = [];
  groups.forEach((g, i) => {
    const last = i === groups.length - 1;
    for (const { edge, exit } of g) {
      if (sameEdge(edge, exit)) {
        out.push({ edge, kind: last ? 'both-last' : 'in' }, ...(last ? [] : [{ edge, kind: 'out' as const }]));
        continue;
      }
      out.push({ edge, kind: last ? 'in-last' : 'in' });
      out.push({ edge: exit, kind: last ? 'out-last' : 'out' });
    }
  });
  return out;
}

const SIDES: { side: Side; label: string }[] = [
  { side: 'top', label: 'Haut' },
  { side: 'right', label: 'Droite' },
  { side: 'bottom', label: 'Bas' },
  { side: 'left', label: 'Gauche' },
];

function stepEdge(e: Edge | null, delta: number): Edge {
  if (!e) return { side: 'top', index: 0 };
  return { side: e.side, index: (e.index + delta + GRID_SIZE) % GRID_SIZE };
}

// ---------- barre du haut ----------

export function topBar(app: App, ctx: GameCtx, session: PlayerSession): HTMLElement {
  const st = session.state;
  const phase = session.phase;
  let status: string;
  if (phase === 'review') status = 'Jeu de pièces';
  else if (phase === 'setup') status = 'Placement';
  else if (phase === 'waiting') status = 'En attente';
  else if (phase === 'over') status = 'Partie terminée';
  else if (st.pending) status = 'Coup envoyé…';
  else status = session.isMyTurn ? 'À toi de jouer' : `Au tour de ${st.oppName || 'l’adversaire'}`;
  const online = ctx.mode === 'online';
  const connected = session.connected;
  return h(
    'header',
    { class: 'topbar game-top' },
    h('button', { class: 'icon-btn', 'aria-label': 'Menu', onclick: () => app.openMenu() }, icon(ICONS.home)),
    h(
      'div',
      { class: 'top-center' },
      h('div', { class: 'players' }, h('span', { class: 'me' }, st.myName || 'Moi'), h('span', { class: 'vs' }, 'contre'), h('span', null, st.oppName || '…')),
      h('div', { class: `turn ${session.isMyTurn && !st.pending ? 'turn-me' : ''}`, 'aria-live': 'polite' }, status),
    ),
    online
      ? h(
          'button',
          {
            class: `icon-btn conn ${connected ? 'conn-ok' : 'conn-off'}`,
            'aria-label': connected ? 'Connecté' : 'Hors ligne : reconnecter',
            onclick: () => (connected ? toast('Connecté à l’autre téléphone', 'ok') : app.reconnect()),
          },
          icon(connected ? ICONS.wifi : ICONS.wifiOff),
        )
      : h('span', { class: 'icon-btn placeholder', 'aria-hidden': 'true' }),
  );
}

/** Bandeau fixe (hors défilement) : à qui de jouer, visible depuis tous les onglets. */
const ACTIVITY_TEXT: Record<string, { ic: string; text: string }> = {
  shoot: { ic: ICONS.laser, text: 'étudie la grille adverse' },
  aim: { ic: ICONS.laser, text: 'règle son tir' },
  notes: { ic: ICONS.notes, text: 'consulte son carnet' },
  spells: { ic: ICONS.wand, text: 'feuillette ses sorts' },
  'spell-pick': { ic: ICONS.wand, text: 'prépare un sort' },
  board: { ic: ICONS.board, text: 'inspecte son plateau' },
};

function turnBanner(ctx: GameCtx, session: PlayerSession): HTMLElement {
  const wrap = h('div', { class: 'turn-wrap' }, turnBannerText(session));
  const act = ctx.mode === 'online' && session.connected && session.oppActivity ? ACTIVITY_TEXT[session.oppActivity] : undefined;
  if (act) {
    wrap.append(
      h(
        'div',
        { class: `activity act-${session.oppActivity}`, role: 'status', 'aria-live': 'polite' },
        h('span', { class: 'act-icon' }, icon(act.ic)),
        h('span', { class: 'act-text' }, `${session.state.oppName || 'L’adversaire'} ${act.text}`),
        h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      ),
    );
  }
  return wrap;
}

function turnBannerText(session: PlayerSession): HTMLElement {
  const st = session.state;
  const mine = session.isMyTurn && !st.pending;
  const holder = session.attackerOf(st.log.length) === st.me ? st.myName || 'toi' : st.oppName || 'l’adversaire';
  let text: string;
  if (st.pending) text = 'Coup envoyé, en attente du résultat…';
  else if (mine) text = 'À toi de jouer !';
  else text = `Tour de ${holder}`;
  return h('div', { class: `turn-banner${mine ? ' mine' : ''}`, role: 'status', 'aria-live': 'polite' }, text);
}

export function offlineBanner(_app: App, ctx: GameCtx, session: PlayerSession): HTMLElement | null {
  if (ctx.mode !== 'online' || session.connected) return null;
  return h('div', { class: 'banner banner-warn', role: 'alert' }, h('span', null, 'Connexion perdue avec l’autre téléphone.'), h('button', { class: 'btn btn-sm btn-primary', onclick: () => _app.reconnect() }, 'Reconnecter'));
}

/** Hôte : l'invité a refusé le jeu, ou n'a pas encore répondu. */
function setStatusBanner(session: PlayerSession): HTMLElement | null {
  const st = session.state;
  if (st.me !== 0 || st.mode !== 'online') return null;
  if (st.oppRefused) {
    return h(
      'div',
      { class: 'banner banner-warn', role: 'alert' },
      h('span', null, `${st.oppName || 'L’autre joueur'} a refusé ce jeu de pièces.`),
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => proposeOtherSet(session) }, 'Proposer un autre jeu'),
    );
  }
  if (st.oppSetHash !== session.mySetHash && st.oppName) {
    return h('div', { class: 'banner banner-info' }, h('span', null, `${st.oppName} regarde le jeu de pièces proposé…`));
  }
  return null;
}

async function proposeOtherSet(session: PlayerSession): Promise<void> {
  const sets = allSets().filter((s) => isBuiltinSet(s.id) || setErrors(s).length === 0);
  let chosen: string | null = null;
  const list = h(
    'div',
    { class: 'set-list compact' },
    ...sets.map((set) =>
      h(
        'button',
        {
          class: 'set-choose',
          onclick: (ev: Event) => {
            chosen = set.id;
            (ev.currentTarget as HTMLElement).closest('.overlay')?.querySelector<HTMLButtonElement>('.btn-primary')?.click();
          },
        },
        h('span', { class: 'set-name' }, h('strong', null, set.name), h('small', null, `${setStats(set).pieces} pièces · ${setStats(set).cells} cases`)),
      ),
    ),
  );
  const v = await modal('Proposer un autre jeu', [h('p', { class: 'muted small' }, 'Une nouvelle partie démarre avec ce jeu ; l’autre joueur devra l’accepter.'), list], [
    { label: 'Annuler', value: 'no' },
    { label: 'OK', value: 'ok', kind: 'primary' },
  ]);
  const set = sets.find((s) => s.id === chosen);
  if (v === 'ok' && set) session.startNewGame(set);
}

// ---------- acceptation du jeu (invité) ----------

export function renderReview(app: App, ctx: GameCtx, session: PlayerSession): HTMLElement {
  const st = session.state;
  const set = st.proposedSet;
  const refused = set && st.refusedHash !== null;
  let body: HTMLElement;
  if (!set) {
    body = h('div', { class: 'waiting' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('p', null, `En attente du jeu de pièces de ${st.oppName || 'l’autre joueur'}…`));
  } else {
    const { pieces, cells } = setStats(set);
    body = h(
      'div',
      { class: 'tab-content' },
      h('h2', { class: 'screen-title' }, `Jeu proposé : ${set.name}`, h('span', { class: 'count' }, `${pieces} pièces · ${cells} cases`)),
      h('p', { class: 'muted small' }, `${st.oppName || 'L’autre joueur'} propose de jouer avec ces pièces. Chacun aura les mêmes.`),
      h('div', { class: 'paper-card' }, setDetails(set)),
      refused ? h('p', { class: 'notice' }, 'Tu as refusé ce jeu. En attente d’une autre proposition…') : null,
    );
  }
  return h(
    'div',
    { class: 'screen game' },
    topBar(app, ctx, session),
    offlineBanner(app, ctx, session),
    h('main', { class: 'scroll' }, body),
    set
      ? h(
          'footer',
          { class: 'actionbar two' },
          h('button', { class: 'btn btn-secondary btn-lg', disabled: !!refused, onclick: () => session.refuseProposedSet() }, 'Refuser'),
          h('button', { class: 'btn btn-primary btn-lg', onclick: () => session.acceptProposedSet() }, icon(ICONS.check), 'Accepter'),
        )
      : null,
  );
}

// ---------- placement ----------

export function renderPlacement(app: App, ctx: GameCtx, session: PlayerSession): HTMLElement {
  const cat = session.catalog!;
  const placements = session.state.placement;
  const complete = validatePlacement(placements, cat, { requireAll: true }).length === 0;
  const left = cat.pieces.length - placements.length;
  const editor = createPieceEditor({
    key: `place-${session.state.me}-${session.mySetHash}`,
    catalog: cat,
    board: { gutter: 'labels', label: 'Ma grille', description: describePieces(placements, cat) },
    placements,
    trayIds: cat.pieces.map((p) => p.id),
    trayTitle: 'Pièces à placer',
    selectedId: app.ui.selectedPiece,
    isValid: (ps) => validatePlacement(ps, cat).length === 0,
    onCommit: (ps) => session.setPlacement(ps),
    onSelect: (id) => app.setUi({ selectedPiece: id }),
    setDragging: (d) => app.setDragging(d),
  });

  return h(
    'div',
    { class: 'screen game' },
    topBar(app, ctx, session),
    offlineBanner(app, ctx, session),
    setStatusBanner(session),
    h(
      'main',
      { class: 'scroll' },
      h('h2', { class: 'screen-title' }, ctx.mode === 'local' ? `${session.state.myName}, place tes pièces` : 'Place tes pièces', h('span', { class: 'count' }, `${placements.length}/${cat.pieces.length}`)),
      h('p', { class: 'muted small' }, `Jeu « ${cat.set.name} ». Ton adversaire ne verra jamais ce placement.`),
      editor,
      h(
        'div',
        { class: 'btn-row' },
        h(
          'button',
          {
            class: 'btn btn-secondary',
            onclick: () => {
              session.setPlacement(randomPlacement(cat));
              app.setUi({ selectedPiece: null });
            },
          },
          icon(ICONS.dice),
          'Au hasard',
        ),
        h(
          'button',
          {
            class: 'btn btn-secondary',
            disabled: placements.length === 0,
            onclick: () => {
              session.setPlacement([]);
              app.setUi({ selectedPiece: null });
            },
          },
          icon(ICONS.trash),
          'Tout retirer',
        ),
      ),
    ),
    h(
      'footer',
      { class: 'actionbar' },
      h(
        'button',
        {
          class: 'btn btn-primary btn-lg',
          disabled: !complete,
          onclick: async () => {
            if (!(await confirmBox('Prêt ?', 'Ton placement sera verrouillé jusqu’à la fin de la partie.', 'Je suis prêt'))) return;
            if (session.markReady()) {
              app.setUi({ selectedPiece: null });
              app.afterReady(session);
            }
          },
        },
        icon(ICONS.check),
        complete ? 'Prêt' : `Place encore ${left} pièce${left > 1 ? 's' : ''}`,
      ),
    ),
  );
}

// ---------- attente ----------

export function renderWaiting(app: App, ctx: GameCtx, session: PlayerSession): HTMLElement {
  const cat = session.catalog!;
  const board = createBoard({ catalog: cat, gutter: 'labels', label: 'Mon plateau', pieces: session.state.placement, description: describePieces(session.state.placement, cat) });
  return h(
    'div',
    { class: 'screen game' },
    topBar(app, ctx, session),
    offlineBanner(app, ctx, session),
    setStatusBanner(session),
    h(
      'main',
      { class: 'scroll' },
      h('div', { class: 'waiting' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('p', null, `En attente de ${session.state.oppName || 'l’autre joueur'}…`)),
      h('p', { class: 'muted small center' }, 'La partie commence dès que les deux joueurs sont prêts. Le premier joueur est tiré au sort.'),
      board.root,
    ),
  );
}

// ---------- jeu ----------

export function renderPlaying(app: App, ctx: GameCtx, session: PlayerSession): HTMLElement {
  const tab = app.ui.tab;
  let content: HTMLElement;
  if (tab === 'notes') content = notesTab(app, session);
  else if (tab === 'spells' && session.state.spellCfg.enabled) content = spellsTab(app, session);
  else if (tab === 'board') content = boardTab(app, session);
  else content = shootTab(app, ctx, session);

  const tabBtn = (id: typeof tab, label: string, ic: string, badge?: boolean) =>
    h(
      'button',
      { role: 'tab', class: `tab ${tab === id ? 'active' : ''}`, 'aria-selected': tab === id ? 'true' : 'false', onclick: () => app.setUi({ tab: id, selectedPiece: null }) },
      icon(ic),
      h('span', null, label),
      badge ? h('span', { class: 'badge', 'aria-label': 'nouveau' }) : null,
    );

  return h(
    'div',
    { class: 'screen game' },
    topBar(app, ctx, session),
    turnBanner(ctx, session),
    offlineBanner(app, ctx, session),
    h('main', { class: 'scroll', id: 'game-scroll' }, content),
    h(
      'nav',
      { class: 'tabbar', role: 'tablist', 'aria-label': 'Navigation' },
      tabBtn('shoot', 'Tirer', ICONS.laser),
      tabBtn('notes', 'Carnet', ICONS.notes),
      session.state.spellCfg.enabled ? tabBtn('spells', 'Sorts', ICONS.wand, session.state.spells.length > 0 && session.isMyTurn && !session.state.pending) : null,
      tabBtn('board', 'Mon plateau', ICONS.board, app.ui.unseenIncoming),
    ),
  );
}

function shootTab(app: App, ctx: GameCtx, session: PlayerSession): HTMLElement {
  const st = session.state;
  const cat = session.catalog!;
  const canAct = session.isMyTurn && !st.pending;
  const sunk = sunkAsPlacements(session.oppSunk, cat);
  const guesses: BoardPiece[] = st.notes.guesses.filter((g) => !sunk.ids.has(g.pieceId)).map((g) => ({ ...g, style: 'guess' }));
  const selected = canAct ? app.ui.selectedEdge : null;
  const lastMineEntry = [...st.log].reverse().find((e) => e.by === st.me);

  const fire = () => {
    if (selected && session.shoot(selected)) app.setUi({ selectedEdge: null });
  };

  const board = createBoard({
    catalog: cat,
    gutter: 'buttons',
    label: canAct ? 'Grille adverse : touche un bord pour viser. Au clavier : flèches pour choisir, Entrée pour tirer.' : 'Grille adverse',
    className: 'target',
    pieces: [...sunk.placements, ...guesses],
    marks: st.notes.marks,
    edgeShades: shotShades(session),
    selectedEdge: selected,
    overlays: lastMineEntry?.action.kind === 'spell' ? spellOverlays(lastMineEntry, st.selfLog[String(lastMineEntry.n)]) : [],
  });
  board.svg.setAttribute('tabindex', '0');
  board.svg.addEventListener('click', (e) => {
    const cell = board.rawCellAt(e.clientX, e.clientY);
    const edge = cell && edgeAt(cell);
    if (!edge) return;
    if (!canAct) {
      toast(st.pending ? 'Coup en cours…' : 'Ce n’est pas ton tour', 'info', 1500);
      return;
    }
    app.setUi({ selectedEdge: edge });
  });
  board.svg.addEventListener('keydown', (e) => {
    if (!canAct) return;
    const map: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (e.key in map) {
      e.preventDefault();
      const next = selected ? stepEdge(selected, map[e.key]) : { side: 'top' as Side, index: 0 };
      app.setUi({ selectedEdge: next });
      requestAnimationFrame(() => document.querySelector<SVGElement>('svg.target')?.focus());
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fire();
    }
  });

  const parts: (HTMLElement | null)[] = [];

  if (st.pending) {
    parts.push(
      h(
        'div',
        { class: 'card card-busy' },
        h('span', { class: 'spinner', 'aria-hidden': 'true' }),
        h('span', null, st.pending.action.kind === 'shot' ? `Tir ${edgeLabel(st.pending.action.edge)} envoyé, en attente du résultat…` : st.pending.action.kind === 'spell' ? 'Sort lancé, en attente du résultat…' : 'Déclaration envoyée, vérification…'),
        ctx.mode === 'online' ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => session.resendPending() }, 'Renvoyer') : null,
      ),
    );
  } else if (!session.isMyTurn) {
    if (ctx.mode === 'local') {
      parts.push(h('button', { class: 'btn btn-primary btn-lg handoff-btn', onclick: () => app.handoff((1 - st.me) as PlayerIndex) }, icon(ICONS.phone), `Passer le téléphone à ${st.oppName}`));
    } else {
      parts.push(h('div', { class: 'card card-wait' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', null, `${st.oppName || 'L’adversaire'} réfléchit…`)));
    }
  }

  const lastMine = [...st.log].reverse().find((e) => e.by === st.me);
  const lastTheirs = [...st.log].reverse().find((e) => e.by !== st.me);
  if (lastMine) parts.push(h('div', { class: 'card card-result' }, h('div', { class: 'card-label' }, 'Ton dernier coup'), turnSummary(lastMine, cat, session)));

  parts.push(board.root);

  if (canAct) {
    parts.push(
      h(
        'div',
        { class: 'aim-panel' },
        h(
          'div',
          { class: 'segmented sides', role: 'radiogroup', 'aria-label': 'Côté du tir' },
          ...SIDES.map(({ side, label }) =>
            h(
              'button',
              {
                class: `seg${selected?.side === side ? ' active' : ''}`,
                role: 'radio',
                'aria-checked': selected?.side === side ? 'true' : 'false',
                onclick: () => app.setUi({ selectedEdge: { side, index: selected?.index ?? 0 } }),
              },
              label,
            ),
          ),
        ),
        h(
          'div',
          { class: 'aimbar' },
          h('button', { class: 'icon-btn big', 'aria-label': 'Position précédente', onclick: () => app.setUi({ selectedEdge: stepEdge(selected, -1) }) }, icon(ICONS.chevronLeft)),
          h('div', { class: 'aim-label', 'aria-live': 'polite' }, selected ? edgeLabel(selected) : 'Choisis un bord'),
          h('button', { class: 'icon-btn big', 'aria-label': 'Position suivante', onclick: () => app.setUi({ selectedEdge: stepEdge(selected, 1) }) }, icon(ICONS.chevronRight)),
          h('button', { class: 'btn btn-primary btn-fire', disabled: !selected, onclick: fire }, 'Tirer'),
        ),
      ),
      h('button', { class: 'btn btn-secondary', onclick: () => app.setUi({ tab: 'notes', tool: 'shapes', selectedPiece: null }) }, icon(ICONS.flag), 'Déclarer une pièce (au lieu de tirer)'),
    );
  }

  if (lastTheirs) {
    parts.push(
      h(
        'button',
        { class: 'card card-incoming', onclick: () => app.setUi({ tab: 'board', viewTurn: lastTheirs.n }) },
        h('div', { class: 'card-label' }, `Dernier coup de ${st.oppName || 'l’adversaire'}`),
        turnSummary(lastTheirs, cat, session),
        h('span', { class: 'card-link' }, icon(ICONS.eye), 'Voir sur mon plateau'),
      ),
    );
  }

  const hist = [...st.log].reverse();
  parts.push(
    h(
      'section',
      { class: 'history' },
      h('h3', null, 'Historique'),
      hist.length === 0
        ? h('p', { class: 'muted small' }, 'Aucun coup pour l’instant.')
        : h('ol', { class: 'history-list' }, ...hist.map((e) => h('li', { class: e.by === st.me ? 'mine' : 'theirs' }, h('span', { class: 'who' }, e.by === st.me ? 'Toi' : st.oppName || 'Adv.'), turnSummary(e, cat, session)))),
    ),
  );
  return h('div', { class: 'tab-content' }, ...parts);
}

function notesTab(app: App, session: PlayerSession): HTMLElement {
  const st = session.state;
  const cat = session.catalog!;
  const notes = st.notes;
  const tool = app.ui.tool;
  const sunk = sunkAsPlacements(session.oppSunk, cat);
  const guesses = notes.guesses.filter((g) => !sunk.ids.has(g.pieceId) && pieceDef(g.pieceId, cat));
  const canAct = session.isMyTurn && !st.pending;

  const tools: { id: typeof tool; label: string; ic: string }[] = [
    { id: 'x', label: 'Croix', ic: ICONS.cross },
    { id: 'o', label: 'Vide', ic: ICONS.circle },
    { id: '?', label: 'Doute', ic: ICONS.question },
    { id: 'erase', label: 'Gomme', ic: ICONS.eraser },
    { id: 'shapes', label: 'Formes', ic: ICONS.shapes },
  ];
  const toolbar = h(
    'div',
    { class: 'toolbar', role: 'toolbar', 'aria-label': 'Outils du carnet' },
    ...tools.map((t) =>
      h('button', { class: `tool ${tool === t.id ? 'active' : ''}`, 'aria-pressed': tool === t.id ? 'true' : 'false', onclick: () => app.setUi({ tool: t.id, selectedPiece: null }) }, icon(t.ic), h('span', null, t.label)),
    ),
  );

  let boardEl: HTMLElement;
  if (tool === 'shapes') {
    const trayIds = session.oppPieces.map((p) => p.id).filter((id) => !sunk.ids.has(id));
    boardEl = createPieceEditor({
      key: `notes-${st.me}-${session.mySetHash}`,
      catalog: cat,
      board: { gutter: 'labels', label: 'Carnet : formes supposées', marks: notes.marks, edgeShades: shotShades(session) },
      placements: guesses,
      fixed: sunk.placements,
      editableStyle: 'guess',
      trayIds,
      trayTitle: 'Pièces adverses',
      selectedId: app.ui.selectedPiece,
      isValid: (ps) => {
        const taken = new Set(sunk.placements.flatMap((p) => placementParts(p, cat).map(cellKey)));
        const seen = new Set<string>();
        for (const p of ps)
          for (const c of placementParts(p, cat)) {
            const k = cellKey(c);
            if (taken.has(k) || seen.has(k)) return false;
            seen.add(k);
          }
        return true;
      },
      onCommit: (ps) => session.setNotes({ ...notes, guesses: ps as GuessShape[] }),
      onSelect: (id) => app.setUi({ selectedPiece: id }),
      setDragging: (d) => app.setDragging(d),
      extraActions: (id, placed) => {
        if (!placed) return [];
        const g = guesses.find((x) => x.pieceId === id)!;
        return [h('button', { class: 'btn btn-primary btn-sm', disabled: !canAct, title: canAct ? undefined : 'Seulement à ton tour', onclick: () => declare(app, session, g) }, icon(ICONS.flag), 'Déclarer')];
      },
    });
  } else {
    const board = createBoard({
      catalog: cat,
      gutter: 'labels',
      label: 'Carnet de notes : touche une case pour la marquer',
      className: 'notes-board',
      pieces: [...sunk.placements, ...guesses.map((g) => ({ ...g, style: 'guess' as const }))],
      marks: notes.marks,
      edgeShades: shotShades(session),
    });
    board.svg.addEventListener('click', (e) => {
      const cell = board.rawCellAt(e.clientX, e.clientY);
      if (!cell || cell.r < 0 || cell.c < 0 || cell.r >= GRID_SIZE || cell.c >= GRID_SIZE) return;
      const k = cellKey(cell);
      const marks = { ...notes.marks };
      if (tool === 'erase') {
        delete marks[k];
        session.setNotes({ marks, guesses: notes.guesses.filter((g) => !placementParts(g, cat).some((c) => cellKey(c) === k)) });
      } else {
        const m = tool as NoteMark;
        if (marks[k] === m) delete marks[k];
        else marks[k] = m;
        session.setNotes({ ...notes, marks });
      }
    });
    boardEl = board.root;
  }

  const legend = h(
    'section',
    { class: 'legend' },
    h('h3', null, 'Pièces adverses'),
    h(
      'ul',
      { class: 'legend-list' },
      ...session.oppPieces.map((p) => {
        const state = sunk.ids.has(p.id) ? 'coulée' : guesses.some((g) => g.pieceId === p.id) ? 'supposée' : '';
        return h(
          'li',
          { class: state === 'coulée' ? 'is-sunk' : '' },
          h('span', { class: 'swatch', style: { background: COLORS[p.color]?.hex } }, COLORS[p.color]?.letter ?? '?'),
          h('span', null, pieceName(p.id, cat)),
          state ? h('span', { class: `tag ${state === 'coulée' ? 'tag-ok' : 'tag-muted'}` }, state) : null,
        );
      }),
    ),
  );

  return h(
    'div',
    { class: 'tab-content' },
    toolbar,
    tool === 'shapes'
      ? h('p', { class: 'muted small' }, canAct ? `Pose une forme supposée, sélectionne-la puis « Déclarer ». ${claimRuleText()}` : 'Pose les formes que tu soupçonnes. Tu pourras les déclarer à ton tour.')
      : h('p', { class: 'muted small' }, 'Touche une case pour la marquer. Dans la marge : point = entrée de tes tirs, rond = sortie (en rouge : ton dernier tir).'),
    boardEl,
    legend,
    h(
      'button',
      {
        class: 'btn btn-ghost',
        onclick: async () => {
          if (await confirmBox('Effacer le carnet ?', 'Toutes tes marques et formes supposées seront effacées.', 'Effacer', true)) session.setNotes({ marks: {}, guesses: [] });
        },
      },
      icon(ICONS.trash),
      'Effacer le carnet',
    ),
  );
}

async function declare(app: App, session: PlayerSession, g: GuessShape): Promise<void> {
  const cat = session.catalog!;
  const def = pieceDef(g.pieceId, cat)!;
  const cells: Part[] = placementParts(g, cat);
  const claim: Claim = { color: def.color, shape: def.shape, cells };
  const ok = await confirmBox('Déclarer cette pièce ?', `${claimText(claim, cat)}. ${claimRuleText()}`, 'Déclarer');
  if (!ok) return;
  if (session.claim(claim)) app.setUi({ selectedPiece: null, tab: 'shoot' });
  else toast('Impossible maintenant (ce n’est pas ton tour).', 'warn');
}

function boardTab(app: App, session: PlayerSession): HTMLElement {
  const st = session.state;
  const cat = session.catalog!;
  const sunk = session.mySunk;
  const received = st.log.filter((e) => e.by !== st.me);
  const viewN = app.ui.viewTurn ?? received[received.length - 1]?.n ?? null;
  const viewed = received.find((e) => e.n === viewN) ?? null;

  const pieces: BoardPiece[] = st.placement.map((p) => ({ ...p, style: sunk.has(p.pieceId) ? 'sunk' : 'normal' }));
  const allPaths = viewed?.secret?.paths?.length ? viewed.secret.paths : viewed?.secret?.path?.length ? [viewed.secret.path] : [];
  const paths = allPaths.filter((p) => p.length).map((points) => ({ points }));
  const shades: EdgeShade[] = [];
  if (viewed && viewed.action.kind === 'shot' && viewed.result.kind === 'shot') {
    if (sameEdge(viewed.action.edge, viewed.result.exit)) shades.push({ edge: viewed.action.edge, kind: 'both-last' });
    else shades.push({ edge: viewed.action.edge, kind: 'in-last' }, { edge: viewed.result.exit, kind: 'out-last' });
  }
  if (viewed && viewed.action.kind === 'spell' && viewed.result.kind === 'spell' && viewed.result.shots && viewed.action.edges) {
    viewed.result.shots.forEach((sh, i) => {
      const edge = viewed.action.kind === 'spell' ? viewed.action.edges?.[i] : undefined;
      if (!edge) return;
      if (sameEdge(edge, sh.exit)) shades.push({ edge, kind: 'both-last' });
      else shades.push({ edge, kind: 'in-last' }, { edge: sh.exit, kind: 'out-last' });
    });
  }
  const claimCells = viewed?.action.kind === 'claim' ? viewed.action.claim.cells : [];
  const board = createBoard({
    catalog: cat,
    gutter: 'labels',
    label: 'Mon plateau',
    description: describePieces(st.placement, cat, sunk),
    pieces,
    paths,
    edgeShades: shades,
    overlays: viewed ? spellOverlays(viewed) : [],
    marks: Object.fromEntries(claimCells.map((c) => [cellKey(c), '?' as NoteMark])),
  });

  const effects = activeEffects(session);
  const remaining = st.placement.length - st.placement.filter((p) => sunk.has(p.pieceId)).length;
  return h(
    'div',
    { class: 'tab-content' },
    h('h2', { class: 'screen-title' }, 'Mon plateau', h('span', { class: 'count' }, `${remaining}/${st.placement.length} pièces à flot`)),
    viewed
      ? h('div', { class: 'card card-result' }, h('div', { class: 'card-label' }, `Coup reçu n°${received.indexOf(viewed) + 1}`), turnSummary(viewed, cat, session))
      : h('p', { class: 'muted small' }, 'Tu n’as encore reçu aucun tir.'),
    effects.length ? h('div', { class: 'effects' }, ...effects.map((x) => h('div', { class: 'effect-chip' }, x))) : null,
    board.root,
    received.length
      ? h(
          'section',
          { class: 'history' },
          h('h3', null, 'Coups reçus (touche pour voir le trajet)'),
          h(
            'ol',
            { class: 'history-list selectable' },
            ...[...received].reverse().map((e) =>
              h(
                'li',
                { class: e.n === viewN ? 'active' : '' },
                h('button', { class: 'history-btn', 'aria-pressed': e.n === viewN ? 'true' : 'false', onclick: () => app.setUi({ viewTurn: e.n }) }, h('span', { class: 'who' }, `n°${received.indexOf(e) + 1}`), turnSummary(e, cat, session)),
              ),
            ),
          ),
        )
      : null,
  );
}

// ---------- fin ----------

export function renderOver(app: App, ctx: GameCtx, session: PlayerSession): HTMLElement {
  const st = session.state;
  const cat = session.catalog!;
  const won = session.winner === st.me;
  const mine = st.log.filter((e) => e.by === st.me);
  const shots = mine.filter((e) => e.action.kind === 'shot').length;
  const claimsOk = mine.filter((e) => e.result.kind === 'claim' && e.result.ok).length;
  const claimsBad = mine.filter((e) => e.result.kind === 'claim' && !e.result.ok).length;
  const board = createBoard({ catalog: cat, gutter: 'labels', label: 'Mon plateau', pieces: st.placement.map((p) => ({ ...p, style: session.mySunk.has(p.pieceId) ? 'sunk' : 'normal' })) });
  const winnerName = ctx.mode === 'local' ? (won ? st.myName : st.oppName) : null;
  return h(
    'div',
    { class: 'screen game over' },
    h(
      'main',
      { class: 'scroll' },
      h(
        'div',
        { class: `result-hero ${won ? 'won' : 'lost'}` },
        h('h1', null, winnerName ? `${winnerName} gagne` : won ? 'Victoire' : 'Défaite'),
        h('p', null, won ? 'Toutes les pièces adverses sont coulées.' : `${st.oppName || 'L’adversaire'} a coulé toutes ${ctx.mode === 'local' ? 'les pièces de ' + st.myName : 'tes pièces'}.`),
      ),
      h(
        'dl',
        { class: 'stats' },
        h('div', null, h('dt', null, 'Tirs'), h('dd', null, String(shots))),
        h('div', null, h('dt', null, 'Déclarations justes'), h('dd', null, String(claimsOk))),
        h('div', null, h('dt', null, 'Déclarations ratées'), h('dd', null, String(claimsBad))),
        h('div', null, h('dt', null, 'Coups joués'), h('dd', null, String(st.log.length))),
      ),
      h('h3', null, ctx.mode === 'local' ? `Plateau de ${st.myName}` : 'Mon plateau'),
      board.root,
    ),
    h(
      'footer',
      { class: 'actionbar two' },
      h('button', { class: 'btn btn-secondary btn-lg', onclick: () => app.goHome() }, icon(ICONS.home), 'Accueil'),
      h(
        'button',
        {
          class: 'btn btn-primary btn-lg',
          onclick: () => {
            if (ctx.mode === 'online' && !session.connected) {
              toast('Reconnecte-toi d’abord pour lancer la revanche.', 'warn');
              app.reconnect();
              return;
            }
            app.rematch();
          },
        },
        icon(ICONS.rotate),
        'Revanche',
      ),
    ),
  );
}

// ---------- passage du téléphone (mode un seul appareil) ----------

export function renderHandoff(app: App, name: string, info: string | null): HTMLElement {
  return h(
    'div',
    { class: 'screen handoff' },
    h(
      'main',
      { class: 'handoff-box' },
      icon(ICONS.phone),
      h('h1', null, `Passe le téléphone à ${name}`),
      h('p', { class: 'muted' }, 'L’autre joueur ne doit pas regarder l’écran.'),
      info ? h('p', { class: 'card' }, info) : null,
      h('button', { class: 'btn btn-primary btn-lg', onclick: () => app.endHandoff() }, `C’est moi, ${name}`),
    ),
  );
}
