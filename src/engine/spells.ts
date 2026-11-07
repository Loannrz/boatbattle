/**
 * Sorts : définitions, réglages et calculs purs (sans DOM ni réseau).
 *
 * Un sort remplace le tir du tour. Deux familles :
 *  - « opp » : vise la grille adverse. C'est le DÉFENSEUR qui calcule le résultat sur son
 *    plateau (comme pour un tir) et n'en renvoie que la partie publique.
 *  - « self » : agit sur mon propre plateau ou mon propre état. L'adversaire reçoit
 *    seulement « un sort secret a été lancé » (action `spell: 'self'`).
 */

import { RULES, type Rules } from '../config/rules';
import { shapePartsRotated, validatePlacement, type Grid, type Placement } from './board';
import { GRID_SIZE, rotationCount, type Cell } from './geometry';
import { pieceDef, type Catalog } from './pieces';

export type SpellParam = 'none' | 'cell' | 'line' | 'axis' | 'edge2' | 'run' | 'color' | 'half' | 'diag' | 'piece' | 'revived';

export interface SpellDef {
  id: string;
  name: string;
  desc: string;
  target: 'opp' | 'self';
  param: SpellParam;
  /** Nombre de bords voisins pour un tir en rafale (param 'run'). */
  count?: number;
}

export const SPELLS: readonly SpellDef[] = [
  { id: 'reveal', name: 'Révélation', desc: 'Dévoile une case de la grille adverse : vide ou occupée, et la couleur de la pièce.', target: 'opp', param: 'cell' },
  { id: 'loupe', name: 'Loupe', desc: 'Dévoile un bloc de 2 × 2 cases, case par case (vide ou occupée, avec la couleur).', target: 'opp', param: 'cell' },
  { id: 'radar', name: 'Radar', desc: 'Compte les cases occupées d’une ligne ou d’une colonne adverse.', target: 'opp', param: 'line' },
  { id: 'histo', name: 'Histogramme', desc: 'Compte les cases occupées de toutes les lignes, ou de toutes les colonnes, de la grille adverse.', target: 'opp', param: 'axis' },
  { id: 'prisme', name: 'Prisme', desc: 'Donne les couleurs présentes dans une ligne ou une colonne adverse (sans les positions).', target: 'opp', param: 'line' },
  { id: 'sonar', name: 'Sonar', desc: 'Compte les cases occupées et les couleurs dans un carré de 3 × 3 autour d’une case.', target: 'opp', param: 'cell' },
  { id: 'hint', name: 'Indice', desc: 'Dévoile une case occupée au hasard (avec sa couleur).', target: 'opp', param: 'none' },
  { id: 'diag', name: 'Diagonale', desc: 'Compte les cases occupées sur une grande diagonale adverse.', target: 'opp', param: 'diag' },
  { id: 'half', name: 'Moitié', desc: 'Compte les cases occupées dans une moitié de la grille adverse (haut, bas, gauche ou droite).', target: 'opp', param: 'half' },
  { id: 'ring', name: 'Périmètre', desc: 'Compte les cases occupées sur le contour de la grille adverse (les 36 cases du bord).', target: 'opp', param: 'none' },
  { id: 'center', name: 'Centre', desc: 'Compte les cases occupées dans le carré central 4 × 4 de la grille adverse.', target: 'opp', param: 'none' },
  { id: 'colorscan', name: 'Détecteur', desc: 'Choisis une couleur : tu apprends combien de cases elle occupe encore chez l’adversaire.', target: 'opp', param: 'color' },
  { id: 'double', name: 'Double tir', desc: 'Tire par deux bords différents en un seul tour.', target: 'opp', param: 'edge2' },
  { id: 'salve', name: 'Salve', desc: 'Tire par trois bords voisins en un seul tour.', target: 'opp', param: 'run', count: 3 },
  { id: 'rafale', name: 'Rafale', desc: 'Tire par cinq bords voisins en un seul tour.', target: 'opp', param: 'run', count: 5 },
  { id: 'spy', name: 'Espion', desc: 'Tu apprends combien de sorts l’adversaire a en réserve.', target: 'opp', param: 'none' },
  { id: 'steal', name: 'Vol de sort', desc: 'Prend un sort au hasard dans la réserve de l’adversaire.', target: 'opp', param: 'none' },
  { id: 'sabotage', name: 'Sabotage', desc: 'Détruit un sort au hasard dans la réserve de l’adversaire.', target: 'opp', param: 'none' },
  { id: 'silence', name: 'Silence', desc: 'L’adversaire ne pourra pas lancer de sort à son prochain tour.', target: 'opp', param: 'none' },
  { id: 'freeze', name: 'Gel', desc: 'Ne prend pas ton tour : tu joues ensuite deux tours de suite avant que l’adversaire reprenne la main.', target: 'opp', param: 'none' },
  { id: 'addpiece', name: 'Renfort', desc: 'Ajoute une pièce de ton choix à TA grille, où tu veux : l’adversaire a une pièce de plus à trouver. Il la voit apparaître dans son carnet, mais pas où elle est.', target: 'opp', param: 'piece' },
  { id: 'shuffle', name: 'Tempête', desc: 'Mélange toute TA grille au hasard, y compris tes pièces coulées qui reviennent en jeu. L’adversaire le voit : son carnet est remis à zéro (croix, formes supposées et pièces coulées) et il doit tout retrouver.', target: 'opp', param: 'none' },
  { id: 'relocate', name: 'Déménagement', desc: 'Déplace une de tes pièces à flot au hasard sur un nouvel emplacement libre, sans que l’adversaire le sache.', target: 'self', param: 'none' },
  { id: 'pivot', name: 'Pivot', desc: 'Fait pivoter une de tes pièces à flot sur place, sans que l’adversaire le sache.', target: 'self', param: 'none' },
  { id: 'revive', name: 'Résurrection', desc: 'Ressuscite une de tes pièces coulées, au hasard. L’adversaire voit laquelle revient en jeu (elle n’est plus « coulée » dans son carnet) et peut la couler de nouveau. Elle revient à sa place, ou ailleurs en secret si une autre pièce l’occupe maintenant.', target: 'opp', param: 'revived' },
  { id: 'fog', name: 'Brume', desc: 'Le prochain tir reçu ne révèle aucune couleur.', target: 'self', param: 'none' },
  { id: 'decoy', name: 'Leurre', desc: 'Le prochain tir reçu annoncera une fausse couleur en plus des vraies.', target: 'self', param: 'none' },
  { id: 'mirage', name: 'Mirage', desc: 'Le prochain tir reçu traverse ta grille comme si elle était vide.', target: 'self', param: 'none' },
  { id: 'camouflage', name: 'Camouflage', desc: 'La prochaine déclaration de l’adversaire sera refusée, même si elle est juste : il perd son tour.', target: 'self', param: 'none' },
  { id: 'draw', name: 'Pioche', desc: 'Pioche tout de suite deux nouveaux sorts au hasard.', target: 'self', param: 'none' },
];

export const SPELL_IDS: readonly string[] = SPELLS.map((s) => s.id);
const BY_ID: Record<string, SpellDef> = Object.fromEntries(SPELLS.map((s) => [s.id, s]));

export function spellDef(id: string): SpellDef | undefined {
  return Object.prototype.hasOwnProperty.call(BY_ID, id) ? BY_ID[id] : undefined;
}

// ---------- réglages ----------

export interface SpellConfig {
  /** Les sorts sont-ils actifs dans la partie ? */
  enabled: boolean;
  /** Un sort tous les N tours du joueur (0 = jamais). */
  everyTurns: number;
  /** Un sort à chaque pièce adverse coulée. */
  onSink: boolean;
  /** Sorts qui peuvent apparaître. */
  pool: string[];
}

export const DEFAULT_SPELL_CONFIG: SpellConfig = { enabled: false, everyTurns: 3, onSink: true, pool: [...SPELL_IDS] };

export function cloneSpellConfig(c: SpellConfig): SpellConfig {
  return { ...c, pool: [...c.pool] };
}

/** Réglages reçus ou lus du stockage : forme vérifiée, ou null. */
export function sanitizeSpellConfig(x: unknown): SpellConfig | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.enabled !== 'boolean' || typeof o.onSink !== 'boolean') return null;
  if (!Number.isInteger(o.everyTurns) || (o.everyTurns as number) < 0 || (o.everyTurns as number) > 20) return null;
  if (!Array.isArray(o.pool) || o.pool.length > SPELLS.length) return null;
  const pool = [...new Set(o.pool.filter((p): p is string => typeof p === 'string' && SPELL_IDS.includes(p)))];
  if (pool.length !== new Set(o.pool).size) return null;
  return { enabled: o.enabled, everyTurns: o.everyTurns as number, onSink: o.onSink, pool };
}

// ---------- géométrie des zones ----------

export type LineAxis = 'row' | 'col';
export type HalfName = 'top' | 'bottom' | 'left' | 'right';
export type DiagName = 'main' | 'anti';
export const HALVES: readonly string[] = ['top', 'bottom', 'left', 'right'];
export const DIAGS: readonly string[] = ['main', 'anti'];

const range = (n = GRID_SIZE) => Array.from({ length: n }, (_, i) => i);

export function lineCells(axis: LineAxis, index: number): Cell[] {
  return range().map((i) => (axis === 'row' ? { r: index, c: i } : { r: i, c: index }));
}

export function diagCells(kind: DiagName): Cell[] {
  return range().map((i) => ({ r: i, c: kind === 'main' ? i : GRID_SIZE - 1 - i }));
}

export function halfCells(half: HalfName): Cell[] {
  const mid = GRID_SIZE / 2;
  const out: Cell[] = [];
  for (let r = 0; r < GRID_SIZE; r++)
    for (let c = 0; c < GRID_SIZE; c++) {
      if ((half === 'top' && r < mid) || (half === 'bottom' && r >= mid) || (half === 'left' && c < mid) || (half === 'right' && c >= mid)) out.push({ r, c });
    }
  return out;
}

export function zoneCells(r: number, c: number): Cell[] {
  const out: Cell[] = [];
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr >= 0 && rr < GRID_SIZE && cc >= 0 && cc < GRID_SIZE) out.push({ r: rr, c: cc });
    }
  return out;
}

// ---------- lecture d'une grille ----------

export function cellColor(grid: Grid, cat: Catalog, cell: Cell): string | null {
  const occ = grid[cell.r]?.[cell.c];
  return occ ? (pieceDef(occ.pieceId, cat)?.color ?? null) : null;
}

export function occupiedCells(grid: Grid, cells: readonly Cell[]): Cell[] {
  return cells.filter((c) => !!grid[c.r]?.[c.c]);
}

export function colorsIn(grid: Grid, cat: Catalog, cells: readonly Cell[]): string[] {
  const out: string[] = [];
  for (const cell of cells) {
    const col = cellColor(grid, cat, cell);
    if (col && !out.includes(col)) out.push(col);
  }
  return out;
}

// ---------- placement ----------

/** Emplacement libre au hasard pour la pièce `pieceId` (qui doit exister dans `cat`). */
export function randomSpot(others: readonly Placement[], cat: Catalog, pieceId: string, random: () => number = Math.random, rules: Rules = RULES): Placement | null {
  const def = pieceDef(pieceId, cat);
  const shape = def && cat.shapes[def.shape];
  if (!shape) return null;
  const rots = rotationCount(shape.parts);
  for (let i = 0; i < 600; i++) {
    const rot = Math.floor(random() * rots) as 0 | 1 | 2 | 3;
    const parts = shapePartsRotated(shape, rot);
    const h = Math.max(...parts.map((p) => p.r)) + 1;
    const w = Math.max(...parts.map((p) => p.c)) + 1;
    if (h > GRID_SIZE || w > GRID_SIZE) return null;
    const cand: Placement = { pieceId, r: Math.floor(random() * (GRID_SIZE - h + 1)), c: Math.floor(random() * (GRID_SIZE - w + 1)), rot };
    if (validatePlacement([...others, cand], cat, { rules }).length === 0) return cand;
  }
  return null;
}

export function ringCells(): Cell[] {
  const out: Cell[] = [];
  for (let r = 0; r < GRID_SIZE; r++) for (let c = 0; c < GRID_SIZE; c++) if (r === 0 || c === 0 || r === GRID_SIZE - 1 || c === GRID_SIZE - 1) out.push({ r, c });
  return out;
}

export function centerCells(): Cell[] {
  const out: Cell[] = [];
  const lo = Math.floor((GRID_SIZE - 4) / 2);
  for (let r = lo; r < lo + 4; r++) for (let c = lo; c < lo + 4; c++) out.push({ r, c });
  return out;
}

/** Bloc de 2 × 2 dont le coin haut-gauche est ramené dans la grille. */
export function blockCells(r: number, c: number): Cell[] {
  const r0 = Math.min(r, GRID_SIZE - 2);
  const c0 = Math.min(c, GRID_SIZE - 2);
  return [
    { r: r0, c: c0 },
    { r: r0, c: c0 + 1 },
    { r: r0 + 1, c: c0 },
    { r: r0 + 1, c: c0 + 1 },
  ];
}

/** Rotations possibles d'une pièce posée, sur place (même coin haut-gauche). */
export function pivotSpot(others: readonly Placement[], cat: Catalog, current: Placement, random: () => number = Math.random): Placement | null {
  const def = pieceDef(current.pieceId, cat);
  const shape = def && cat.shapes[def.shape];
  if (!shape) return null;
  const rots = rotationCount(shape.parts);
  const options = ([0, 1, 2, 3] as const).filter((rot) => rot < rots && rot !== current.rot).map((rot) => ({ ...current, rot }));
  const valid = options.filter((cand) => validatePlacement([...others, cand], cat).length === 0);
  return valid.length ? valid[Math.floor(random() * valid.length)] : null;
}
