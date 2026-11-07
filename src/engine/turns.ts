/**
 * Ordre des tours à N joueurs (2 à 4), chacun pour soi.
 *
 * - Rotation parmi les joueurs encore en jeu (un joueur dont toutes les pièces sont
 *   coulées est éliminé : il ne joue plus et n'est plus ciblable).
 * - Par défaut chaque action fait passer la main. Si rules.correctClaimPassesTurn est
 *   faux, une déclaration juste permet de rejouer.
 * - Sorts qui changent l'ordre (tous publics, visibles de tous) :
 *   · Gel (freeze) : ne prend pas le tour du lanceur ; la cible saute son prochain tour.
 *   · Saut (skip) : le joueur suivant saute son tour.
 *   · Double saut (doubleskip) : les deux joueurs suivants sautent leur tour.
 *   · Inversion (reverse) : le sens de rotation s'inverse.
 *   · Relais (relay) : le joueur désigné (`who`) joue juste après le lanceur ; la rotation
 *     reprend ensuite à partir de lui.
 *   · Diversion (divert) : le joueur suivant doit viser le joueur désigné (voir forcedTargetAt).
 */

import { RULES, type Rules } from '../config/rules';

export type PlayerIndex = 0 | 1 | 2 | 3;
export const MAX_PLAYERS = 4;
export const PLAYER_INDICES: readonly PlayerIndex[] = [0, 1, 2, 3];

export interface TurnLike {
  by: PlayerIndex;
  /** Joueur visé (le lanceur lui-même pour un sort secret ou un sort d'ordre). */
  target: PlayerIndex;
  action: { kind: string; spell?: string; who?: number };
  result: { kind: string; ok?: boolean; spell?: string; eliminated?: boolean };
}

export interface OrderState {
  /** Joueur qui doit jouer maintenant. */
  current: PlayerIndex;
  /** Joueurs encore en jeu. */
  alive: boolean[];
  /** Sens de rotation. */
  dir: 1 | -1;
  /** Joueurs gelés (ils sauteront leur prochain tour). */
  frozen: PlayerIndex[];
}

function aliveOf(log: readonly TurnLike[], upTo: number, players: number): boolean[] {
  const alive = Array.from({ length: players }, () => true);
  for (let i = 0; i < upTo && i < log.length; i++) {
    const e = log[i];
    if (e.result.kind === 'claim' && e.result.ok && e.result.eliminated && e.target < players) alive[e.target] = false;
  }
  return alive;
}

/** Joueurs encore en jeu après les `n` premiers tours du journal. */
export function alivePlayersAt(log: readonly TurnLike[], n: number, players: number): PlayerIndex[] {
  const alive = aliveOf(log, n, players);
  return PLAYER_INDICES.filter((i) => i < players && alive[i]);
}

/** Tour où le joueur `p` a été éliminé (null = encore en jeu). */
export function eliminatedAt(log: readonly TurnLike[], p: PlayerIndex): number | null {
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (e.target === p && e.result.kind === 'claim' && e.result.ok && e.result.eliminated) return i;
  }
  return null;
}

/** État de l'ordre après les `n` premiers tours du journal. */
export function orderAt(first: PlayerIndex, log: readonly TurnLike[], n: number, players: number, rules: Rules = RULES): OrderState {
  const alive = Array.from({ length: Math.max(players, 2) }, () => true);
  let cur: PlayerIndex = first;
  let dir: 1 | -1 = 1;
  let skips = 0; // joueurs suivants qui sautent leur tour (Saut, Double saut)
  const frozen = new Set<PlayerIndex>(); // joueurs qui sautent leur prochain tour (Gel)
  let relayTo: PlayerIndex | null = null;

  const stepAlive = (from: PlayerIndex): PlayerIndex => {
    let c = from;
    for (let g = 0; g < alive.length; g++) {
      c = ((((c + dir) % alive.length) + alive.length) % alive.length) as PlayerIndex;
      if (alive[c]) return c;
    }
    return from;
  };
  const advance = (from: PlayerIndex): PlayerIndex => {
    if (alive.filter(Boolean).length <= 1) return from;
    if (relayTo !== null) {
      const to = relayTo;
      relayTo = null;
      if (alive[to] && to !== from) {
        if (!frozen.has(to)) return to;
        frozen.delete(to);
        return advance(to);
      }
    }
    let c = from;
    for (let g = 0; g < alive.length * 4; g++) {
      c = stepAlive(c);
      if (skips > 0) {
        skips--;
        continue;
      }
      if (frozen.has(c)) {
        frozen.delete(c);
        continue;
      }
      return c;
    }
    return c;
  };

  for (let i = 0; i < n && i < log.length; i++) {
    const e = log[i];
    const r = e.result;
    const a = e.action;
    if (r.kind === 'claim' && r.ok && r.eliminated && e.target < alive.length) alive[e.target] = false;
    if (r.kind === 'spell') {
      switch (r.spell) {
        case 'freeze':
          if (e.target !== e.by) frozen.add(e.target);
          continue; // ne prend pas le tour
        case 'skip':
          skips += 1;
          break;
        case 'doubleskip':
          skips += 2;
          break;
        case 'reverse':
          dir = dir === 1 ? -1 : 1;
          break;
        case 'relay':
          if (typeof a.who === 'number' && a.who >= 0 && a.who < alive.length && a.who !== e.by) relayTo = a.who as PlayerIndex;
          break;
      }
    }
    const keep = !rules.correctClaimPassesTurn && r.kind === 'claim' && r.ok === true;
    if (!keep) cur = advance(cur);
  }
  return { current: cur, alive, dir, frozen: [...frozen] };
}

/** Joueur qui doit jouer le tour n (0 = premier tour), d'après le journal. */
export function attackerAt(first: PlayerIndex, log: readonly TurnLike[], n: number, rules: Rules = RULES, players = 2): PlayerIndex {
  return orderAt(first, log, n, players, rules).current;
}

/**
 * Diversion : si le dernier tour joué par un AUTRE joueur est un sort « divert » désignant
 * un joueur encore en jeu différent de l'attaquant du tour n, ce dernier doit viser ce joueur.
 * Les Gels lancés entre-temps par l'attaquant (qui lui font rejouer) ne lèvent pas l'obligation.
 */
export function forcedTargetAt(first: PlayerIndex, log: readonly TurnLike[], n: number, players: number, rules: Rules = RULES): PlayerIndex | null {
  if (n === 0 || n > log.length) return null;
  const attacker = attackerAt(first, log, n, rules, players);
  let k = n - 1;
  while (k >= 0 && log[k].by === attacker && log[k].result.kind === 'spell' && log[k].result.spell === 'freeze') k--;
  if (k < 0) return null;
  const prev = log[k];
  if (prev.by === attacker || prev.result.kind !== 'spell' || prev.result.spell !== 'divert' || typeof prev.action.who !== 'number') return null;
  const who = prev.action.who as PlayerIndex;
  const alive = aliveOf(log, n, players);
  if (who >= players || !alive[who]) return null;
  return who === attacker ? null : who;
}
