/**
 * Écrans de partie : salon, acceptation du jeu, placement, attente, jeu (onglets), fin.
 * À 3 ou 4 joueurs, les onglets Tirer et Carnet montrent une grille par adversaire ;
 * toucher une grille l'agrandit (c'est là qu'on choisit sa cible).
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
import { playerColor, type App, type GameCtx } from '../app';

// ---------- textes ----------

export function claimRuleText(): string {
  return RULES.correctClaimPassesTurn
    ? 'Si c’est juste, la pièce est coulée et c’est ensuite au tour du joueur suivant. Si c’est faux, tu perds ton tour.'
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

/** Pastille d'un joueur : initiale sur sa couleur (barrée s'il est éliminé). */
export function playerChip(session: PlayerSession, i: PlayerIndex, opts: { name?: boolean; small?: boolean } = {}): HTMLElement {
  const name = session.nameOf(i);
  const me = i === session.state.me;
  const dead = !session.isAlive(i);
  const off = !session.isOnline(i);
  const cls = ['pchip', me ? 'is-me' : '', dead ? 'is-dead' : '', off ? 'is-off' : '', opts.small ? 'small' : ''].filter(Boolean).join(' ');
  return h(
    'span',
    { class: cls, title: `${name}${me ? ' (toi)' : ''}${dead ? ' · éliminé' : ''}${off ? ' · hors ligne' : ''}` },
    h('span', { class: 'pchip-dot', style: { background: playerColor(i) } }, (name.trim()[0] ?? '?').toUpperCase()),
    opts.name === false ? null : h('span', { class: 'pchip-name' }, me ? 'Toi' : name),
  );
}

function turnSummary(e: TurnEntry, catalog: Catalog | null, session: PlayerSession): HTMLElement {
  if (e.action.kind === 'spell') {
    const self = e.by === session.state.me ? session.state.selfLog[String(e.n)] : undefined;
    return h('span', { class: 'turn-desc' }, h('span', { class: 'tag tag-spell' }, 'Sort'), ' ', describeSpell(e, catalog, self, (i) => session.nameOf(i)));
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
      e.result.ok ? h('span', { class: 'tag tag-ok' }, e.result.eliminated ? 'coulée, éliminé !' : 'coulée') : h('span', { class: 'tag tag-bad' }, 'ratée'),
    );
  }
  return h('span', null, '?');
}

/** « Qui → qui » d'un tour (à deux : Toi / nom). */
function turnWho(e: TurnEntry, session: PlayerSession): HTMLElement {
  if (session.playerCount === 2) return h('span', { class: 'who' }, e.by === session.state.me ? 'Toi' : session.nameOf(e.by));
  return h('span', { class: 'who who-multi' }, playerChip(session, e.by, { name: false }), e.target !== e.by ? h('span', { class: 'arrow', 'aria-label': 'vise' }, '→') : null, e.target !== e.by ? playerChip(session, e.target, { name: false }) : null);
}

function historyList(entries: TurnEntry[], session: PlayerSession, catalog: Catalog | null): HTMLElement {
  const st = session.state;
  return h(
    'ol',
    { class: 'history-list' },
    ...entries.map((e) => h('li', { class: e.by === st.me ? 'mine' : e.target === st.me ? 'theirs at-me' : 'theirs' }, turnWho(e, session), turnSummary(e, catalog, session))),
  );
}

/** Retrouve, pour chaque pièce coulée, une pièce du jeu et sa position. */
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

/** Tirs reçus par la grille de `owner` (simples ou multiples), par tour : entrée, sortie, tireur. */
function shotsOn(session: PlayerSession, owner: PlayerIndex, onlyMine: boolean): { by: PlayerIndex; shots: { edge: Edge; exit: Edge }[] }[] {
  const groups: { by: PlayerIndex; shots: { edge: Edge; exit: Edge }[] }[] = [];
  const resetAt = session.notesResetAt(owner);
  for (const e of session.state.log) {
    if (e.target !== owner || e.by === owner || e.n < resetAt) continue; // tirs d'avant un mélange de la grille : périmés
    if (onlyMine && e.by !== session.state.me) continue;
    if (e.action.kind === 'shot' && e.result.kind === 'shot') groups.push({ by: e.by, shots: [{ edge: e.action.edge, exit: e.result.exit }] });
    else if (e.action.kind === 'spell' && e.result.kind === 'spell' && e.result.shots && e.action.edges) {
      const edges = e.action.edges;
      groups.push({ by: e.by, shots: e.result.shots.map((sh, i) => ({ edge: edges[i], exit: sh.exit })).filter((x) => x.edge) });
    }
  }
  return groups;
}

function shotShades(session: PlayerSession, owner: PlayerIndex, onlyMine: boolean): EdgeShade[] {
  const groups = shotsOn(session, owner, onlyMine);
  const out: EdgeShade[] = [];
  const multi = session.playerCount > 2;
  const lastMineIdx = groups.map((g) => g.by).lastIndexOf(session.state.me);
  groups.forEach((g, i) => {
    const last = i === lastMineIdx;
    const color = multi && g.by !== session.state.me ? playerColor(g.by) : undefined;
    for (const { edge, exit } of g.shots) {
      if (sameEdge(edge, exit)) {
        out.push({ edge, kind: last ? 'both-last' : 'in', color }, ...(last ? [] : [{ edge, kind: 'out' as const, color }]));
        continue;
      }
      out.push({ edge, kind: last ? 'in-last' : 'in', color });
      out.push({ edge: exit, kind: last ? 'out-last' : 'out', color });
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

/** Adversaire agrandi dans Tirer / Carnet (à deux : toujours l'adversaire). */
function focusOf(app: App, session: PlayerSession): PlayerIndex | null {
  if (session.playerCount === 2) return session.opp;
  const t = app.ui.target;
  return t !== null && t !== session.state.me && t < session.playerCount ? t : null;
}

// ---------- barre du haut ----------

export function topBar(app: App, ctx: GameCtx, session: PlayerSession): HTMLElement {
  const st = session.state;
  const phase = session.phase;
  let status: string;
  if (phase === 'lobby') status = 'Salon';
  else if (phase === 'review') status = 'Jeu de pièces';
  else if (phase === 'setup') status = 'Placement';
  else if (phase === 'waiting') status = 'En attente';
  else if (phase === 'over') status = 'Partie terminée';
  else if (st.pending) status = 'Coup envoyé…';
  else if (session.amEliminated) status = 'Éliminé · tu regardes';
  else status = session.isMyTurn ? 'À toi de jouer' : `Au tour de ${session.nameOf(session.attackerOf(st.log.length) ?? session.opp)}`;
  const online = ctx.mode === 'online';
  const connected = session.connected;
  const players = Array.from({ length: Math.max(st.players.length, 1) }, (_, i) => i as PlayerIndex);
  return h(
    'header',
    { class: 'topbar game-top' },
    h('button', { class: 'icon-btn', 'aria-label': 'Menu', onclick: () => app.openMenu() }, icon(ICONS.home)),
    h(
      'div',
      { class: 'top-center' },
      h('div', { class: 'players' }, ...players.map((i) => playerChip(session, i, { small: true, name: st.players.length <= 2 }))),
      h('div', { class: `turn ${session.isMyTurn && !st.pending ? 'turn-me' : ''}`, 'aria-live': 'polite' }, status),
    ),
    online
      ? h(
          'button',
          {
            class: `icon-btn conn ${connected ? 'conn-ok' : 'conn-off'}`,
            'aria-label': connected ? 'Connecté' : 'Hors ligne : reconnecter',
            onclick: () => (connected ? toast(st.me === 0 ? 'Connecté aux invités' : 'Connecté à l’hôte', 'ok') : app.reconnect()),
          },
          icon(connected ? ICONS.wifi : ICONS.wifiOff),
        )
      : h('span', { class: 'icon-btn placeholder', 'aria-hidden': 'true' }),
  );
}

/** Bandeau fixe (hors défilement) : à qui de jouer, visible depuis tous les onglets. */
const ACTIVITY_TEXT: Record<string, { ic: string; text: string }> = {
  shoot: { ic: ICONS.laser, text: 'étudie les grilles' },
  aim: { ic: ICONS.laser, text: 'règle son tir' },
  notes: { ic: ICONS.notes, text: 'consulte son carnet' },
  spells: { ic: ICONS.wand, text: 'feuillette ses sorts' },
  'spell-pick': { ic: ICONS.wand, text: 'prépare un sort' },
  board: { ic: ICONS.board, text: 'inspecte son plateau' },
};

function turnBanner(ctx: GameCtx, session: PlayerSession): HTMLElement {
  const wrap = h('div', { class: 'turn-wrap' }, turnBannerText(session));
  const cur = session.attackerOf(session.state.log.length);
  const a = cur !== null && cur !== session.state.me ? session.activities[cur] : undefined;
  const act = ctx.mode === 'online' && session.connected && a ? ACTIVITY_TEXT[a] : undefined;
  if (act && cur !== null) {
    wrap.append(
      h(
        'div',
        { class: `activity act-${a}`, role: 'status', 'aria-live': 'polite' },
        h('span', { class: 'act-icon' }, icon(act.ic)),
        h('span', { class: 'act-text' }, `${session.nameOf(cur)} ${act.text}`),
        h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      ),
    );
  }
  return wrap;
}

function turnBannerText(session: PlayerSession): HTMLElement {
  const st = session.state;
  const mine = session.isMyTurn && !st.pending;
  const cur = session.attackerOf(st.log.length);
  let text: string;
  if (st.pending) text = 'Coup envoyé, en attente du résultat…';
  else if (mine) text = 'À toi de jouer !';
  else if (session.amEliminated) text = `Tu es éliminé · tour de ${cur === null ? '…' : session.nameOf(cur)}`;
  else text = `Tour de ${cur === null ? '…' : session.nameOf(cur)}`;
  const chip = cur !== null && !mine && !st.pending ? playerChip(session, cur, { name: false, small: true }) : null;
  return h('div', { class: `turn-banner${mine ? ' mine' : ''}`, role: 'status', 'aria-live': 'polite' }, chip, text);
}

export function offlineBanner(app: App, ctx: GameCtx, session: PlayerSession): HTMLElement | null {
  if (ctx.mode !== 'online') return null;
  const st = session.state;
  if (!session.connected) {
    return h(
      'div',
      { class: 'banner banner-warn', role: 'alert' },
      h('span', null, st.me === 0 ? 'Aucun invité connecté.' : 'Connexion perdue avec l’hôte.'),
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => app.reconnect() }, 'Reconnecter'),
    );
  }
  const offline = session.opponents.filter((i) => !session.isOnline(i) && session.isAlive(i));
  if (!offline.length) return null;
  const names = offline.map((i) => session.nameOf(i)).join(', ');
  return h(
    'div',
    { class: 'banner banner-info', role: 'status' },
    h('span', null, `${names} ${offline.length > 1 ? 'sont hors ligne' : 'est hors ligne'}.`),
    st.me === 0 ? h('button', { class: 'btn btn-sm btn-secondary', onclick: () => app.reconnect() }, 'Code de reconnexion') : null,
  );
}

/** Hôte : un invité a refusé le jeu, ou n'a pas encore répondu. */
function setStatusBanner(session: PlayerSession): HTMLElement | null {
  const st = session.state;
  if (st.me !== 0 || st.mode !== 'online') return null;
  const refused = session.opponents.filter((i) => st.players[i].refused);
  if (refused.length) {
    return h(
      'div',
      { class: 'banner banner-warn', role: 'alert' },
      h('span', null, `${refused.map((i) => session.nameOf(i)).join(', ')} ${refused.length > 1 ? 'ont' : 'a'} refusé ce jeu de pièces.`),
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => proposeOtherSet(session) }, 'Proposer un autre jeu'),
    );
  }
  const pending = session.opponents.filter((i) => st.players[i].setHash !== session.mySetHash && st.players[i].name);
  if (pending.length) {
    return h('div', { class: 'banner banner-info' }, h('span', null, `${pending.map((i) => session.nameOf(i)).join(', ')} ${pending.length > 1 ? 'regardent' : 'regarde'} le jeu de pièces proposé…`));
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
  const v = await modal('Proposer un autre jeu', [h('p', { class: 'muted small' }, 'Une nouvelle partie démarre avec ce jeu ; les autres joueurs devront l’accepter.'), list], [
    { label: 'Annuler', value: 'no' },
    { label: 'OK', value: 'ok', kind: 'primary' },
  ]);
  const set = sets.find((s) => s.id === chosen);
  if (v === 'ok' && set) session.startNewGame(set);
}

// ---------- salon ----------

export function renderLobby(app: App, ctx: GameCtx, session: PlayerSession): HTMLElement {
  const st = session.state;
  const host = st.me === 0;
  const players = st.players.map((_, i) => i as PlayerIndex);
  const canLaunch = host && st.players.length >= 2 && session.opponents.every((i) => session.isOnline(i));
  const list = h(
    'ul',
    { class: 'lobby-list' },
    ...players.map((i) => {
      const online = session.isOnline(i);
      return h(
        'li',
        { class: online ? '' : 'is-off' },
        playerChip(session, i),
        h('span', { class: 'grow' }),
        i === 0 ? h('span', { class: 'tag tag-muted' }, 'hôte') : null,
        i !== 0 ? h('span', { class: `tag ${online ? 'tag-ok' : 'tag-bad'}` }, online ? 'connecté' : 'hors ligne') : null,
        host && i !== 0 && !online
          ? h(
              'button',
              {
                class: 'btn btn-ghost btn-sm danger-text',
                onclick: async () => {
                  if (await confirmBox('Retirer ce joueur ?', `${session.nameOf(i)} sera retiré du salon. Les joueurs suivants avancent d’une place.`, 'Retirer', true)) session.removeSlot(i);
                },
              },
              'Retirer',
            )
          : null,
      );
    }),
  );
  const free = 4 - st.players.length;
  return h(
    'div',
    { class: 'screen game' },
    topBar(app, ctx, session),
    offlineBanner(app, ctx, session),
    h(
      'main',
      { class: 'scroll' },
      h('h2', { class: 'screen-title' }, 'Salon', h('span', { class: 'count' }, `${st.players.length}/4 joueurs`)),
      h('p', { class: 'muted small' }, host ? 'Invite jusqu’à 3 joueurs : un code par joueur. Lance la partie quand tout le monde est là (2 joueurs au moins). Chacun joue pour soi.' : `En attente que ${session.nameOf(0)} lance la partie. Chacun joue pour soi : le dernier à flot gagne.`),
      list,
      host
        ? h(
            'div',
            { class: 'btn-row' },
            h('button', { class: 'btn btn-secondary', disabled: free <= 0, onclick: () => app.invite() }, icon(ICONS.plus), free > 0 ? 'Inviter un joueur' : 'Complet'),
          )
        : h('div', { class: 'waiting' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('p', null, 'L’hôte peut encore inviter d’autres joueurs…')),
      h('p', { class: 'muted small' }, `Jeu de pièces : ${st.pieceSet?.name ?? st.proposedSet?.name ?? '…'}${st.spellCfg.enabled ? ' · sorts activés' : ''}.`),
    ),
    host
      ? h(
          'footer',
          { class: 'actionbar' },
          h(
            'button',
            {
              class: 'btn btn-primary btn-lg',
              disabled: !canLaunch,
              onclick: () => {
                if (!session.launch()) toast('Il faut au moins 2 joueurs, tous connectés.', 'warn');
              },
            },
            icon(ICONS.play),
            st.players.length < 2 ? 'En attente d’un joueur…' : canLaunch ? `Lancer la partie à ${st.players.length}` : 'Un joueur est hors ligne',
          ),
        )
      : null,
  );
}

// ---------- acceptation du jeu (invité) ----------

export function renderReview(app: App, ctx: GameCtx, session: PlayerSession): HTMLElement {
  const st = session.state;
  const set = st.proposedSet;
  const refused = set && st.refusedHash !== null;
  let body: HTMLElement;
  if (!set) {
    body = h('div', { class: 'waiting' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('p', null, `En attente du jeu de pièces de ${session.nameOf(0)}…`));
  } else {
    const { pieces, cells } = setStats(set);
    body = h(
      'div',
      { class: 'tab-content' },
      h('h2', { class: 'screen-title' }, `Jeu proposé : ${set.name}`, h('span', { class: 'count' }, `${pieces} pièces · ${cells} cases`)),
      h('p', { class: 'muted small' }, `${session.nameOf(0)} propose de jouer avec ces pièces. Chacun aura les mêmes.`),
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
      h('p', { class: 'muted small' }, `Jeu « ${cat.set.name} ». ${session.playerCount > 2 ? 'Tes adversaires ne verront' : 'Ton adversaire ne verra'} jamais ce placement.`),
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
  const st = session.state;
  const board = createBoard({ catalog: cat, gutter: 'labels', label: 'Mon plateau', pieces: st.placement, description: describePieces(st.placement, cat) });
  const waitingFor = session.opponents.filter((i) => !st.players[i].ready);
  return h(
    'div',
    { class: 'screen game' },
    topBar(app, ctx, session),
    offlineBanner(app, ctx, session),
    setStatusBanner(session),
    h(
      'main',
      { class: 'scroll' },
      h('div', { class: 'waiting' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('p', null, waitingFor.length ? `En attente de ${waitingFor.map((i) => session.nameOf(i)).join(', ')}…` : 'Tirage au sort du premier joueur…')),
      session.playerCount > 2
        ? h('ul', { class: 'lobby-list' }, ...session.opponents.map((i) => h('li', null, playerChip(session, i), h('span', { class: 'grow' }), h('span', { class: `tag ${st.players[i].ready ? 'tag-ok' : 'tag-muted'}` }, st.players[i].ready ? 'prêt' : 'place ses pièces'))))
        : null,
      h('p', { class: 'muted small center' }, 'La partie commence dès que tout le monde est prêt. Le premier joueur est tiré au sort.'),
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

/** Vignette d'une grille adverse (vue d'ensemble à 3 ou 4 joueurs). */
function boardCard(app: App, session: PlayerSession, owner: PlayerIndex, mode: 'shoot' | 'notes'): HTMLElement {
  const cat = session.catalog!;
  const sunk = sunkAsPlacements(session.sunkClaimsOf(owner), cat);
  const notes = session.notesFor(owner);
  const guesses: BoardPiece[] = mode === 'notes' ? notes.guesses.filter((g) => !sunk.ids.has(g.pieceId) && pieceDef(g.pieceId, cat)).map((g) => ({ ...g, style: 'guess' })) : [];
  const dead = !session.isAlive(owner);
  const forced = session.forcedTarget;
  const board = createBoard({
    catalog: cat,
    gutter: 'labels',
    label: `Grille de ${session.nameOf(owner)}`,
    className: 'mini-board',
    pieces: [...sunk.placements, ...guesses],
    marks: mode === 'notes' ? notes.marks : {},
    edgeShades: shotShades(session, owner, mode === 'notes'),
  });
  const total = session.piecesOf(owner).length;
  const info = dead ? 'éliminé' : `${sunk.placements.length}/${total} coulée${sunk.placements.length > 1 ? 's' : ''}`;
  return h(
    'button',
    {
      class: `board-card${dead ? ' is-dead' : ''}${forced === owner ? ' is-forced' : ''}`,
      'aria-label': `${session.nameOf(owner)} : ${info}. Toucher pour agrandir.`,
      onclick: () => app.setUi({ target: owner, selectedPiece: null }),
    },
    h('div', { class: 'board-card-head' }, playerChip(session, owner), h('span', { class: `tag ${dead ? 'tag-bad' : 'tag-muted'}` }, info)),
    board.root,
    forced === owner ? h('span', { class: 'tag tag-ok forced-tag' }, 'Diversion : cible imposée') : null,
  );
}

function overview(app: App, session: PlayerSession, mode: 'shoot' | 'notes'): HTMLElement {
  return h('div', { class: `boards-grid n${session.opponents.length}` }, ...session.opponents.map((i) => boardCard(app, session, i, mode)));
}

function backToAll(app: App, session: PlayerSession, target: PlayerIndex): HTMLElement {
  return h(
    'div',
    { class: 'focus-head' },
    h('button', { class: 'btn btn-ghost btn-sm', onclick: () => app.setUi({ target: null, selectedPiece: null }) }, icon(ICONS.chevronLeft), 'Toutes les grilles'),
    h('span', { class: 'focus-title' }, 'Grille de ', playerChip(session, target)),
  );
}

function shootTab(app: App, ctx: GameCtx, session: PlayerSession): HTMLElement {
  const st = session.state;
  const cat = session.catalog!;
  const multi = session.playerCount > 2;
  const target = focusOf(app, session);
  const parts: (HTMLElement | null)[] = [];
  const myTurn = session.isMyTurn && !st.pending;

  if (st.pending) {
    parts.push(
      h(
        'div',
        { class: 'card card-busy' },
        h('span', { class: 'spinner', 'aria-hidden': 'true' }),
        h('span', null, st.pending.action.kind === 'shot' ? `Tir ${edgeLabel(st.pending.action.edge)} envoyé à ${session.nameOf(st.pending.target)}, en attente du résultat…` : st.pending.action.kind === 'spell' ? `Sort lancé sur ${session.nameOf(st.pending.target)}, en attente du résultat…` : 'Déclaration envoyée, vérification…'),
        ctx.mode === 'online' ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => session.resendPending() }, 'Renvoyer') : null,
      ),
    );
  } else if (!session.isMyTurn) {
    const cur = session.attackerOf(st.log.length);
    if (ctx.mode === 'local') {
      parts.push(h('button', { class: 'btn btn-primary btn-lg handoff-btn', onclick: () => app.handoff((1 - st.me) as PlayerIndex) }, icon(ICONS.phone), `Passer le téléphone à ${session.nameOf(session.opp)}`));
    } else if (session.amEliminated) {
      parts.push(h('div', { class: 'card card-wait' }, h('span', null, 'Tu es éliminé : tu suis la partie jusqu’au bout.')));
    } else {
      parts.push(h('div', { class: 'card card-wait' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', null, `${cur === null ? 'L’adversaire' : session.nameOf(cur)} réfléchit…`)));
    }
  }

  const lastMine = [...st.log].reverse().find((e) => e.by === st.me);
  if (lastMine) parts.push(h('div', { class: 'card card-result' }, h('div', { class: 'card-label' }, multi && lastMine.target !== st.me ? `Ton dernier coup (sur ${session.nameOf(lastMine.target)})` : 'Ton dernier coup'), turnSummary(lastMine, cat, session)));

  if (multi && target === null) {
    const forced = session.forcedTarget;
    parts.push(h('p', { class: 'muted small' }, myTurn ? (forced !== null ? `Diversion : tu dois viser ${session.nameOf(forced)}. Touche sa grille.` : 'Touche la grille d’un adversaire pour l’agrandir et choisir ta cible.') : 'Toutes les grilles adverses, avec les tirs de tout le monde. Touche une grille pour l’agrandir.'));
    parts.push(overview(app, session, 'shoot'));
  } else if (target !== null) {
    parts.push(...focusedShoot(app, ctx, session, target, lastMine));
  }

  const lastTheirs = [...st.log].reverse().find((e) => e.target === st.me && e.by !== st.me);
  if (lastTheirs) {
    parts.push(
      h(
        'button',
        { class: 'card card-incoming', onclick: () => app.setUi({ tab: 'board', viewTurn: lastTheirs.n }) },
        h('div', { class: 'card-label' }, `Dernier coup reçu, de ${session.nameOf(lastTheirs.by)}`),
        turnSummary(lastTheirs, cat, session),
        h('span', { class: 'card-link' }, icon(ICONS.eye), 'Voir sur mon plateau'),
      ),
    );
  }

  const hist = [...st.log].reverse();
  parts.push(h('section', { class: 'history' }, h('h3', null, 'Historique'), hist.length === 0 ? h('p', { class: 'muted small' }, 'Aucun coup pour l’instant.') : historyList(hist, session, cat)));
  return h('div', { class: 'tab-content' }, ...parts);
}

/** Grille adverse agrandie : viser et tirer. */
function focusedShoot(app: App, ctx: GameCtx, session: PlayerSession, target: PlayerIndex, lastMine: TurnEntry | undefined): (HTMLElement | null)[] {
  const st = session.state;
  const cat = session.catalog!;
  const multi = session.playerCount > 2;
  const blocked = session.targetBlocked(target);
  const canAct = session.isMyTurn && !st.pending && !blocked;
  const sunk = sunkAsPlacements(session.sunkClaimsOf(target), cat);
  const notes = session.notesFor(target);
  const guesses: BoardPiece[] = notes.guesses.filter((g) => !sunk.ids.has(g.pieceId)).map((g) => ({ ...g, style: 'guess' }));
  const selected = canAct ? app.ui.selectedEdge : null;
  const parts: (HTMLElement | null)[] = [];

  const fire = () => {
    if (selected && session.shoot(selected, target)) app.setUi({ selectedEdge: null });
  };

  const lastOnThis = lastMine && lastMine.target === target && lastMine.action.kind === 'spell' ? lastMine : null;
  const board = createBoard({
    catalog: cat,
    gutter: 'buttons',
    label: canAct ? `Grille de ${session.nameOf(target)} : touche un bord pour viser. Au clavier : flèches pour choisir, Entrée pour tirer.` : `Grille de ${session.nameOf(target)}`,
    className: 'target',
    pieces: [...sunk.placements, ...guesses],
    marks: notes.marks,
    edgeShades: shotShades(session, target, false),
    selectedEdge: selected,
    overlays: lastOnThis ? spellOverlays(lastOnThis, st.selfLog[String(lastOnThis.n)]) : [],
  });
  board.svg.setAttribute('tabindex', '0');
  board.svg.addEventListener('click', (e) => {
    const cell = board.rawCellAt(e.clientX, e.clientY);
    const edge = cell && edgeAt(cell);
    if (!edge) return;
    if (!canAct) {
      toast(st.pending ? 'Coup en cours…' : blocked && session.isMyTurn ? blocked : 'Ce n’est pas ton tour', 'info', 1800);
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

  if (multi) parts.push(backToAll(app, session, target));
  if (multi && !session.isAlive(target)) parts.push(h('p', { class: 'notice' }, `${session.nameOf(target)} est éliminé : sa grille reste visible, mais on ne peut plus la viser.`));
  else if (multi && blocked && session.isMyTurn && !st.pending) parts.push(h('p', { class: 'notice' }, blocked));
  if (multi) parts.push(h('p', { class: 'muted small' }, 'Dans la marge : les tirs de tout le monde (point = entrée, rond = sortie, à la couleur du tireur ; en rouge : ton dernier tir).'));
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
          h('button', { class: 'btn btn-primary btn-fire', disabled: !selected, onclick: fire }, multi ? `Tirer sur ${session.nameOf(target)}` : 'Tirer'),
        ),
      ),
      h('button', { class: 'btn btn-secondary', onclick: () => app.setUi({ tab: 'notes', tool: 'shapes', selectedPiece: null, target: multi ? target : null }) }, icon(ICONS.flag), 'Déclarer une pièce (au lieu de tirer)'),
    );
  }
  void ctx;
  return parts;
}

function notesTab(app: App, session: PlayerSession): HTMLElement {
  const st = session.state;
  const cat = session.catalog!;
  const multi = session.playerCount > 2;
  const target = focusOf(app, session);
  if (target === null) {
    return h(
      'div',
      { class: 'tab-content' },
      h('p', { class: 'muted small' }, 'Ton carnet, grille par grille : seulement tes tirs et tes notes. Touche une grille pour l’ouvrir.'),
      overview(app, session, 'notes'),
    );
  }
  const notes = session.notesFor(target);
  const tool = app.ui.tool;
  const sunk = sunkAsPlacements(session.sunkClaimsOf(target), cat);
  const guesses = notes.guesses.filter((g) => !sunk.ids.has(g.pieceId) && pieceDef(g.pieceId, cat));
  const canAct = session.isMyTurn && !st.pending && !session.targetBlocked(target);
  const setNotes = (n: typeof notes) => session.setNotes(target, n);

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
    const trayIds = session.piecesOf(target).map((p) => p.id).filter((id) => !sunk.ids.has(id));
    boardEl = createPieceEditor({
      key: `notes-${st.me}-${target}-${session.mySetHash}`,
      catalog: cat,
      board: { gutter: 'labels', label: `Carnet sur ${session.nameOf(target)} : formes supposées`, marks: notes.marks, edgeShades: shotShades(session, target, true) },
      placements: guesses,
      fixed: sunk.placements,
      editableStyle: 'guess',
      trayIds,
      trayTitle: `Pièces de ${session.nameOf(target)}`,
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
      onCommit: (ps) => setNotes({ ...notes, guesses: ps as GuessShape[] }),
      onSelect: (id) => app.setUi({ selectedPiece: id }),
      setDragging: (d) => app.setDragging(d),
      extraActions: (id, placed) => {
        if (!placed) return [];
        const g = guesses.find((x) => x.pieceId === id)!;
        return [h('button', { class: 'btn btn-primary btn-sm', disabled: !canAct, title: canAct ? undefined : (session.targetBlocked(target) ?? 'Seulement à ton tour'), onclick: () => declare(app, session, g, target) }, icon(ICONS.flag), 'Déclarer')];
      },
    });
  } else {
    const board = createBoard({
      catalog: cat,
      gutter: 'labels',
      label: `Carnet sur ${session.nameOf(target)} : touche une case pour la marquer`,
      className: 'notes-board',
      pieces: [...sunk.placements, ...guesses.map((g) => ({ ...g, style: 'guess' as const }))],
      marks: notes.marks,
      edgeShades: shotShades(session, target, true),
    });
    board.svg.addEventListener('click', (e) => {
      const cell = board.rawCellAt(e.clientX, e.clientY);
      if (!cell || cell.r < 0 || cell.c < 0 || cell.r >= GRID_SIZE || cell.c >= GRID_SIZE) return;
      const k = cellKey(cell);
      const marks = { ...notes.marks };
      if (tool === 'erase') {
        delete marks[k];
        setNotes({ marks, guesses: notes.guesses.filter((g) => !placementParts(g, cat).some((c) => cellKey(c) === k)) });
      } else {
        const m = tool as NoteMark;
        if (marks[k] === m) delete marks[k];
        else marks[k] = m;
        setNotes({ ...notes, marks });
      }
    });
    boardEl = board.root;
  }

  const legend = h(
    'section',
    { class: 'legend' },
    h('h3', null, multi ? `Pièces de ${session.nameOf(target)}` : 'Pièces adverses'),
    h(
      'ul',
      { class: 'legend-list' },
      ...session.piecesOf(target).map((p) => {
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
    multi ? backToAll(app, session, target) : null,
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
          if (await confirmBox('Effacer le carnet ?', `Toutes tes marques et formes supposées sur ${session.nameOf(target)} seront effacées.`, 'Effacer', true)) setNotes({ marks: {}, guesses: [] });
        },
      },
      icon(ICONS.trash),
      'Effacer ce carnet',
    ),
  );
}

async function declare(app: App, session: PlayerSession, g: GuessShape, target: PlayerIndex): Promise<void> {
  const cat = session.catalog!;
  const def = pieceDef(g.pieceId, cat)!;
  const cells: Part[] = placementParts(g, cat);
  const claim: Claim = { color: def.color, shape: def.shape, cells };
  const who = session.playerCount > 2 ? ` chez ${session.nameOf(target)}` : '';
  const ok = await confirmBox('Déclarer cette pièce ?', `${claimText(claim, cat)}${who}. ${claimRuleText()}`, 'Déclarer');
  if (!ok) return;
  if (session.claim(claim, target)) app.setUi({ selectedPiece: null, tab: 'shoot' });
  else toast(session.targetBlocked(target) ?? 'Impossible maintenant (ce n’est pas ton tour).', 'warn');
}

function boardTab(app: App, session: PlayerSession): HTMLElement {
  const st = session.state;
  const cat = session.catalog!;
  const sunk = session.mySunk;
  const received = st.log.filter((e) => e.target === st.me && e.by !== st.me);
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
  const multi = session.playerCount > 2;
  return h(
    'div',
    { class: 'tab-content' },
    h('h2', { class: 'screen-title' }, 'Mon plateau', h('span', { class: 'count' }, `${remaining}/${st.placement.length} pièces à flot`)),
    viewed
      ? h('div', { class: 'card card-result' }, h('div', { class: 'card-label' }, `Coup reçu n°${received.indexOf(viewed) + 1}, de ${session.nameOf(viewed.by)}`), turnSummary(viewed, cat, session))
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
                h(
                  'button',
                  { class: 'history-btn', 'aria-pressed': e.n === viewN ? 'true' : 'false', onclick: () => app.setUi({ viewTurn: e.n }) },
                  h('span', { class: 'who' }, `n°${received.indexOf(e) + 1}`),
                  multi ? playerChip(session, e.by, { name: false, small: true }) : null,
                  turnSummary(e, cat, session),
                ),
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
  const winner = session.winner!;
  const won = winner === st.me;
  const multi = session.playerCount > 2;
  const mine = st.log.filter((e) => e.by === st.me);
  const shots = mine.filter((e) => e.action.kind === 'shot').length;
  const claimsOk = mine.filter((e) => e.result.kind === 'claim' && e.result.ok).length;
  const claimsBad = mine.filter((e) => e.result.kind === 'claim' && !e.result.ok).length;
  const board = createBoard({ catalog: cat, gutter: 'labels', label: 'Mon plateau', pieces: st.placement.map((p) => ({ ...p, style: session.mySunk.has(p.pieceId) ? 'sunk' : 'normal' })) });
  const winnerName = ctx.mode === 'local' || multi ? session.nameOf(winner) : null;
  const ranking = session.ranking;
  const hostHere = ctx.mode !== 'online' || st.me === 0;
  const subtitle = multi
    ? won
      ? 'Tu es le dernier à flot.'
      : `${session.nameOf(winner)} est le dernier à flot.`
    : won
      ? 'Toutes les pièces adverses sont coulées.'
      : `${session.nameOf(winner)} a coulé toutes ${ctx.mode === 'local' ? 'les pièces de ' + st.myName : 'tes pièces'}.`;
  return h(
    'div',
    { class: 'screen game over' },
    h(
      'main',
      { class: 'scroll' },
      h(
        'div',
        { class: `result-hero ${won ? 'won' : 'lost'}` },
        h('h1', null, winnerName && !won ? `${winnerName} gagne` : won ? 'Victoire' : 'Défaite'),
        h('p', null, subtitle),
      ),
      multi
        ? h(
            'ol',
            { class: 'ranking' },
            ...ranking.map((i, k) => {
              const t = session.eliminatedTurn(i);
              return h('li', { class: i === st.me ? 'is-me' : '' }, h('span', { class: 'rank' }, `${k + 1}.`), playerChip(session, i), h('span', { class: 'grow' }), h('span', { class: 'muted small' }, t === null ? 'vainqueur' : `éliminé au coup ${t + 1}`));
            }),
          )
        : null,
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
      ctx.mode === 'online' && hostHere && multi
        ? h('button', { class: 'btn btn-ghost', onclick: () => app.rematch(true) }, icon(ICONS.users), 'Revanche en changeant les joueurs (retour au salon)')
        : null,
      ctx.mode === 'online' && !hostHere ? h('p', { class: 'muted small center' }, `Seul ${session.nameOf(0)} (l’hôte) peut lancer la revanche. Reste connecté.`) : null,
    ),
    h(
      'footer',
      { class: 'actionbar two' },
      h('button', { class: 'btn btn-secondary btn-lg', onclick: () => app.goHome() }, icon(ICONS.home), 'Accueil'),
      h(
        'button',
        {
          class: 'btn btn-primary btn-lg',
          disabled: !hostHere,
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
