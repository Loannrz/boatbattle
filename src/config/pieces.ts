/**
 * ============================================================
 *  PIÈCES : palette, bibliothèque de formes, jeux prédéfinis
 * ============================================================
 * Ce fichier ne contient que des données, modifiables librement.
 * Les joueurs peuvent aussi créer leurs formes et leurs jeux dans l'app (Réglages) ;
 * ceux-là sont enregistrés sur le téléphone, pas ici.
 *
 * Forme : liste de parts {r, c} (ligne, colonne) ; une part avec `corner` est une
 * demi-case triangulaire dont l'angle droit est dans ce coin ('SW', 'NW', 'NE', 'SE').
 *
 * Attention : changer la palette ou un jeu prédéfini change l'empreinte de version.
 * Les deux téléphones doivent avoir la même version de l'app.
 */

import { triangleParts, type PieceSet, type ShapeDef } from '../engine/pieces';

/** Motifs discrets (lisibilité pour les personnes daltoniennes, avec la lettre). */
export type PatternId = 'stripes' | 'dots' | 'hlines' | 'grid' | 'vlines' | 'checker' | 'cross' | 'rings';

export interface ColorDef {
  name: string; // nom annoncé ("touché Rouge")
  hex: string; // couleur du papier
  letter: string; // lettre affichée sur la pièce
  pattern: PatternId;
}

/**
 * Papiers de couleur mats, tons naturels mais bien distincts (luminosités variées pour
 * rester lisibles en cas de daltonisme ; la lettre et le motif lèvent toute ambiguïté).
 */
export const COLORS: Record<string, ColorDef> = {
  rouge: { name: 'Rouge', hex: '#C4473A', letter: 'R', pattern: 'stripes' },
  orange: { name: 'Orange', hex: '#E08A3C', letter: 'O', pattern: 'dots' },
  jaune: { name: 'Jaune', hex: '#E6C653', letter: 'J', pattern: 'hlines' },
  vert: { name: 'Vert', hex: '#5E9A5B', letter: 'V', pattern: 'grid' },
  bleu: { name: 'Bleu', hex: '#3F6FAE', letter: 'B', pattern: 'vlines' },
  mauve: { name: 'Mauve', hex: '#9A6DAF', letter: 'M', pattern: 'checker' },
  turquoise: { name: 'Turquoise', hex: '#3E9C9A', letter: 'T', pattern: 'cross' },
  gris: { name: 'Gris', hex: '#8C8A85', letter: 'G', pattern: 'rings' },
};

export const COLOR_IDS = Object.keys(COLORS);

const shape = (id: string, name: string, cells: [number, number][]): ShapeDef => ({ id, name, parts: cells.map(([r, c]) => ({ r, c })) });

/** Bibliothèque de formes prédéfinies (non modifiables dans l'app). */
export const BUILTIN_SHAPES: ShapeDef[] = [
  shape('carre', 'Carré', [[0, 0]]),
  shape('barre2', 'Barre de 2', [[0, 0], [0, 1]]),
  shape('barre3', 'Barre de 3', [[0, 0], [0, 1], [0, 2]]),
  shape('barre4', 'Barre de 4', [[0, 0], [0, 1], [0, 2], [0, 3]]),
  shape('L3', 'L de 3', [[0, 0], [1, 0], [1, 1]]),
  shape('L4', 'L de 4', [[0, 0], [1, 0], [2, 0], [2, 1]]),
  shape('T4', 'T', [[0, 0], [0, 1], [0, 2], [1, 1]]),
  shape('S4', 'S', [[0, 1], [0, 2], [1, 0], [1, 1]]),
  shape('carre2', 'Grand carré', [[0, 0], [0, 1], [1, 0], [1, 1]]),
  { id: 'tri1', name: 'Triangle 1', parts: triangleParts(1) },
  { id: 'tri2', name: 'Triangle 2', parts: triangleParts(2) },
  { id: 'tri3', name: 'Triangle 3', parts: triangleParts(3) },
  { id: 'tri4', name: 'Triangle 4', parts: triangleParts(4) },
];

const lib = (...ids: string[]) => BUILTIN_SHAPES.filter((s) => ids.includes(s.id));

/**
 * Jeu « Classique » (celui de la version papier) : 12 pièces, 2 par couleur,
 * chaque couleur associe un bloc et un petit triangle.
 */
export const CLASSIC_SET: PieceSet = {
  id: 'classique',
  name: 'Classique',
  shapes: lib('carre', 'barre2', 'barre3', 'L3', 'tri1'),
  entries: [
    { shape: 'carre', color: 'rouge', count: 1 },
    { shape: 'tri1', color: 'rouge', count: 1 },
    { shape: 'carre', color: 'orange', count: 1 },
    { shape: 'tri1', color: 'orange', count: 1 },
    { shape: 'barre2', color: 'jaune', count: 1 },
    { shape: 'tri1', color: 'jaune', count: 1 },
    { shape: 'barre2', color: 'vert', count: 1 },
    { shape: 'tri1', color: 'vert', count: 1 },
    { shape: 'barre3', color: 'bleu', count: 1 },
    { shape: 'tri1', color: 'bleu', count: 1 },
    { shape: 'L3', color: 'mauve', count: 1 },
    { shape: 'tri1', color: 'mauve', count: 1 },
  ],
};

/** Jeu « Triangles » : des miroirs de toutes les tailles. */
export const TRIANGLES_SET: PieceSet = {
  id: 'triangles',
  name: 'Triangles',
  shapes: lib('carre', 'barre2', 'tri1', 'tri2', 'tri3', 'tri4'),
  entries: [
    { shape: 'tri1', color: 'rouge', count: 1 },
    { shape: 'tri1', color: 'orange', count: 1 },
    { shape: 'tri2', color: 'jaune', count: 1 },
    { shape: 'tri2', color: 'vert', count: 1 },
    { shape: 'tri3', color: 'bleu', count: 1 },
    { shape: 'tri4', color: 'mauve', count: 1 },
    { shape: 'carre', color: 'turquoise', count: 1 },
    { shape: 'barre2', color: 'gris', count: 1 },
  ],
};

export const BUILTIN_SETS: PieceSet[] = [CLASSIC_SET, TRIANGLES_SET];
export const DEFAULT_SET = CLASSIC_SET;
