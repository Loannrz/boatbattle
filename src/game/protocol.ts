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
import type { Claim } from '../engine/claim';
import type { PlayerIndex } from '../engine/turns';

export type { PlayerIndex };

export const PROTOCOL_VERSION = 2;

/**
 * Empreinte de version : protocole + règles + palette + version du moteur.
 * Deux téléphones dont l'empreinte diffère ne peuvent pas jouer ensemble.
 * (Le jeu de pièces a sa propre empreinte, comparée lors de l'acceptation.)
 */
export const ENGINE_VERSION = 2;
export function appFingerprint(): string {
  return hashString(JSON.stringify({ p: PROTOCOL_VERSION, e: ENGINE_VERSION, rules: RULES, colors: COLORS }));
}

export type Action = { kind: 'shot'; edge: Edge } | { kind: 'claim'; claim: Claim };

export type Result =
  | { kind: 'shot'; exit: Edge; colors: string[]; gameOver?: boolean }
  | { kind: 'claim'; ok: boolean; gameOver?: boolean };

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
}

export type Message =
  | SyncMessage
  | { t: 'ready' }
  | { t: 'start'; firstPlayer: PlayerIndex }
  | { t: 'action'; n: number; action: Action }
  | { t: 'result'; n: number; result: Result }
  | { t: 'newgame'; gameId: string; set: PieceSet | null }
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

export function isValidAction(a: unknown): a is Action {
  if (!isObj(a)) return false;
  if (a.kind === 'shot') return isValidEdge(a.edge);
  if (a.kind === 'claim') return isValidClaim(a.claim);
  return false;
}

export function isValidResult(r: unknown): r is Result {
  if (!isObj(r)) return false;
  if (r.gameOver !== undefined && typeof r.gameOver !== 'boolean') return false;
  if (r.kind === 'shot') return isValidEdge(r.exit) && Array.isArray(r.colors) && r.colors.length <= 100 && r.colors.every(isColor);
  if (r.kind === 'claim') return typeof r.ok === 'boolean';
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
      return { t: 'newgame', gameId: m.gameId, set: (m.set as PieceSet) ?? null };
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
      };
    }
    default:
      return null;
  }
}
