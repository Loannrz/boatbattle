/**
 * Messages échangés entre les deux appareils, et leur validation.
 *
 * Confidentialité : le placement d'un joueur ne quitte JAMAIS son appareil.
 * Seuls transitent : le jeu de pièces de la partie (choisi par l'hôte), les actions
 * (tir, déclaration) et leurs résultats publics (bord de sortie, couleurs, coulée oui/non).
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
import type { PlayerIndex } from '../engine/turns';

export type { PlayerIndex };

export const PROTOCOL_VERSION = 3;

/**
 * Empreinte de version : protocole + règles + palette + version du moteur.
 * Deux téléphones dont l'empreinte diffère ne peuvent pas jouer ensemble.
 * (Le jeu de pièces a sa propre empreinte, comparée lors de l'acceptation.)
 */
export const ENGINE_VERSION = 3;
export function appFingerprint(): string {
  return hashString(JSON.stringify({ p: PROTOCOL_VERSION, e: ENGINE_VERSION, rules: RULES, colors: COLORS }));
}

/** Sort lancé. `spell: 'self'` = sort secret qui n'agit que sur le plateau du lanceur. */
export interface SpellAction {
  kind: 'spell';
  spell: string;
  r?: number;
  c?: number;
  axis?: 'row' | 'col';
  index?: number;
  edges?: Edge[];
  color?: string;
  opt?: string;
}

export interface SpellResult {
  kind: 'spell';
  spell: string;
  occ?: boolean;
  count?: number;
  colors?: string[];
  r?: number;
  c?: number;
  shots?: { exit: Edge; colors: string[] }[];
  /** Intrus : pièce ajoutée (null = plus de place, sans effet). */
  piece?: { id: string; shape: string; color: string } | null;
  /** Vol de sort : sort volé (null = réserve vide). */
  got?: string | null;
  gameOver?: boolean;
}

export type Action = { kind: 'shot'; edge: Edge } | { kind: 'claim'; claim: Claim } | SpellAction;

export type Result =
  | { kind: 'shot'; exit: Edge; colors: string[]; gameOver?: boolean }
  | { kind: 'claim'; ok: boolean; gameOver?: boolean }
  | SpellResult;

/** Partie publique d'un tour (ce que les deux joueurs connaissent). */
export interface PublicTurn {
  n: number;
  by: PlayerIndex;
  action: Action;
  result: Result;
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
  log: PublicTurn[];
  pending: { n: number; action: Action } | null;
  /** Jeu de pièces de la partie (envoyé par l'hôte). */
  set: PieceSet | null;
  /** Empreinte du jeu que l'expéditeur a accepté / utilise (null = aucun). */
  setHash: string | null;
  /** Demande à l'autre de renvoyer son propre sync. */
  ask?: boolean;
  /** Réglages des sorts de la partie (envoyés par l'hôte). */
  cfg?: SpellConfig | null;
}

export type Message =
  | SyncMessage
  | { t: 'ready' }
  | { t: 'start'; firstPlayer: PlayerIndex }
  | { t: 'action'; n: number; action: Action }
  | { t: 'result'; n: number; result: Result }
  | { t: 'newgame'; gameId: string; set: PieceSet | null; cfg?: SpellConfig | null }
  | { t: 'set-accept'; hash: string }
  | { t: 'set-refuse'; hash: string };

const MAX_TURNS = 5000;
const isInt = (x: unknown, min: number, max: number): x is number => Number.isInteger(x) && (x as number) >= min && (x as number) <= max;
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isPlayer = (x: unknown): x is PlayerIndex => x === 0 || x === 1;
const isShortText = (x: unknown, max: number): x is string => typeof x === 'string' && x.length > 0 && x.length <= max;
const isHash = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{16}$/.test(x);
const isColor = (x: unknown): x is string => typeof x === 'string' && hasOwn(COLORS, x);

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
  if (a.spell === 'self') return true;
  const def = spellDef(a.spell);
  if (!def || def.target !== 'opp') return false;
  switch (def.param) {
    case 'none':
      return true;
    case 'cell':
      return isInt(a.r, 0, GRID_SIZE - 1) && isInt(a.c, 0, GRID_SIZE - 1);
    case 'line':
      return (a.axis === 'row' || a.axis === 'col') && isInt(a.index, 0, GRID_SIZE - 1);
    case 'edge2':
      return Array.isArray(a.edges) && a.edges.length === 2 && a.edges.every(isValidEdge);
    case 'salve':
      return Array.isArray(a.edges) && a.edges.length === 3 && a.edges.every(isValidEdge);
    case 'color':
      return isColor(a.color);
    case 'half':
      return typeof a.opt === 'string' && HALVES.includes(a.opt);
    case 'diag':
      return typeof a.opt === 'string' && DIAGS.includes(a.opt);
  }
}

export function isValidAction(a: unknown): a is Action {
  if (!isObj(a)) return false;
  if (a.kind === 'shot') return isValidEdge(a.edge);
  if (a.kind === 'claim') return isValidClaim(a.claim);
  if (a.kind === 'spell') return isValidSpellAction(a);
  return false;
}

const isSpellId = (x: unknown): x is string => typeof x === 'string' && (x === 'self' || SPELL_IDS.includes(x));

function isValidSpellResult(r: Record<string, unknown>): boolean {
  if (!isSpellId(r.spell)) return false;
  if (r.occ !== undefined && typeof r.occ !== 'boolean') return false;
  if (r.count !== undefined && !isInt(r.count, 0, 1000)) return false;
  if (r.colors !== undefined && !(Array.isArray(r.colors) && r.colors.length <= 100 && r.colors.every(isColor))) return false;
  if (r.r !== undefined && !isInt(r.r, 0, GRID_SIZE - 1)) return false;
  if (r.c !== undefined && !isInt(r.c, 0, GRID_SIZE - 1)) return false;
  if (r.shots !== undefined) {
    if (!Array.isArray(r.shots) || r.shots.length > 3) return false;
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
  if (r.gameOver !== undefined && typeof r.gameOver !== 'boolean') return false;
  if (r.kind === 'shot') return isValidEdge(r.exit) && Array.isArray(r.colors) && r.colors.length <= 100 && r.colors.every(isColor);
  if (r.kind === 'claim') return typeof r.ok === 'boolean';
  if (r.kind === 'spell') return isValidSpellResult(r);
  return false;
}

/** Jeu de pièces reçu : forme, limites et faisabilité sur la grille. */
export function isValidPieceSet(set: unknown): set is PieceSet {
  return pieceSetErrors(set, COLOR_IDS, (c) => catalogFits(c)).length === 0;
}

function isValidTurn(e: unknown): e is PublicTurn {
  return isObj(e) && isInt(e.n, 0, MAX_TURNS) && isPlayer(e.by) && isValidAction(e.action) && isValidResult(e.result) && (e.action as Action).kind === (e.result as Result).kind;
}

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
    case 'start':
      return isPlayer(m.firstPlayer) ? { t: 'start', firstPlayer: m.firstPlayer } : null;
    case 'newgame':
      if (!isShortText(m.gameId, 64)) return null;
      if (m.set !== null && m.set !== undefined && !isValidPieceSet(m.set)) return null;
      if (m.cfg !== undefined && m.cfg !== null && !sanitizeSpellConfig(m.cfg)) return null;
      return { t: 'newgame', gameId: m.gameId, set: (m.set as PieceSet) ?? null, cfg: sanitizeSpellConfig(m.cfg) };
    case 'set-accept':
    case 'set-refuse':
      return isHash(m.hash) ? { t: m.t, hash: m.hash } : null;
    case 'action':
      return isInt(m.n, 0, MAX_TURNS) && isValidAction(m.action) ? { t: 'action', n: m.n, action: m.action } : null;
    case 'result':
      return isInt(m.n, 0, MAX_TURNS) && isValidResult(m.result) ? { t: 'result', n: m.n, result: m.result } : null;
    case 'sync': {
      if (!isInt(m.v, 0, 1000) || typeof m.fp !== 'string' || m.fp.length > 64) return null;
      if (typeof m.gameId !== 'string' || m.gameId.length > 64 || !isPlayer(m.me)) return null;
      if (typeof m.ready !== 'boolean' || !(m.firstPlayer === null || isPlayer(m.firstPlayer))) return null;
      if (!Array.isArray(m.log) || m.log.length > MAX_TURNS || !m.log.every(isValidTurn)) return null;
      if (m.pending !== null && !(isObj(m.pending) && isInt(m.pending.n, 0, MAX_TURNS) && isValidAction(m.pending.action))) return null;
      if (m.set !== null && !isValidPieceSet(m.set)) return null;
      if (m.setHash !== null && !isHash(m.setHash)) return null;
      if (m.cfg !== undefined && m.cfg !== null && !sanitizeSpellConfig(m.cfg)) return null;
      return {
        t: 'sync',
        v: m.v,
        fp: m.fp,
        gameId: m.gameId,
        me: m.me,
        name: typeof m.name === 'string' ? m.name.slice(0, 40) : '',
        ready: m.ready,
        firstPlayer: m.firstPlayer as PlayerIndex | null,
        log: m.log as PublicTurn[],
        pending: m.pending as SyncMessage['pending'],
        set: m.set as PieceSet | null,
        setHash: m.setHash as string | null,
        ask: m.ask === true,
        cfg: sanitizeSpellConfig(m.cfg),
      };
    }
    default:
      return null;
  }
}
