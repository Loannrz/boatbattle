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

export type SpellParam = 'none' | 'cell' | 'line' | 'axis' | 'edge2' | 'run' | 'color' | 'half' | 'diag' | 'piece' | 'revived' | 'player';

/**
 * Qui voit quoi quand le sort est lancé :
 *  - public : tout le monde voit le sort, ses paramètres et son résultat (sorts qui changent
 *    la grille du lanceur, tirs multiples, sorts qui changent l'ordre des tours) ;
 *  - private : seuls le lanceur et la cible voient le détail, les autres voient
 *    « A a lancé un sort sur B » ;
 *  - secret : sort du lanceur sur lui-même, les autres voient seulement « sort secret ».
 */
export type SpellVisibility = 'public' | 'private' | 'secret';

export interface SpellDef {
  id: string;
  name: string;
  desc: string;
  /**
   * opp : vise un adversaire (le défenseur calcule le résultat sur sa grille) ;
   * self : agit en secret sur mon plateau ;
   * own : agit sur ma grille ou sur l'ordre des tours, au vu de tous (résultat calculé par
   * le lanceur et vérifié par chacun).
   */
  target: 'opp' | 'self' | 'own';
  param: SpellParam;
  visibility: SpellVisibility;
  /** Nombre de bords voisins pour un tir en rafale (param 'run'). */
  count?: number;
  /** Nombre minimal de joueurs dans la partie pour que le sort existe (2 par défaut). */
  minPlayers?: number;
}

export const SPELLS: readonly SpellDef[] = [
  { id: 'reveal', name: 'Révélation', desc: 'Dévoile une case de la grille visée : vide ou occupée, et la couleur de la pièce.', target: 'opp', param: 'cell', visibility: 'private' },
  { id: 'loupe', name: 'Loupe', desc: 'Dévoile un bloc de 2 × 2 cases, case par case (vide ou occupée, avec la couleur).', target: 'opp', param: 'cell', visibility: 'private' },
  { id: 'radar', name: 'Radar', desc: 'Compte les cases occupées d’une ligne ou d’une colonne de la grille visée.', target: 'opp', param: 'line', visibility: 'private' },
  { id: 'histo', name: 'Histogramme', desc: 'Compte les cases occupées de toutes les lignes, ou de toutes les colonnes, de la grille visée.', target: 'opp', param: 'axis', visibility: 'private' },
  { id: 'prisme', name: 'Prisme', desc: 'Donne les couleurs présentes dans une ligne ou une colonne de la grille visée (sans les positions).', target: 'opp', param: 'line', visibility: 'private' },
  { id: 'sonar', name: 'Sonar', desc: 'Compte les cases occupées et les couleurs dans un carré de 3 × 3 autour d’une case.', target: 'opp', param: 'cell', visibility: 'private' },
  { id: 'hint', name: 'Indice', desc: 'Dévoile une case occupée au hasard (avec sa couleur).', target: 'opp', param: 'none', visibility: 'private' },
  { id: 'diag', name: 'Diagonale', desc: 'Compte les cases occupées sur une grande diagonale de la grille visée.', target: 'opp', param: 'diag', visibility: 'private' },
  { id: 'half', name: 'Moitié', desc: 'Compte les cases occupées dans une moitié de la grille visée (haut, bas, gauche ou droite).', target: 'opp', param: 'half', visibility: 'private' },
  { id: 'ring', name: 'Périmètre', desc: 'Compte les cases occupées sur le contour de la grille visée (les 36 cases du bord).', target: 'opp', param: 'none', visibility: 'private' },
  { id: 'center', name: 'Centre', desc: 'Compte les cases occupées dans le carré central 4 × 4 de la grille visée.', target: 'opp', param: 'none', visibility: 'private' },
  { id: 'colorscan', name: 'Détecteur', desc: 'Choisis une couleur : tu apprends combien de cases elle occupe encore chez le joueur visé.', target: 'opp', param: 'color', visibility: 'private' },
  { id: 'double', name: 'Double tir', desc: 'Tire par deux bords différents en un seul tour. Comme tout tir, tout le monde voit le résultat.', target: 'opp', param: 'edge2', visibility: 'public' },
  { id: 'salve', name: 'Salve', desc: 'Tire par trois bords voisins en un seul tour. Comme tout tir, tout le monde voit le résultat.', target: 'opp', param: 'run', count: 3, visibility: 'public' },
  { id: 'rafale', name: 'Rafale', desc: 'Tire par cinq bords voisins en un seul tour. Comme tout tir, tout le monde voit le résultat.', target: 'opp', param: 'run', count: 5, visibility: 'public' },
  { id: 'spy', name: 'Espion', desc: 'Tu apprends combien de sorts le joueur visé a en réserve.', target: 'opp', param: 'none', visibility: 'private' },
  { id: 'steal', name: 'Vol de sort', desc: 'Prend un sort au hasard dans la réserve du joueur visé.', target: 'opp', param: 'none', visibility: 'private' },
  { id: 'sabotage', name: 'Sabotage', desc: 'Détruit un sort au hasard dans la réserve du joueur visé.', target: 'opp', param: 'none', visibility: 'private' },
  { id: 'silence', name: 'Silence', desc: 'Le joueur visé ne pourra pas lancer de sort à son prochain tour.', target: 'opp', param: 'none', visibility: 'private' },
  { id: 'freeze', name: 'Gel', desc: 'Ne prend pas ton tour : tu rejoues tout de suite, et le joueur visé saute son prochain tour. (À deux : tu joues deux tours de suite.)', target: 'opp', param: 'none', visibility: 'public' },
  { id: 'addpiece', name: 'Renfort', desc: 'Ajoute une pièce de ton choix à TA grille, où tu veux : tes adversaires ont une pièce de plus à trouver. Ils la voient apparaître dans leur carnet, mais pas où elle est.', target: 'own', param: 'piece', visibility: 'public' },
  { id: 'shuffle', name: 'Tempête', desc: 'Mélange toute TA grille au hasard, y compris tes pièces coulées qui reviennent en jeu. Tout le monde le voit : les carnets te concernant sont remis à zéro (croix, formes supposées et pièces coulées).', target: 'own', param: 'none', visibility: 'public' },
  { id: 'relocate', name: 'Déménagement', desc: 'Déplace une de tes pièces à flot au hasard sur un nouvel emplacement libre, sans que personne le sache.', target: 'self', param: 'none', visibility: 'secret' },
  { id: 'pivot', name: 'Pivot', desc: 'Fait pivoter une de tes pièces à flot sur place, sans que personne le sache.', target: 'self', param: 'none', visibility: 'secret' },
  { id: 'revive', name: 'Résurrection', desc: 'Ressuscite une de tes pièces coulées, au hasard. Tout le monde voit laquelle revient en jeu (elle n’est plus « coulée » dans les carnets) et peut la couler de nouveau. Elle revient à un emplacement libre choisi au hasard, que les adversaires ne connaissent pas.', target: 'own', param: 'revived', visibility: 'public' },
  { id: 'fog', name: 'Brume', desc: 'Le prochain tir reçu ne révèle aucune couleur.', target: 'self', param: 'none', visibility: 'secret' },
  { id: 'decoy', name: 'Leurre', desc: 'Le prochain tir reçu annoncera une fausse couleur en plus des vraies.', target: 'self', param: 'none', visibility: 'secret' },
  { id: 'mirage', name: 'Mirage', desc: 'Le prochain tir reçu traverse ta grille comme si elle était vide.', target: 'self', param: 'none', visibility: 'secret' },
  { id: 'camouflage', name: 'Camouflage', desc: 'La prochaine déclaration visant ta grille sera refusée, même si elle est juste : son auteur perd son tour.', target: 'self', param: 'none', visibility: 'secret' },
  { id: 'draw', name: 'Pioche', desc: 'Pioche tout de suite deux nouveaux sorts au hasard.', target: 'self', param: 'none', visibility: 'secret' },
  // ---- sorts réservés aux parties à 3 ou 4 joueurs (ordre des tours) ----
  { id: 'skip', name: 'Saut', desc: 'Le joueur suivant saute son tour.', target: 'own', param: 'none', visibility: 'public', minPlayers: 3 },
  { id: 'doubleskip', name: 'Double saut', desc: 'Les deux joueurs suivants sautent leur tour (à trois, tu rejoues donc tout de suite).', target: 'own', param: 'none', visibility: 'public', minPlayers: 3 },
  { id: 'reverse', name: 'Inversion', desc: 'Inverse le sens de rotation des tours pour le reste de la partie (jusqu’à une autre Inversion).', target: 'own', param: 'none', visibility: 'public', minPlayers: 3 },
  { id: 'relay', name: 'Relais', desc: 'Le joueur que tu désignes joue juste après toi, puis la rotation reprend à partir de lui.', target: 'own', param: 'player', visibility: 'public', minPlayers: 3 },
  { id: 'divert', name: 'Diversion', desc: 'Le joueur suivant est obligé de viser le joueur que tu désignes (si celui-ci est encore en jeu et n’est pas le joueur suivant lui-même).', target: 'own', param: 'player', visibility: 'public', minPlayers: 3 },
  { id: 'silenceall', name: 'Silence général', desc: 'Aucun de tes adversaires ne pourra lancer de sort à son prochain tour.', target: 'own', param: 'none', visibility: 'public', minPlayers: 3 },
];

export const SPELL_IDS: readonly string[] = SPELLS.map((s) => s.id);
const BY_ID: Record<string, SpellDef> = Object.fromEntries(SPELLS.map((s) => [s.id, s]));

export function spellDef(id: string): SpellDef | undefined {
  return Object.prototype.hasOwnProperty.call(BY_ID, id) ? BY_ID[id] : undefined;
}

/** Sorts qui existent dans une partie à `players` joueurs. */
export function spellsFor(players: number): SpellDef[] {
  return SPELLS.filter((s) => (s.minPlayers ?? 2) <= players);
}

/** Sorts dont le lanceur calcule lui-même le résultat (sa grille, l'ordre des tours, son secret). */
export function isOwnSpell(id: string): boolean {
  const d = spellDef(id);
  return !!d && (d.target === 'own' || d.target === 'self');
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
