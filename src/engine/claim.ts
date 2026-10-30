/**
 * Déclaration "j'ai trouvé ta pièce" (couler une pièce sans tirer). Module pur.
 *
 * Le joueur qui déclare indique : la couleur, la forme et toutes les cases occupées
 * (chaque case peut porter le coin d'une demi-case, utilisé seulement si
 * rules.claimNeedsOrientation est vrai).
 *
 * La déclaration est exacte s'il existe, parmi les pièces NON coulées du défenseur,
 * une pièce de même couleur, même forme, occupant exactement ces cases.
 * Pour un triangle de côté 2 ou plus, les cases suffisent à fixer l'orientation ;
 * pour un petit triangle (1 case), l'orientation n'est pas exigée par défaut.
 */

import { RULES, type Rules } from '../config/rules';
import { placementParts, type Placement } from './board';
import { cellKey, type Part } from './geometry';
import { pieceDef, type Catalog } from './pieces';

export interface Claim {
  color: string;
  shape: string;
  cells: Part[];
}

export interface ClaimCheck {
  ok: boolean;
  pieceId?: string;
}

function sameParts(actual: readonly Part[], claimed: readonly Part[], withCorners: boolean): boolean {
  if (actual.length !== claimed.length) return false;
  const key = (p: Part) => cellKey(p) + (withCorners ? (p.corner ?? '') : '');
  const ka = new Set(actual.map(key));
  const kb = new Set(claimed.map(key));
  const cellsB = new Set(claimed.map(cellKey));
  if (ka.size !== actual.length || kb.size !== claimed.length || cellsB.size !== claimed.length) return false;
  return [...kb].every((k) => ka.has(k));
}

export function checkClaim(
  placements: readonly Placement[],
  sunk: ReadonlySet<string>,
  claim: Claim,
  catalog: Catalog,
  rules: Rules = RULES,
): ClaimCheck {
  if (!claim || !Array.isArray(claim.cells) || claim.cells.length === 0) return { ok: false };
  for (const p of placements) {
    if (sunk.has(p.pieceId)) continue;
    const def = pieceDef(p.pieceId, catalog);
    if (!def || def.color !== claim.color || def.shape !== claim.shape) continue;
    if (!sameParts(placementParts(p, catalog), claim.cells, rules.claimNeedsOrientation)) continue;
    return { ok: true, pieceId: p.pieceId };
  }
  return { ok: false };
}
