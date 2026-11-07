/** Habillage visuel des sorts : résultat sur la grille, effets actifs, petites démonstrations. */

import { COLORS } from '../config/pieces';
import {
  centerCells,
  diagCells,
  halfCells,
  ringCells,
  spellDef,
  zoneCells,
  type Cell,
  type Edge,
} from '../engine';
import type { PlayerSession, TurnEntry } from '../game/session';
import type { Overlay } from './boardView';
import { spellName } from './spellText';

const hex = (c: string | undefined | null) => (c ? COLORS[c]?.hex : undefined);
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const middle = <T,>(a: T[]): T => a[Math.floor(a.length / 2)];

function withText(cells: Cell[], at: Cell | undefined, text: string): { r: number; c: number; text?: string }[] {
  return cells.map((c) => (at && c.r === at.r && c.c === at.c ? { ...c, text } : c));
}

const edgeBand = (e: Edge): Overlay => ({ kind: 'band', axis: e.side === 'top' || e.side === 'bottom' ? 'col' : 'row', index: e.index });

/** Ce qu'un sort lancé montre sur la grille (la même image pour le lanceur et pour la cible). */
export function spellOverlays(e: TurnEntry, selfSpell?: string): Overlay[] {
  const a = e.action;
  const r = e.result;
  if (a.kind !== 'spell' || r.kind !== 'spell') return [];
  const count = r.count ?? 0;
  const at = { r: a.r ?? 0, c: a.c ?? 0 };
  switch (r.spell) {
    case 'reveal':
      return [r.occ ? { kind: 'cells', tone: 'found', cells: [{ ...at, fill: hex(r.colors?.[0]) }] } : { kind: 'cells', tone: 'empty', cells: [at] }];
    case 'loupe': {
      const cells = r.cells ?? [];
      return [
        { kind: 'cells', tone: 'found', cells: cells.filter((x) => x.color).map((x) => ({ r: x.r, c: x.c, fill: hex(x.color) })) },
        { kind: 'cells', tone: 'empty', cells: cells.filter((x) => !x.color) },
      ];
    }
    case 'radar':
      return [{ kind: 'band', axis: a.axis === 'col' ? 'col' : 'row', index: a.index ?? 0, text: String(count) }];
    case 'prisme':
      return [{ kind: 'band', axis: a.axis === 'col' ? 'col' : 'row', index: a.index ?? 0, text: (r.colors ?? []).map((c) => COLORS[c]?.letter ?? '?').join(' ') || '–' }];
    case 'histo':
      return [{ kind: 'bars', axis: a.opt === 'col' ? 'col' : 'row', counts: r.counts ?? [] }];
    case 'sonar': {
      const z = zoneCells(at.r, at.c);
      return [{ kind: 'cells', tone: 'zone', cells: withText(z, at, String(count)) }];
    }
    case 'hint':
      return r.r === undefined || r.c === undefined ? [] : [{ kind: 'cells', tone: 'found', cells: [{ r: r.r, c: r.c, fill: hex(r.colors?.[0]) }] }];
    case 'diag': {
      const d = diagCells(a.opt === 'anti' ? 'anti' : 'main');
      return [{ kind: 'cells', tone: 'zone', cells: withText(d, middle(d), String(count)) }];
    }
    case 'half': {
      const hc = halfCells((a.opt as 'top') ?? 'top');
      return [{ kind: 'cells', tone: 'zone', cells: withText(hc, middle(hc), String(count)) }];
    }
    case 'ring':
      return [{ kind: 'cells', tone: 'zone', cells: ringCells() }, { kind: 'caption', text: plural(count, 'case occupée', 'cases occupées') }];
    case 'center': {
      const cc = centerCells();
      return [{ kind: 'cells', tone: 'zone', cells: withText(cc, cc[5], String(count)) }];
    }
    case 'colorscan':
      return [{ kind: 'caption', text: `${plural(count, 'case', 'cases')} ${(COLORS[a.color ?? '']?.name ?? '').toLowerCase()}` }];
    case 'double':
    case 'salve':
    case 'rafale':
      return (a.edges ?? []).map(edgeBand);
    case 'shuffle':
      return [{ kind: 'glyph', text: '⇄' }, { kind: 'caption', text: 'Grille mélangée : carnet remis à zéro' }];
    case 'revive':
      return [{ kind: 'cells', tone: 'found', cells: (a.cells ?? []).map((x) => ({ r: x.r, c: x.c, fill: hex(a.color) })) }, { kind: 'caption', text: 'Pièce ressuscitée' }];
    case 'spy':
      return [{ kind: 'caption', text: `${plural(count, 'sort', 'sorts')} en réserve` }];
    case 'steal':
      return [{ kind: 'caption', text: r.got ? `Volé : ${spellName(r.got)}` : 'Réserve vide' }];
    case 'sabotage':
      return [{ kind: 'caption', text: r.got ? `Détruit : ${spellName(r.got)}` : 'Réserve vide' }];
    case 'silence':
      return [{ kind: 'caption', text: 'Silence' }];
    case 'freeze':
      return [{ kind: 'caption', text: 'Gel : deux tours de suite' }];
    case 'addpiece':
      return [{ kind: 'caption', text: r.piece ? 'Une pièce de plus' : 'Renfort refusé' }];
    case 'self':
      return [{ kind: 'caption', text: selfSpell ? spellName(selfSpell) : 'Sort secret' }];
    default:
      return [];
  }
}

/** Effets de sorts qui attendent mon prochain tir reçu (ou mon prochain tour). */
export function activeEffects(session: PlayerSession): string[] {
  const { fx, silenced } = session.state;
  const out: string[] = [];
  if (fx.fog) out.push('Brume : le prochain tir ne révélera aucune couleur');
  if (fx.decoy) out.push('Leurre : le prochain tir annoncera une fausse couleur');
  if (fx.mirage) out.push('Mirage : le prochain tir traversera ta grille');
  if (fx.camouflage) out.push('Camouflage : la prochaine déclaration sera refusée');
  if (silenced) out.push('Silence : pas de sort à ce tour');
  return out;
}

// ---------- démonstrations (cartes de la liste des sorts) ----------

const found = (r: number, c: number, fill: string) => ({ r, c, fill });

export function demoOverlays(id: string): Overlay[] {
  const zone = (cells: Cell[], at?: Cell, text?: string): Overlay => ({ kind: 'cells', tone: 'zone', cells: at && text ? withText(cells, at, text) : cells });
  switch (id) {
    case 'reveal':
      return [{ kind: 'cells', tone: 'found', cells: [found(3, 4, '#d9a441')] }, { kind: 'cells', tone: 'empty', cells: [{ r: 6, c: 2 }] }];
    case 'loupe':
      return [{ kind: 'cells', tone: 'found', cells: [found(3, 3, '#4f8fd9'), found(4, 4, '#4f8fd9')] }, { kind: 'cells', tone: 'empty', cells: [{ r: 3, c: 4 }, { r: 4, c: 3 }] }];
    case 'radar':
      return [{ kind: 'band', axis: 'row', index: 4, text: '3' }];
    case 'prisme':
      return [{ kind: 'band', axis: 'col', index: 5, text: 'R B' }];
    case 'histo':
      return [{ kind: 'bars', axis: 'row', counts: [1, 3, 0, 2, 4, 1, 0, 2, 3, 1] }];
    case 'sonar':
      return [zone(zoneCells(4, 4), { r: 4, c: 4 }, '4')];
    case 'hint':
      return [{ kind: 'cells', tone: 'found', cells: [found(6, 2, '#d94f4f')] }];
    case 'diag': {
      const d = diagCells('main');
      return [zone(d, d[5], '3')];
    }
    case 'half': {
      const hc = halfCells('left');
      return [zone(hc, hc[22], '9')];
    }
    case 'ring':
      return [zone(ringCells())];
    case 'center': {
      const cc = centerCells();
      return [zone(cc, cc[5], '5')];
    }
    case 'colorscan':
      return [{ kind: 'caption', text: '5 cases bleues' }];
    case 'double':
      return [{ kind: 'band', axis: 'col', index: 2 }, { kind: 'band', axis: 'row', index: 6 }];
    case 'salve':
      return [3, 4, 5].map((i) => ({ kind: 'band' as const, axis: 'col' as const, index: i }));
    case 'rafale':
      return [2, 3, 4, 5, 6].map((i) => ({ kind: 'band' as const, axis: 'row' as const, index: i }));
    case 'spy':
      return [{ kind: 'caption', text: '3 sorts' }];
    case 'steal':
      return [{ kind: 'glyph', text: '⇠' }];
    case 'sabotage':
      return [{ kind: 'glyph', text: '✂' }];
    case 'silence':
      return [{ kind: 'glyph', text: 'Zz' }];
    case 'freeze':
      return [{ kind: 'glyph', text: '❄' }, { kind: 'caption', text: '2 tours' }];
    case 'addpiece':
      return [{ kind: 'cells', tone: 'found', cells: [found(4, 4, '#6aa86a'), found(4, 5, '#6aa86a'), found(5, 4, '#6aa86a')] }, { kind: 'glyph', text: '+' }];
    case 'shuffle':
      return [{ kind: 'glyph', text: '⇄' }];
    case 'relocate':
      return [{ kind: 'cells', tone: 'found', cells: [found(2, 2, '#d9a441')] }, { kind: 'cells', tone: 'empty', cells: [{ r: 7, c: 7 }] }, { kind: 'glyph', text: '⇢' }];
    case 'pivot':
      return [{ kind: 'cells', tone: 'found', cells: [found(4, 4, '#4f8fd9'), found(4, 5, '#4f8fd9'), found(5, 4, '#4f8fd9')] }, { kind: 'glyph', text: '⟳' }];
    case 'revive':
      return [{ kind: 'cells', tone: 'found', cells: [found(4, 4, '#d94f4f'), found(4, 5, '#d94f4f')] }, { kind: 'glyph', text: '↺' }];
    case 'fog':
      return [{ kind: 'glyph', text: '≈' }];
    case 'decoy':
      return [{ kind: 'glyph', text: '?' }];
    case 'mirage':
      return [{ kind: 'glyph', text: '∅' }];
    case 'camouflage':
      return [{ kind: 'glyph', text: '✕' }];
    case 'draw':
      return [{ kind: 'glyph', text: '+2' }];
    default:
      return spellDef(id) ? [] : [];
  }
}
