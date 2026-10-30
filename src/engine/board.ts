/**
 * Placement des pièces sur une grille et validation. Module pur.
 * Fonctionne avec n'importe quel jeu de pièces (catalogue).
 */

import { RULES, type Rules } from '../config/rules';
import { GRID_SIZE, cellKey, inBounds, rotateParts, rotationCount, type Cell, type Corner, type Part, type Rotation } from './geometry';
import { pieceDef, type Catalog } from './pieces';

/** Une pièce posée : `r`,`c` = case en haut à gauche de la forme après rotation. */
export interface Placement {
  pieceId: string;
  r: number;
  c: number;
  rot: Rotation;
}

/** Contenu d'une case occupée. */
export interface Occupant {
  pieceId: string;
  /** Défini seulement pour une demi-case triangulaire. */
  corner?: Corner;
}

export type Grid = (Occupant | null)[][];

const rotCache = new WeakMap<object, Map<number, Part[]>>();

/** Parts relatives d'une forme après rotation (avec cache). */
export function shapePartsRotated(shape: { parts: Part[] }, rot: Rotation): Part[] {
  let m = rotCache.get(shape);
  if (!m) {
    m = new Map();
    rotCache.set(shape, m);
  }
  let parts = m.get(rot);
  if (!parts) {
    parts = rotateParts(shape.parts, rot);
    m.set(rot, parts);
  }
  return parts;
}

/** Parts absolues occupées par une pièce posée. */
export function placementParts(p: Placement, catalog: Catalog): Part[] {
  const def = pieceDef(p.pieceId, catalog);
  const shape = def && catalog.shapes[def.shape];
  if (!shape) return [];
  return shapePartsRotated(shape, p.rot).map((o) => (o.corner ? { r: p.r + o.r, c: p.c + o.c, corner: o.corner } : { r: p.r + o.r, c: p.c + o.c }));
}

export function placementCells(p: Placement, catalog: Catalog): Cell[] {
  return placementParts(p, catalog).map(({ r, c }) => ({ r, c }));
}

export type PlacementErrorKind = 'unknown-piece' | 'duplicate' | 'out-of-bounds' | 'overlap' | 'touching' | 'missing';

export interface PlacementError {
  kind: PlacementErrorKind;
  pieceId: string;
  otherId?: string;
}

/**
 * Valide un ensemble de pièces posées. Une case ne peut contenir qu'une pièce
 * (même deux demi-cases complémentaires de pièces différentes sont refusées).
 * @param requireAll si vrai, toutes les pièces du jeu doivent être posées (bouton "Prêt").
 */
export function validatePlacement(
  placements: readonly Placement[],
  catalog: Catalog,
  options: { rules?: Rules; requireAll?: boolean; size?: number } = {},
): PlacementError[] {
  const rules = options.rules ?? RULES;
  const size = options.size ?? GRID_SIZE;
  const errors: PlacementError[] = [];
  const owner = new Map<string, string>();
  const seen = new Set<string>();

  for (const p of placements) {
    if (!pieceDef(p.pieceId, catalog)) {
      errors.push({ kind: 'unknown-piece', pieceId: p.pieceId });
      continue;
    }
    if (seen.has(p.pieceId)) {
      errors.push({ kind: 'duplicate', pieceId: p.pieceId });
      continue;
    }
    seen.add(p.pieceId);
    if (![0, 1, 2, 3].includes(p.rot) || !Number.isInteger(p.r) || !Number.isInteger(p.c)) {
      errors.push({ kind: 'out-of-bounds', pieceId: p.pieceId });
      continue;
    }
    const cells = placementCells(p, catalog);
    if (cells.some((cell) => !inBounds(cell, size))) {
      errors.push({ kind: 'out-of-bounds', pieceId: p.pieceId });
      continue;
    }
    for (const cell of cells) {
      const k = cellKey(cell);
      const other = owner.get(k);
      if (other && other !== p.pieceId) {
        errors.push({ kind: 'overlap', pieceId: p.pieceId, otherId: other });
        break;
      }
      owner.set(k, p.pieceId);
    }
  }

  if (!rules.allowTouchingPieces) {
    const reported = new Set<string>();
    for (const [k, id] of owner) {
      const [r, c] = k.split(',').map(Number);
      for (const [dr, dc] of [[0, 1], [1, 0]]) {
        const other = owner.get(cellKey({ r: r + dr, c: c + dc }));
        if (other && other !== id) {
          const pair = [id, other].sort().join('/');
          if (!reported.has(pair)) {
            reported.add(pair);
            errors.push({ kind: 'touching', pieceId: id, otherId: other });
          }
        }
      }
    }
  }

  if (options.requireAll) {
    for (const def of catalog.pieces) if (!seen.has(def.id)) errors.push({ kind: 'missing', pieceId: def.id });
  }
  return errors;
}

/**
 * Grille d'occupation à partir des pièces posées. Les pièces de `removed` (coulées)
 * sont ignorées. Suppose un placement valide.
 */
export function buildGrid(placements: readonly Placement[], catalog: Catalog, removed: ReadonlySet<string> = new Set(), size = GRID_SIZE): Grid {
  const grid: Grid = Array.from({ length: size }, () => Array<Occupant | null>(size).fill(null));
  for (const p of placements) {
    if (removed.has(p.pieceId)) continue;
    for (const part of placementParts(p, catalog)) {
      if (inBounds(part, size)) grid[part.r][part.c] = part.corner ? { pieceId: p.pieceId, corner: part.corner } : { pieceId: p.pieceId };
    }
  }
  return grid;
}

/** Placement aléatoire complet, ou null si aucun n'a été trouvé. */
export function tryRandomPlacement(
  catalog: Catalog,
  options: { rules?: Rules; size?: number; random?: () => number; attempts?: number } = {},
): Placement[] | null {
  const rules = options.rules ?? RULES;
  const size = options.size ?? GRID_SIZE;
  const rnd = options.random ?? Math.random;
  const attempts = options.attempts ?? 60;
  const shapeOf = (id: string) => catalog.shapes[pieceDef(id, catalog)!.shape];
  // Les plus grosses pièces d'abord.
  const order = [...catalog.pieces].sort((a, b) => shapeOf(b.id).parts.length - shapeOf(a.id).parts.length);

  for (let attempt = 0; attempt < attempts; attempt++) {
    const taken = new Set<string>();
    const result: Placement[] = [];
    let ok = true;
    for (const def of order) {
      const shape = shapeOf(def.id);
      const rots = rotationCount(shape.parts);
      let placed = false;
      for (let tries = 0; tries < 250 && !placed; tries++) {
        const rot = Math.floor(rnd() * rots) as Rotation;
        const parts = shapePartsRotated(shape, rot);
        const h = Math.max(...parts.map((p) => p.r)) + 1;
        const w = Math.max(...parts.map((p) => p.c)) + 1;
        if (h > size || w > size) break;
        const r = Math.floor(rnd() * (size - h + 1));
        const c = Math.floor(rnd() * (size - w + 1));
        const keys = parts.map((p) => cellKey({ r: r + p.r, c: c + p.c }));
        if (keys.some((k) => taken.has(k))) continue;
        if (!rules.allowTouchingPieces) {
          const near = parts.some((p) =>
            [[0, 1], [1, 0], [0, -1], [-1, 0]].some(([dr, dc]) => {
              const k = cellKey({ r: r + p.r + dr, c: c + p.c + dc });
              return taken.has(k) && !keys.includes(k);
            }),
          );
          if (near) continue;
        }
        keys.forEach((k) => taken.add(k));
        result.push({ pieceId: def.id, r, c, rot });
        placed = true;
      }
      if (!placed) {
        ok = false;
        break;
      }
    }
    if (ok) return result;
  }
  return null;
}

export function randomPlacement(catalog: Catalog, options: Parameters<typeof tryRandomPlacement>[1] = {}): Placement[] {
  const res = tryRandomPlacement(catalog, options);
  if (!res) throw new Error('Impossible de placer les pièces au hasard');
  return res;
}

/** Générateur pseudo-aléatoire déterministe (validation reproductible des jeux). */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Le jeu tient-il sur la grille ? (recherche aléatoire déterministe) */
export function catalogFits(catalog: Catalog, rules: Rules = RULES): boolean {
  return tryRandomPlacement(catalog, { rules, random: seededRandom(12345), attempts: 80 }) !== null;
}
