/**
 * Ordre des tours. Par défaut les tours alternent toujours (un tir ou une déclaration,
 * juste ou fausse, fait passer la main). Si rules.correctClaimPassesTurn est faux,
 * une déclaration juste permet de rejouer. Le sort « Gel » fait aussi rejouer le lanceur.
 */

import { RULES, type Rules } from '../config/rules';

export type PlayerIndex = 0 | 1;

export interface TurnLike {
  by: PlayerIndex;
  action: { kind: string };
  result: { kind: string; ok?: boolean; spell?: string };
}

/** Joueur qui doit jouer le tour n (0 = premier tour), d'après le journal. */
export function attackerAt(first: PlayerIndex, log: readonly TurnLike[], n: number, rules: Rules = RULES): PlayerIndex {
  let cur = first;
  for (let i = 0; i < n && i < log.length; i++) {
    const e = log[i];
    const keep = (!rules.correctClaimPassesTurn && e.result.kind === 'claim' && e.result.ok === true) || (e.result.kind === 'spell' && e.result.spell === 'freeze');
    if (!keep) cur = (1 - cur) as PlayerIndex;
  }
  return cur;
}
