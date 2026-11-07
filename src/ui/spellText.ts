/** Textes français des sorts (historique, notifications). */

import { COLORS } from '../config/pieces';
import { COL_LABELS, cellLabel, edgeLabel, spellDef, type Catalog } from '../engine';
import type { TurnEntry } from '../game/session';

export function spellName(id: string): string {
  return id === 'self' ? 'Sort secret' : (spellDef(id)?.name ?? id);
}

const colorName = (c: string) => (COLORS[c]?.name ?? c).toLowerCase();
const colorList = (cs: string[] | undefined) => (cs && cs.length ? cs.map(colorName).join(', ') : 'aucune couleur');
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Description courte d'un tour « sort ». `selfSpell` = sort secret lancé par moi (connu de moi seul). */
export function describeSpell(e: TurnEntry, catalog: Catalog | null, selfSpell?: string): string {
  const a = e.action;
  const r = e.result;
  if (a.kind !== 'spell' || r.kind !== 'spell') return '';
  const cells = (n: number | undefined) => plural(n ?? 0, 'case occupée', 'cases occupées');
  switch (r.spell) {
    case 'self':
      return selfSpell ? `Sort secret : ${spellName(selfSpell)}` : 'Lance un sort secret';
    case 'reveal':
      return `Révélation en ${cellLabel({ r: a.r ?? 0, c: a.c ?? 0 })} : ${r.occ ? `occupée (${colorList(r.colors)})` : 'vide'}`;
    case 'radar':
      return `Radar ${a.axis === 'col' ? `colonne ${COL_LABELS[a.index ?? 0]}` : `ligne ${(a.index ?? 0) + 1}`} : ${cells(r.count)}`;
    case 'prisme':
      return `Prisme ${a.axis === 'col' ? `colonne ${COL_LABELS[a.index ?? 0]}` : `ligne ${(a.index ?? 0) + 1}`} : ${colorList(r.colors)}`;
    case 'sonar':
      return `Sonar autour de ${cellLabel({ r: a.r ?? 0, c: a.c ?? 0 })} : ${cells(r.count)} (${colorList(r.colors)})`;
    case 'hint':
      return r.r === undefined || r.c === undefined ? 'Indice : rien à révéler' : `Indice : une case occupée en ${cellLabel({ r: r.r, c: r.c })} (${colorList(r.colors)})`;
    case 'diag':
      return `Diagonale ${a.opt === 'anti' ? '↗' : '↘'} : ${cells(r.count)}`;
    case 'half': {
      const name = { top: 'haut', bottom: 'bas', left: 'gauche', right: 'droite' }[a.opt as 'top'] ?? '';
      return `Moitié ${name} : ${cells(r.count)}`;
    }
    case 'colorscan':
      return `Détecteur ${a.color ? colorName(a.color) : ''} : ${plural(r.count ?? 0, 'case', 'cases')}`;
    case 'double':
    case 'salve':
    case 'rafale': {
      const shots = (r.shots ?? []).map((s, i) => `${edgeLabel(a.edges?.[i] ?? s.exit)} → ${edgeLabel(s.exit)} (${s.colors.length ? s.colors.map(colorName).join(', ') : 'rien'})`);
      return `${spellName(r.spell)} : ${shots.join(' · ')}`;
    }
    case 'loupe': {
      const cs = (r.cells ?? []).map((x) => `${cellLabel(x)} ${x.color ? colorName(x.color) : 'vide'}`);
      return `Loupe : ${cs.join(' · ')}`;
    }
    case 'histo': {
      const names = a.opt === 'col' ? COL_LABELS : Array.from({ length: (r.counts ?? []).length }, (_, i) => String(i + 1));
      return `Histogramme ${a.opt === 'col' ? 'des colonnes' : 'des lignes'} : ${(r.counts ?? []).map((n, i) => `${names[i]}=${n}`).join(' ')}`;
    }
    case 'ring':
      return `Périmètre : ${cells(r.count)}`;
    case 'center':
      return `Centre : ${cells(r.count)}`;
    case 'spy':
      return `Espion : ${plural(r.count ?? 0, 'sort', 'sorts')} en réserve`;
    case 'sabotage':
      return r.got ? `Sabotage : ${spellName(r.got)} détruit` : 'Sabotage : réserve vide';
    case 'addpiece': {
      if (!r.piece) return 'Renfort : refusé';
      const shape = catalog?.shapes[r.piece.shape]?.name ?? r.piece.shape;
      return `Renfort : une pièce de plus (${shape} ${colorName(r.piece.color)})`;
    }
    case 'revive': {
      const shape = catalog?.shapes[a.shape ?? '']?.name ?? a.shape ?? 'pièce';
      return `Résurrection : ${shape} ${a.color ? colorName(a.color) : ''} revient en jeu en ${(a.cells ?? []).map(cellLabel).join(', ')}`;
    }
    case 'steal':
      return r.got ? `Vol de sort : ${spellName(r.got)} volé` : 'Vol de sort : réserve vide';
    case 'silence':
      return 'Silence : pas de sort au prochain tour';
    case 'freeze':
      return 'Gel : joue deux tours de suite';
    default:
      return spellName(r.spell);
  }
}
