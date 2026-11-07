/**
 * Messages échangés entre les appareils (2 à 4 joueurs), et leur validation.
 *
 * Confidentialité : le placement d'un joueur ne quitte JAMAIS son appareil.
 * Seuls transitent : le jeu de pièces de la partie (choisi par l'hôte), les actions
 * (tir, déclaration, sort) et leurs résultats publics (bord de sortie, couleurs, coulée
 * oui/non, élimination). Un sort « privé » n'est détaillé qu'au lanceur et à la cible :
 * les autres reçoivent une version masquée (`spell: 'hidden'`).
 *
 * Topologie : chaque invité est relié à l'hôte, qui relaie (voir net/hub.ts). Les
 * messages ci-dessous sont la charge utile ; le hub ajoute l'expéditeur.
 *
 * Tout message reçu est considéré comme non fiable : forme vérifiée champ par champ,
 * clés de dictionnaires vérifiées avec hasOwn (refus de "__proto__", "constructor"…).
 */

import { COLORS, COLOR_IDS } from '../config/pieces';
import { RULES } from '../config/rules';
import { catalogFits } from '../engine/board';
import { CORNERS, GRID_SIZE, isValidEdge, type Edge, type Part } from '../engine/geometry';
import { LIMITS, hasOwn, hashString, pieceSetErrors, type PieceSet } from '../engine/pieces';
import { DIAGS, HALVES, SPELL_IDS, sanitizeSpellConfig, spellDef, type SpellConfig } from '../engine/spells';
import type { Claim } from '../engine/claim';
import { MAX_PLAYERS, type PlayerIndex } from '../engine/turns';

export type { PlayerIndex };

export const PROTOCOL_VERSION = 4;

/**
 * Empreinte de version : protocole + règles + palette + version du moteur.
 * Deux téléphones dont l'empreinte diffère ne peuvent pas jouer ensemble.
 * (Le jeu de pièces a sa propre empreinte, comparée lors de l'acceptation.)
 */
export const ENGINE_VERSION = 4;
export function appFingerprint(): string {
  return hashString(JSON.stringify({ p: PROTOCOL_VERSION, e: ENGINE_VERSION, rules: RULES, colors: COLORS, players: MAX_PLAYERS, spells: SPELL_IDS }));
}

/**
 * Sort lancé. `spell: 'self'` = sort secret qui n'agit que sur le plateau du lanceur.
 * `spell: 'hidden'` = sort privé masqué (version reçue par les joueurs non concernés).
 */
export interface SpellAction {
  kind: 'spell';
  spell: string;
  r?: number;
  c?: number;
  axis?: 'row' | 'col';
  index?: number;
  edges?: Edge[];
  color?: string;
  shape?: string;
  /** Résurrection : cases de la pièce qui revient en jeu. */
  cells?: Part[];
  opt?: string;
  /** Relais, Diversion : joueur désigné. */
  who?: PlayerIndex;
}

export interface SpellResult {
  kind: 'spell';
  spell: string;
  occ?: boolean;
  count?: number;
  colors?: string[];
  r?: number;
  c?: number;
  /** Loupe : état de chaque case du bloc. */
  cells?: { r: number; c: number; color: string | null }[];
  /** Histogramme : cases occupées par ligne (ou colonne). */
  counts?: number[];
  shots?: { exit: Edge; colors: string[] }[];
  /** Renfort : pièce ajoutée (null = refusée, sans effet). */
  piece?: { id: string; shape: string; color: string } | null;
  /** Vol de sort, Sabotage : sort pris ou détruit (null = réserve vide). */
  got?: string | null;
}

/** Ce que fait un joueur en ce moment (information éphémère, jamais sauvegardée). */
export type Activity = 'shoot' | 'aim' | 'notes' | 'spells' | 'spell-pick' | 'board';
export const ACTIVITIES: readonly string[] = ['shoot', 'aim', 'notes', 'spells', 'spell-pick', 'board'];

export type Action = { kind: 'shot'; edge: Edge } | { kind: 'claim'; claim: Claim } | SpellAction;

export type Result =
  | { kind: 'shot'; exit: Edge; colors: string[] }
  | { kind: 'claim'; ok: boolean; eliminated?: boolean }
  | SpellResult;

/** Partie publique d'un tour (ce que les joueurs concernés connaissent). */
export interface PublicTurn {
  n: number;
  by: PlayerIndex;
  /** Joueur visé ; le lanceur lui-même pour un sort secret ou un sort sur sa grille / l'ordre. */
  target: PlayerIndex;
  action: Action;
  result: Result;
}

export interface PendingAction {
  n: number;
  target: PlayerIndex;
  action: Action;
}

export interface SyncMessage {
  t: 'sync';
  v: number;
  fp: string;
  gameId: string;
  me: PlayerIndex;
  name: string;
  ready: boolean;
  firstPlayer: PlayerIndex | null;
  /** Tours que le destinataire n'a pas encore (d'après son dernier sync), déjà masqués pour lui. */
  log: PublicTurn[];
  /** Longueur totale du journal de l'expéditeur. */
  logLen?: number;
  pending: PendingAction | null;
  /** Jeu de pièces de la partie (envoyé par l'hôte). */
  set: PieceSet | null;
  /** Empreinte du jeu que l'expéditeur a accepté / utilise (null = aucun). */
  setHash: string | null;
  /** Demande à l'autre de renvoyer son propre sync. */
  ask?: boolean;
  /** Réglages des sorts de la partie (envoyés par l'hôte). */
  cfg?: SpellConfig | null;
  /** Hôte : noms des joueurs (l'indice est la place dans la partie). */
  players?: string[] | null;
  /** Hôte : la partie a été lancée (le salon est fermé). */
  launched?: boolean;
}

export type Message =
  | SyncMessage
  | { t: 'ready' }
  | { t: 'activity'; a: Activity }
  | { t: 'start'; firstPlayer: PlayerIndex }
  | { t: 'action'; n: number; target: PlayerIndex; action: Action }
  | { t: 'turn'; turn: PublicTurn }
  | { t: 'newgame'; gameId: string; set: PieceSet | null; cfg?: SpellConfig | null; lobby?: boolean }
  | { t: 'set-accept'; hash: string }
  | { t: 'set-refuse'; hash: string }
  /** Hôte : liste des joueurs du salon (noms) et état du lancement. */
  | { t: 'roster'; players: string[]; launched: boolean }
  /** Hôte : qui est connecté en ce moment. */
  | { t: 'presence'; online: boolean[] }
  /** Hôte, dans le salon : nouvelle place d'un invité. */
  | { t: 'assign'; you: PlayerIndex };

export const MAX_TURNS = 5000;
const isInt = (x: unknown, min: number, max: number): x is number => Number.isInteger(x) && (x as number) >= min && (x as number) <= max;
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
export const isPlayer = (x: unknown): x is PlayerIndex => Number.isInteger(x) && (x as number) >= 0 && (x as number) < MAX_PLAYERS;
const isShortText = (x: unknown, max: number): x is string => typeof x === 'string' && x.length > 0 && x.length <= max;
const isHash = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{16}$/.test(x);
const isColor = (x: unknown): x is string => typeof x === 'string' && hasOwn(COLORS, x);
const cleanName = (x: unknown) => (typeof x === 'string' ? x.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40) : '');

export function isValidPart(p: unknown): p is Part {
  return isObj(p) && isInt(p.r, 0, GRID_SIZE - 1) && isInt(p.c, 0, GRID_SIZE - 1) && (p.corner === undefined || CORNERS.includes(p.corner as never));
}

export function isValidClaim(c: unknown): c is Claim {
  return (
    isObj(c) &&
    isColor(c.color) &&
    isShortText(c.shape, LIMITS.maxId) &&
    Array.isArray(c.cells) &&
    c.cells.length > 0 &&
    c.cells.length <= LIMITS.maxShapeParts &&
    c.cells.every(isValidPart)
  );
}

export function isValidSpellAction(a: Record<string, unknown>): boolean {
  if (typeof a.spell !== 'string') return false;
  if (a.spell === 'self' || a.spell === 'hidden') return true;
  const def = spellDef(a.spell);
  if (!def || def.target === 'self') return false;
  switch (def.param) {
    case 'none':
      return true;
    case 'cell':
      return isInt(a.r, 0, GRID_SIZE - 1) && isInt(a.c, 0, GRID_SIZE - 1);
    case 'line':
      return (a.axis === 'row' || a.axis === 'col') && isInt(a.index, 0, GRID_SIZE - 1);
    case 'edge2':
      return Array.isArray(a.edges) && a.edges.length === 2 && a.edges.every((e) => isValidEdge(e));
    case 'run': {
      if (!Array.isArray(a.edges) || a.edges.length !== (def.count ?? 3) || !a.edges.every((e) => isValidEdge(e))) return false;
      const edges = a.edges as Edge[];
      return edges.every((e, i) => e.side === edges[0].side && e.index === edges[0].index + i);
    }
    case 'revived':
      return isShortText(a.shape, LIMITS.maxId) && isColor(a.color) && Array.isArray(a.cells) && a.cells.length > 0 && a.cells.length <= LIMITS.maxShapeParts && a.cells.every((p) => isValidPart(p));
    case 'axis':
      return a.opt === 'row' || a.opt === 'col';
    case 'piece':
      return isShortText(a.shape, LIMITS.maxId) && isColor(a.color);
    case 'color':
      return isColor(a.color);
    case 'half':
      return typeof a.opt === 'string' && HALVES.includes(a.opt);
    case 'diag':
      return typeof a.opt === 'string' && DIAGS.includes(a.opt);
    case 'player':
      return isPlayer(a.who);
  }
}

export function isValidAction(a: unknown): a is Action {
  if (!isObj(a)) return false;
  if (a.kind === 'shot') return isValidEdge(a.edge);
  if (a.kind === 'claim') return isValidClaim(a.claim);
  if (a.kind === 'spell') return isValidSpellAction(a);
  return false;
}

const isSpellId = (x: unknown): x is string => typeof x === 'string' && (x === 'self' || x === 'hidden' || SPELL_IDS.includes(x));

function isValidSpellResult(r: Record<string, unknown>): boolean {
  if (!isSpellId(r.spell)) return false;
  if (r.occ !== undefined && typeof r.occ !== 'boolean') return false;
  if (r.count !== undefined && !isInt(r.count, 0, 1000)) return false;
  if (r.colors !== undefined && !(Array.isArray(r.colors) && r.colors.length <= 100 && r.colors.every(isColor))) return false;
  if (r.r !== undefined && !isInt(r.r, 0, GRID_SIZE - 1)) return false;
  if (r.c !== undefined && !isInt(r.c, 0, GRID_SIZE - 1)) return false;
  if (r.counts !== undefined && !(Array.isArray(r.counts) && r.counts.length === GRID_SIZE && r.counts.every((n) => isInt(n, 0, GRID_SIZE)))) return false;
  if (r.cells !== undefined) {
    if (!Array.isArray(r.cells) || r.cells.length > 4) return false;
    for (const x of r.cells) if (!(isObj(x) && isInt(x.r, 0, GRID_SIZE - 1) && isInt(x.c, 0, GRID_SIZE - 1) && (x.color === null || isColor(x.color)))) return false;
  }
  if (r.shots !== undefined) {
    if (!Array.isArray(r.shots) || r.shots.length > 5) return false;
    for (const s of r.shots) if (!(isObj(s) && isValidEdge(s.exit) && Array.isArray(s.colors) && s.colors.length <= 100 && s.colors.every(isColor))) return false;
  }
  if (r.piece !== undefined && r.piece !== null) {
    const p = r.piece;
    if (!(isObj(p) && isShortText(p.id, 120) && /^x\d+\./.test(p.id) && isShortText(p.shape, LIMITS.maxId) && isColor(p.color))) return false;
  }
  if (r.got !== undefined && r.got !== null && !(typeof r.got === 'string' && SPELL_IDS.includes(r.got))) return false;
  return true;
}

export function isValidResult(r: unknown): r is Result {
  if (!isObj(r)) return false;
  if (r.kind === 'shot') return isValidEdge(r.exit) && Array.isArray(r.colors) && r.colors.length <= 100 && r.colors.every(isColor);
  if (r.kind === 'claim') return typeof r.ok === 'boolean' && (r.eliminated === undefined || typeof r.eliminated === 'boolean');
  if (r.kind === 'spell') return isValidSpellResult(r);
  return false;
}

/** Jeu de pièces reçu : forme, limites et faisabilité sur la grille. */
export function isValidPieceSet(set: unknown): set is PieceSet {
  return pieceSetErrors(set, COLOR_IDS, (c) => catalogFits(c)).length === 0;
}

export function isValidTurn(e: unknown): e is PublicTurn {
  if (!(isObj(e) && isInt(e.n, 0, MAX_TURNS) && isPlayer(e.by) && isPlayer(e.target) && isValidAction(e.action) && isValidResult(e.result))) return false;
  const a = e.action as Action;
  const r = e.result as Result;
  if (a.kind !== r.kind) return false;
  if (a.kind === 'spell' && r.kind === 'spell' && a.spell !== r.spell) return false;
  return true;
}

const isPending = (p: unknown): p is PendingAction => isObj(p) && isInt(p.n, 0, MAX_TURNS) && isPlayer(p.target) && isValidAction(p.action);

/** Vérifie la forme d'un message reçu. Retourne null s'il est invalide. */
export function parseMessage(raw: unknown): Message | null {
  let m: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > 200_000) return null;
    try {
      m = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isObj(m)) return null;
  switch (m.t) {
    case 'ready':
      return { t: 'ready' };
    case 'activity':
      return typeof m.a === 'string' && ACTIVITIES.includes(m.a) ? { t: 'activity', a: m.a as Activity } : null;
    case 'start':
      return isPlayer(m.firstPlayer) ? { t: 'start', firstPlayer: m.firstPlayer } : null;
    case 'newgame':
      if (!isShortText(m.gameId, 64)) return null;
      if (m.set !== null && m.set !== undefined && !isValidPieceSet(m.set)) return null;
      if (m.cfg !== undefined && m.cfg !== null && !sanitizeSpellConfig(m.cfg)) return null;
      return { t: 'newgame', gameId: m.gameId, set: (m.set as PieceSet) ?? null, cfg: sanitizeSpellConfig(m.cfg), lobby: m.lobby === true };
    case 'set-accept':
    case 'set-refuse':
      return isHash(m.hash) ? { t: m.t, hash: m.hash } : null;
    case 'action':
      return isInt(m.n, 0, MAX_TURNS) && isPlayer(m.target) && isValidAction(m.action) ? { t: 'action', n: m.n, target: m.target, action: m.action } : null;
    case 'turn':
      return isValidTurn(m.turn) ? { t: 'turn', turn: m.turn } : null;
    case 'roster':
      if (!Array.isArray(m.players) || m.players.length > MAX_PLAYERS || typeof m.launched !== 'boolean') return null;
      return { t: 'roster', players: m.players.map(cleanName), launched: m.launched };
    case 'presence':
      if (!Array.isArray(m.online) || m.online.length > MAX_PLAYERS || !m.online.every((x) => typeof x === 'boolean')) return null;
      return { t: 'presence', online: m.online as boolean[] };
    case 'assign':
      return isPlayer(m.you) ? { t: 'assign', you: m.you } : null;
    case 'sync': {
      if (!isInt(m.v, 0, 1000) || typeof m.fp !== 'string' || m.fp.length > 64) return null;
      if (typeof m.gameId !== 'string' || m.gameId.length > 64 || !isPlayer(m.me)) return null;
      if (typeof m.ready !== 'boolean' || !(m.firstPlayer === null || isPlayer(m.firstPlayer))) return null;
      if (!Array.isArray(m.log) || m.log.length > MAX_TURNS || !m.log.every(isValidTurn)) return null;
      if (m.logLen !== undefined && !isInt(m.logLen, 0, MAX_TURNS)) return null;
      if (m.pending !== null && !isPending(m.pending)) return null;
      if (m.set !== null && !isValidPieceSet(m.set)) return null;
      if (m.setHash !== null && !isHash(m.setHash)) return null;
      if (m.cfg !== undefined && m.cfg !== null && !sanitizeSpellConfig(m.cfg)) return null;
      if (m.players !== undefined && m.players !== null && !(Array.isArray(m.players) && m.players.length >= 1 && m.players.length <= MAX_PLAYERS)) return null;
      if (m.launched !== undefined && typeof m.launched !== 'boolean') return null;
      return {
        t: 'sync',
        v: m.v,
        fp: m.fp,
        gameId: m.gameId,
        me: m.me,
        name: cleanName(m.name),
        ready: m.ready,
        firstPlayer: m.firstPlayer as PlayerIndex | null,
        log: m.log as PublicTurn[],
        logLen: m.logLen === undefined ? undefined : (m.logLen as number),
        pending: m.pending as PendingAction | null,
        set: m.set as PieceSet | null,
        setHash: m.setHash as string | null,
        ask: m.ask === true,
        cfg: sanitizeSpellConfig(m.cfg),
        players: Array.isArray(m.players) ? m.players.map(cleanName) : null,
        launched: m.launched === true,
      };
    }
    default:
      return null;
  }
}
