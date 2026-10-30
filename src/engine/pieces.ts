/**
 * Formes, jeux de pièces et validation (module pur).
 *
 * - Une FORME est une liste de parts : cases pleines ou demi-cases triangulaires (coin).
 * - Un JEU est autonome : il embarque la définition des formes qu'il utilise et la liste
 *   des pièces (forme + couleur + nombre d'exemplaires). Il peut donc voyager d'un
 *   téléphone à l'autre et être validé à la réception.
 */

import {
  DELTA,
  OPPOSITE,
  cellKey,
  normalizeParts,
  partsSignature,
  solidSide,
  CORNERS,
  type Dir,
  type Part,
} from './geometry';

export interface ShapeDef {
  id: string;
  name: string;
  parts: Part[];
}

export interface SetEntry {
  shape: string; // id d'une forme du jeu
  color: string; // id d'une couleur de la palette
  count: number;
}

export interface PieceSet {
  id: string;
  name: string;
  shapes: ShapeDef[];
  entries: SetEntry[];
}

/** Une pièce concrète d'une partie (un exemplaire). */
export interface PieceDef {
  id: string;
  shape: string;
  color: string;
}

/** Jeu "déplié", prêt pour le moteur. */
export interface Catalog {
  set: PieceSet;
  pieces: PieceDef[];
  shapes: Record<string, ShapeDef>;
}

/** Limites (protègent aussi contre un jeu malformé reçu par le réseau). */
export const LIMITS = {
  maxShapeParts: 12,
  maxShapeSpan: 5,
  maxShapes: 24,
  maxEntries: 24,
  maxCount: 6,
  maxPieces: 24,
  maxTotalCells: 50,
  maxName: 24,
  maxId: 40,
} as const;

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function catalogOf(set: PieceSet): Catalog {
  const shapes: Record<string, ShapeDef> = Object.create(null);
  for (const s of set.shapes) shapes[s.id] = s;
  const pieces: PieceDef[] = [];
  for (const e of set.entries) {
    for (let k = 1; k <= e.count; k++) pieces.push({ id: `${e.shape}.${e.color}.${k}`, shape: e.shape, color: e.color });
  }
  return { set, pieces, shapes };
}

export function shapeOf(catalog: Catalog, pieceId: string): ShapeDef | undefined {
  const def = catalog.pieces.find((p) => p.id === pieceId);
  return def ? catalog.shapes[def.shape] : undefined;
}

export function pieceDef(pieceId: string, catalog: Catalog): PieceDef | undefined {
  return catalog.pieces.find((p) => p.id === pieceId);
}

/** Triangle rectangle isocèle de côté n (angle droit en bas à gauche, rotation 0). */
export function triangleParts(n: number): Part[] {
  const parts: Part[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (r > c) parts.push({ r, c });
      else if (r === c) parts.push({ r, c, corner: 'SW' });
    }
  }
  return parts;
}

export function isTriangleShape(shape: ShapeDef): boolean {
  return shape.parts.some((p) => p.corner);
}

export function shapeArea(shape: ShapeDef): number {
  return shape.parts.length;
}

// ---------- validation ----------

const isInt = (x: unknown) => Number.isInteger(x);
const isText = (x: unknown, max: number) => typeof x === 'string' && x.length > 0 && x.length <= max;

/** Vérifie une forme. Retourne un message d'erreur (français) ou null. */
export function shapeError(shape: unknown): string | null {
  if (!shape || typeof shape !== 'object') return 'Forme invalide.';
  const s = shape as ShapeDef;
  if (!isText(s.id, LIMITS.maxId)) return 'Identifiant de forme invalide.';
  if (!isText(s.name, LIMITS.maxName)) return 'Nom de forme invalide (1 à 24 caractères).';
  if (!Array.isArray(s.parts) || s.parts.length === 0) return 'La forme est vide.';
  if (s.parts.length > LIMITS.maxShapeParts) return `Forme trop grande (au plus ${LIMITS.maxShapeParts} cases).`;
  for (const p of s.parts) {
    if (!p || typeof p !== 'object' || !isInt(p.r) || !isInt(p.c)) return 'Case de forme invalide.';
    if (p.corner !== undefined && !CORNERS.includes(p.corner)) return 'Demi-case invalide.';
    if (p.r < 0 || p.c < 0 || p.r >= LIMITS.maxShapeSpan || p.c >= LIMITS.maxShapeSpan) return `La forme doit tenir dans ${LIMITS.maxShapeSpan} × ${LIMITS.maxShapeSpan} cases.`;
  }
  const keys = new Set(s.parts.map(cellKey));
  if (keys.size !== s.parts.length) return 'Deux parts occupent la même case.';
  if (partsSignature(normalizeParts(s.parts)) !== partsSignature(s.parts)) return 'Forme non normalisée.';
  if (!isConnected(s.parts)) return 'La forme doit être d’un seul tenant (les cases doivent se toucher par un côté plein).';
  return null;
}

/**
 * Connexité : deux parts voisines sont reliées si elles partagent un côté plein des deux
 * côtés (une demi-case n'est pleine que sur les deux côtés de son angle droit).
 */
export function isConnected(parts: readonly Part[]): boolean {
  if (parts.length === 0) return false;
  const byKey = new Map(parts.map((p) => [cellKey(p), p]));
  const seen = new Set<string>([cellKey(parts[0])]);
  const stack: Part[] = [parts[0]];
  while (stack.length) {
    const p = stack.pop()!;
    for (const d of ['N', 'E', 'S', 'W'] as Dir[]) {
      const q = byKey.get(cellKey({ r: p.r + DELTA[d].r, c: p.c + DELTA[d].c }));
      if (!q || seen.has(cellKey(q))) continue;
      if (solidSide(p, d) && solidSide(q, OPPOSITE[d])) {
        seen.add(cellKey(q));
        stack.push(q);
      }
    }
  }
  return seen.size === parts.length;
}

/**
 * Vérifie un jeu de pièces. `colorIds` = couleurs autorisées (palette de l'app).
 * `fits` vérifie qu'un placement complet existe sur la grille (peut être injecté pour les tests).
 * Retourne la liste des erreurs (vide si valide).
 */
export function pieceSetErrors(
  set: unknown,
  colorIds: readonly string[],
  fits: (catalog: Catalog) => boolean,
): string[] {
  if (!set || typeof set !== 'object') return ['Jeu de pièces invalide.'];
  const s = set as PieceSet;
  const errors: string[] = [];
  if (!isText(s.id, LIMITS.maxId)) errors.push('Identifiant du jeu invalide.');
  if (!isText(s.name, LIMITS.maxName)) errors.push('Nom du jeu invalide (1 à 24 caractères).');
  if (!Array.isArray(s.shapes) || s.shapes.length > LIMITS.maxShapes) return [...errors, 'Liste de formes invalide.'];
  if (!Array.isArray(s.entries) || s.entries.length === 0) return [...errors, 'Le jeu ne contient aucune pièce.'];
  if (s.entries.length > LIMITS.maxEntries) return [...errors, 'Trop de lignes dans le jeu.'];
  const shapeIds = new Set<string>();
  for (const sh of s.shapes) {
    const err = shapeError(sh);
    if (err) return [...errors, `${(sh as ShapeDef)?.name ?? 'Forme'} : ${err}`];
    if (shapeIds.has(sh.id)) return [...errors, 'Deux formes ont le même identifiant.'];
    shapeIds.add(sh.id);
  }
  let pieces = 0;
  let cells = 0;
  const lines = new Set<string>();
  for (const e of s.entries) {
    if (!e || typeof e !== 'object' || typeof e.shape !== 'string' || !shapeIds.has(e.shape)) return [...errors, 'Une pièce utilise une forme inconnue.'];
    if (typeof e.color !== 'string' || !colorIds.includes(e.color)) return [...errors, 'Une pièce utilise une couleur inconnue.'];
    if (!isInt(e.count) || e.count < 1 || e.count > LIMITS.maxCount) return [...errors, `Nombre d’exemplaires invalide (1 à ${LIMITS.maxCount}).`];
    const line = `${e.shape}.${e.color}`;
    if (lines.has(line)) return [...errors, 'La même forme apparaît deux fois avec la même couleur : augmentez plutôt le nombre d’exemplaires.'];
    lines.add(line);
    pieces += e.count;
    cells += e.count * s.shapes.find((x) => x.id === e.shape)!.parts.length;
  }
  if (pieces > LIMITS.maxPieces) errors.push(`Trop de pièces (${pieces}, au plus ${LIMITS.maxPieces}).`);
  if (cells > LIMITS.maxTotalCells) errors.push(`Les pièces couvrent trop de cases (${cells}, au plus ${LIMITS.maxTotalCells} sur 100).`);
  if (errors.length === 0 && !fits(catalogOf(s))) errors.push('Impossible de placer toutes ces pièces sur une grille de 10 × 10.');
  return errors;
}

// ---------- empreinte ----------

/** Hachage FNV-1a 32 bits (deux passes pour 64 bits), suffisant pour comparer des versions. */
export function hashString(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ch, 0x5bd1e995) >>> 0;
    h2 ^= h2 >>> 13;
  }
  return h1.toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** Forme canonique d'un jeu (seules la géométrie et les couleurs comptent, pas les noms). */
export function canonicalSet(set: PieceSet): string {
  const shapes = [...set.shapes].map((s) => ({ id: s.id, parts: partsSignature(s.parts) })).sort((a, b) => (a.id < b.id ? -1 : 1));
  const entries = [...set.entries].map((e) => `${e.shape}.${e.color}.${e.count}`).sort();
  return JSON.stringify({ shapes, entries });
}

export function setHash(set: PieceSet): string {
  return hashString(canonicalSet(set));
}

export function setStats(set: PieceSet): { pieces: number; cells: number } {
  let pieces = 0;
  let cells = 0;
  for (const e of set.entries) {
    const shape = set.shapes.find((s) => s.id === e.shape);
    pieces += e.count;
    cells += e.count * (shape?.parts.length ?? 0);
  }
  return { pieces, cells };
}

/** Object.hasOwn compatible (refuse "__proto__", "constructor"…). */
export const hasOwn = own;
