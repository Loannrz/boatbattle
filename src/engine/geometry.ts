/**
 * Géométrie de base : cases, directions, bords, coins de demi-cases, rotations.
 * Module pur (aucun accès au DOM ni au réseau).
 *
 * Conventions :
 *  - Une case est {r, c} : r = ligne (0 = ligne "1" en haut), c = colonne (0 = "A" à gauche).
 *  - Une direction de déplacement est N (vers le haut), E (droite), S (bas), W (gauche).
 *  - Un bord de tir est {side, index} :
 *      side 'top' | 'bottom' -> index = colonne (A..J)
 *      side 'left' | 'right' -> index = ligne   (1..10)
 *    Exemple : "B haut" = {side:'top', index:1} ; "10 gauche" = {side:'left', index:9}.
 */

export const GRID_SIZE = 10;

export interface Cell {
  r: number;
  c: number;
}

export type Dir = 'N' | 'E' | 'S' | 'W';
export type Side = 'top' | 'bottom' | 'left' | 'right';

export interface Edge {
  side: Side;
  index: number;
}

/** Rotation par pas de 90° dans le sens horaire. */
export type Rotation = 0 | 1 | 2 | 3;

/**
 * Demi-case triangulaire : `corner` = coin de l'angle droit. Les deux côtés qui touchent
 * ce coin sont des faces plates ; la diagonale est un miroir.
 *  SW : moitié basse-gauche remplie, miroir "\"
 *  NW : moitié haute-gauche remplie, miroir "/"
 *  NE : moitié haute-droite remplie, miroir "\"
 *  SE : moitié basse-droite remplie, miroir "/"
 */
export type Corner = 'SW' | 'NW' | 'NE' | 'SE';
export const CORNERS: readonly Corner[] = ['SW', 'NW', 'NE', 'SE'];

/** Une case d'une forme : pleine (pas de `corner`) ou demi-case triangulaire. */
export interface Part extends Cell {
  corner?: Corner;
}

export const DELTA: Record<Dir, Cell> = {
  N: { r: -1, c: 0 },
  E: { r: 0, c: 1 },
  S: { r: 1, c: 0 },
  W: { r: 0, c: -1 },
};

export const OPPOSITE: Record<Dir, Dir> = { N: 'S', S: 'N', E: 'W', W: 'E' };

/** Rotation horaire d'un coin : la moitié basse-gauche devient haute-gauche, etc. */
export const CORNER_CW: Record<Corner, Corner> = { SW: 'NW', NW: 'NE', NE: 'SE', SE: 'SW' };

export const COL_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.slice(0, GRID_SIZE).split('');

export function inBounds(cell: Cell, size = GRID_SIZE): boolean {
  return cell.r >= 0 && cell.r < size && cell.c >= 0 && cell.c < size;
}

export function cellKey(cell: Cell): string {
  return `${cell.r},${cell.c}`;
}

export function cellLabel(cell: Cell): string {
  return `${COL_LABELS[cell.c] ?? '?'}${cell.r + 1}`;
}

const SIDE_FR: Record<Side, string> = { top: 'haut', bottom: 'bas', left: 'gauche', right: 'droite' };

/** "B haut", "10 gauche"… */
export function edgeLabel(edge: Edge): string {
  const name = edge.side === 'top' || edge.side === 'bottom' ? COL_LABELS[edge.index] : String(edge.index + 1);
  return `${name} ${SIDE_FR[edge.side]}`;
}

export function sameEdge(a: Edge, b: Edge): boolean {
  return a.side === b.side && a.index === b.index;
}

/** Première case touchée et direction de déplacement quand le laser entre par ce bord. */
export function entryOf(edge: Edge, size = GRID_SIZE): { cell: Cell; dir: Dir } {
  switch (edge.side) {
    case 'top':
      return { cell: { r: 0, c: edge.index }, dir: 'S' };
    case 'bottom':
      return { cell: { r: size - 1, c: edge.index }, dir: 'N' };
    case 'left':
      return { cell: { r: edge.index, c: 0 }, dir: 'E' };
    case 'right':
      return { cell: { r: edge.index, c: size - 1 }, dir: 'W' };
  }
}

/** Bord atteint quand le laser sort de la grille en arrivant sur la case hors-grille `cell`. */
export function edgeOfExit(cell: Cell, size = GRID_SIZE): Edge {
  if (cell.r < 0) return { side: 'top', index: cell.c };
  if (cell.r >= size) return { side: 'bottom', index: cell.c };
  if (cell.c < 0) return { side: 'left', index: cell.r };
  return { side: 'right', index: cell.r };
}

export function isValidEdge(edge: unknown, size = GRID_SIZE): edge is Edge {
  if (!edge || typeof edge !== 'object') return false;
  const e = edge as Edge;
  return (
    (e.side === 'top' || e.side === 'bottom' || e.side === 'left' || e.side === 'right') &&
    Number.isInteger(e.index) &&
    e.index >= 0 &&
    e.index < size
  );
}

/** Côtés "jambes" (faces plates) d'une demi-case, exprimés comme directions vers l'extérieur. */
export function triangleLegs(corner: Corner): [Dir, Dir] {
  return [corner[0] as Dir, corner[1] as Dir];
}

/** Côtés ouverts (du côté de la diagonale) d'une demi-case. */
export function triangleOpenSides(corner: Corner): [Dir, Dir] {
  const [a, b] = triangleLegs(corner);
  return [OPPOSITE[a], OPPOSITE[b]];
}

/** Vrai si la part a de la matière tout le long de son côté `side`. */
export function solidSide(part: Part, side: Dir): boolean {
  return !part.corner || triangleLegs(part.corner).includes(side);
}

/** Ramène des parts pour que la plus petite ligne et la plus petite colonne valent 0. */
export function normalizeParts(parts: readonly Part[]): Part[] {
  if (parts.length === 0) return [];
  const minR = Math.min(...parts.map((p) => p.r));
  const minC = Math.min(...parts.map((p) => p.c));
  return parts.map((p) => (p.corner ? { r: p.r - minR, c: p.c - minC, corner: p.corner } : { r: p.r - minR, c: p.c - minC }));
}

/** Parts d'une forme après `rot` rotations horaires de 90°, normalisées. */
export function rotateParts(parts: readonly Part[], rot: Rotation): Part[] {
  let out: Part[] = parts.map((p) => ({ ...p }));
  for (let i = 0; i < rot; i++) {
    // (r, c) -> (c, -r) et le coin tourne aussi
    out = out.map((p) => (p.corner ? { r: p.c, c: -p.r, corner: CORNER_CW[p.corner] } : { r: p.c, c: -p.r }));
  }
  return normalizeParts(out);
}

/** Signature canonique d'un ensemble de parts (ordre indifférent). */
export function partsSignature(parts: readonly Part[]): string {
  return parts
    .map((p) => `${p.r},${p.c}${p.corner ? p.corner : ''}`)
    .sort()
    .join('|');
}

/** Nombre d'orientations distinctes (1, 2 ou 4). */
export function rotationCount(parts: readonly Part[]): number {
  const seen = new Set<string>();
  for (let rot = 0; rot < 4; rot++) seen.add(partsSignature(rotateParts(parts, rot as Rotation)));
  return seen.size;
}
