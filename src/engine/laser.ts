/**
 * MOTEUR DU LASER (module pur, testé dans laser.test.ts)
 * =====================================================
 *
 * Règles implémentées (hypothèses validées avec les joueurs, voir src/config/rules.ts) :
 *
 *  1. Le laser entre par un bord de la grille et avance case par case en ligne droite.
 *  2. Case vide : il la traverse.
 *  3. Face plate (carré, barre, L, ou côté de l'angle droit d'un triangle) :
 *     il repart exactement en sens inverse. La pièce est "touchée".
 *  4. Diagonale d'une demi-case (miroir à 45°) : le laser tourne de 90° et ressort
 *     par l'autre côté ouvert de la demi-case. Un grand triangle est fait de cases
 *     pleines (faces plates) et de demi-cases le long de sa diagonale (miroirs) : le
 *     laser rebondit donc sur toute la diagonale. La pièce est "touchée" si
 *     rules.announceDeflections est vrai.
 *  5. Il peut enchaîner plusieurs rebonds/déviations. Il finit toujours par sortir
 *     de la grille (les trajets sont réversibles, donc pas de boucle infinie ;
 *     une limite de sécurité existe quand même).
 *  6. Résultat : bord de sortie + liste ORDONNÉE des pièces touchées (la première fois
 *     seulement si rules.countEachPieceOnce).
 *
 * Le trajet (`path`) est fourni pour l'affichage : liste de points en coordonnées
 * continues (x = colonne, y = ligne, la case (r,c) couvre [c, c+1] x [r, r+1]).
 */

import { RULES, type Rules } from '../config/rules';
import type { Grid } from './board';
import {
  DELTA,
  GRID_SIZE,
  OPPOSITE,
  edgeOfExit,
  entryOf,
  inBounds,
  triangleLegs,
  triangleOpenSides,
  type Dir,
  type Edge,
} from './geometry';

export interface HitEvent {
  pieceId: string;
  /** 'face' = rebond sur une face plate, 'miroir' = déviation par l'hypoténuse. */
  kind: 'face' | 'miroir';
  r: number;
  c: number;
}

export interface LaserResult {
  exit: Edge;
  /** Pièces touchées, dans l'ordre (dédoublonnées selon les règles). */
  hits: string[];
  /** Tous les contacts, dans l'ordre, sans dédoublonnage (pour l'affichage). */
  events: HitEvent[];
  /** Points de passage du laser (entrée, chaque rebond, sortie). */
  path: { x: number; y: number }[];
}

/** Point au milieu du côté `side` de la case (r, c). */
function sidePoint(r: number, c: number, side: Dir): { x: number; y: number } {
  switch (side) {
    case 'N':
      return { x: c + 0.5, y: r };
    case 'S':
      return { x: c + 0.5, y: r + 1 };
    case 'W':
      return { x: c, y: r + 0.5 };
    case 'E':
      return { x: c + 1, y: r + 0.5 };
  }
}

export function traceLaser(grid: Grid, entry: Edge, rules: Rules = RULES): LaserResult {
  const size = grid.length || GRID_SIZE;
  const start = entryOf(entry, size);
  let { r, c } = start.cell;
  let dir: Dir = start.dir;

  const path = [sidePoint(r, c, OPPOSITE[dir])];
  const events: HitEvent[] = [];
  const hits: string[] = [];

  const record = (pieceId: string, kind: HitEvent['kind']) => {
    events.push({ pieceId, kind, r, c });
    if (kind === 'miroir' && !rules.announceDeflections) return;
    if (rules.countEachPieceOnce && hits.includes(pieceId)) return;
    hits.push(pieceId);
  };

  const maxSteps = size * size * 8 + 16;
  for (let step = 0; step < maxSteps; step++) {
    if (!inBounds({ r, c }, size)) {
      // Le dernier point est sur le bord de sortie.
      const back = OPPOSITE[dir];
      path.push(sidePoint(r + DELTA[back].r, c + DELTA[back].c, dir));
      return { exit: edgeOfExit({ r, c }, size), hits, events, path };
    }

    const occ = grid[r][c];
    const entrySide = OPPOSITE[dir]; // côté de la case par lequel le laser arrive

    if (occ === null) {
      // case vide : on continue tout droit
    } else if (!occ.corner) {
      // Face plate : demi-tour, sans entrer dans la case.
      record(occ.pieceId, 'face');
      path.push(sidePoint(r, c, entrySide));
      dir = OPPOSITE[dir];
    } else {
      const legs = triangleLegs(occ.corner);
      if (legs.includes(entrySide)) {
        // Côté de l'angle droit = face plate.
        record(occ.pieceId, 'face');
        path.push(sidePoint(r, c, entrySide));
        dir = OPPOSITE[dir];
      } else {
        // Hypoténuse : le laser ressort par l'autre côté ouvert.
        record(occ.pieceId, 'miroir');
        const [a, b] = triangleOpenSides(occ.corner);
        const exitSide = a === entrySide ? b : a;
        path.push({ x: c + 0.5, y: r + 0.5 });
        dir = exitSide;
      }
    }
    r += DELTA[dir].r;
    c += DELTA[dir].c;
  }
  // Ne devrait jamais arriver (trajets réversibles). On sort au point d'entrée par sécurité.
  return { exit: entry, hits, events, path };
}
