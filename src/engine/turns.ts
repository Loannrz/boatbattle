/**
 * Ordre des tours. Par défaut les tours alternent toujours (un tir ou une déclaration,
 * juste ou fausse, fait passer la main). Si rules.correctClaimPassesTurn est faux,
 * une déclaration juste permet de rejouer. Le sort « Gel » ne prend pas le tour : le lanceur joue ensuite deux tours de suite.
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
  let extra = 0; // tours supplémentaires accordés par Gel
  for (let i = 0; i < n && i < log.length; i++) {
    const e = log[i];
    if (e.result.kind === 'spell' && e.result.spell === 'freeze') {
      extra = 1; // le sort ne prend pas le tour, et le tour suivant est aussi pour le lanceur
      continue;
    }
    if (extra > 0) {
      extra--;
      continue;
    }
    const keep = !rules.correctClaimPassesTurn && e.result.kind === 'claim' && e.result.ok === true;
    if (!keep) cur = (1 - cur) as PlayerIndex;
  }
  return cur;
}
