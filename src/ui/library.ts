/**
 * Bibliothèque locale (sur ce téléphone) : formes créées, jeux de pièces enregistrés,
 * jeu sélectionné pour les nouvelles parties.
 */

import { BUILTIN_SETS, BUILTIN_SHAPES, COLOR_IDS, DEFAULT_SET } from '../config/pieces';
import { catalogFits, pieceSetErrors, shapeError, type PieceSet, type ShapeDef } from '../engine';
import { store } from './storage';

const KEY_SHAPES = 'bb.shapes';
const KEY_SETS = 'bb.sets';
const KEY_ACTIVE = 'bb.activeSet';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ---------- formes ----------

export function customShapes(): ShapeDef[] {
  return readJson<ShapeDef[]>(KEY_SHAPES, []).filter((s) => shapeError(s) === null);
}

export function allShapes(): ShapeDef[] {
  return [...BUILTIN_SHAPES, ...customShapes()];
}

export function isBuiltinShape(id: string): boolean {
  return BUILTIN_SHAPES.some((s) => s.id === id);
}

export function saveShape(shape: ShapeDef): void {
  const list = customShapes().filter((s) => s.id !== shape.id);
  list.push(shape);
  store.setItem(KEY_SHAPES, JSON.stringify(list));
  // mettre à jour la définition embarquée dans les jeux qui l'utilisent
  const sets = customSets().map((set) => ({ ...set, shapes: set.shapes.map((s) => (s.id === shape.id ? shape : s)) }));
  store.setItem(KEY_SETS, JSON.stringify(sets));
}

/** Supprime une forme ; refusé si un jeu enregistré l'utilise. Retourne le nom du jeu bloquant. */
export function deleteShape(id: string): string | null {
  const user = customSets().find((set) => set.entries.some((e) => e.shape === id));
  if (user) return user.name;
  store.setItem(KEY_SHAPES, JSON.stringify(customShapes().filter((s) => s.id !== id)));
  return null;
}

// ---------- jeux ----------

export function customSets(): PieceSet[] {
  return readJson<PieceSet[]>(KEY_SETS, []).filter((s) => s && Array.isArray(s.entries) && Array.isArray(s.shapes));
}

export function allSets(): PieceSet[] {
  return [...BUILTIN_SETS, ...customSets()];
}

export function isBuiltinSet(id: string): boolean {
  return BUILTIN_SETS.some((s) => s.id === id);
}

export function setErrors(set: PieceSet): string[] {
  return pieceSetErrors(set, COLOR_IDS, (c) => catalogFits(c));
}

export function saveSet(set: PieceSet): void {
  if (isBuiltinSet(set.id)) return;
  // n'embarquer que les formes utilisées
  const used = new Set(set.entries.map((e) => e.shape));
  const clean: PieceSet = { ...set, shapes: set.shapes.filter((s) => used.has(s.id)) };
  const list = customSets().filter((s) => s.id !== set.id);
  list.push(clean);
  store.setItem(KEY_SETS, JSON.stringify(list));
}

export function deleteSet(id: string): void {
  if (isBuiltinSet(id)) return;
  store.setItem(KEY_SETS, JSON.stringify(customSets().filter((s) => s.id !== id)));
  if (activeSetId() === id) setActiveSet(DEFAULT_SET.id);
}

export function duplicateSet(set: PieceSet): PieceSet {
  const copy: PieceSet = JSON.parse(JSON.stringify(set));
  copy.id = uid('jeu');
  copy.name = `${set.name} (copie)`.slice(0, 24);
  saveSet(copy);
  return copy;
}

export function activeSetId(): string {
  return store.getItem(KEY_ACTIVE) ?? DEFAULT_SET.id;
}

export function setActiveSet(id: string): void {
  store.setItem(KEY_ACTIVE, id);
}

/** Jeu sélectionné pour les nouvelles parties (Classique si introuvable ou invalide). */
export function activeSet(): PieceSet {
  const set = allSets().find((s) => s.id === activeSetId());
  if (!set || (!isBuiltinSet(set.id) && setErrors(set).length > 0)) return DEFAULT_SET;
  return set;
}
