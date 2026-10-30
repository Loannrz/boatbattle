import { describe, expect, it } from 'vitest';
import { CLASSIC_SET, TRIANGLES_SET } from '../config/pieces';
import { RULES } from '../config/rules';
import { placementParts, type Placement } from './board';
import { checkClaim } from './claim';
import { attackerAt } from './turns';
import { catalogOf } from './pieces';

const classic = catalogOf(CLASSIC_SET);
const board: Placement[] = [
  { pieceId: 'L3.mauve.1', r: 2, c: 2, rot: 0 }, // C3, C4, D4
  { pieceId: 'tri1.mauve.1', r: 7, c: 7, rot: 2 }, // H8, coin NE
  { pieceId: 'barre3.bleu.1', r: 0, c: 5, rot: 1 }, // F1, F2, F3
];
const none = new Set<string>();

describe('déclaration de pièce coulée', () => {
  it('exacte : couleur, forme et cases (ordre libre)', () => {
    expect(checkClaim(board, none, { color: 'mauve', shape: 'L3', cells: [{ r: 3, c: 3 }, { r: 2, c: 2 }, { r: 3, c: 2 }] }, classic)).toEqual({
      ok: true,
      pieceId: 'L3.mauve.1',
    });
  });

  it('fausse si une case est fausse, manque ou est en trop', () => {
    expect(checkClaim(board, none, { color: 'mauve', shape: 'L3', cells: [{ r: 2, c: 2 }, { r: 3, c: 2 }, { r: 3, c: 4 }] }, classic).ok).toBe(false);
    expect(checkClaim(board, none, { color: 'bleu', shape: 'barre3', cells: [{ r: 0, c: 5 }, { r: 1, c: 5 }] }, classic).ok).toBe(false);
    expect(
      checkClaim(board, none, { color: 'bleu', shape: 'barre3', cells: [{ r: 0, c: 5 }, { r: 1, c: 5 }, { r: 2, c: 5 }, { r: 3, c: 5 }] }, classic).ok,
    ).toBe(false);
  });

  it('cases en double refusées', () => {
    expect(checkClaim(board, none, { color: 'bleu', shape: 'barre3', cells: [{ r: 0, c: 5 }, { r: 0, c: 5 }, { r: 1, c: 5 }] }, classic).ok).toBe(false);
  });

  it('fausse si la couleur ou la forme ne correspond pas', () => {
    const cells = [{ r: 0, c: 5 }, { r: 1, c: 5 }, { r: 2, c: 5 }];
    expect(checkClaim(board, none, { color: 'vert', shape: 'barre3', cells }, classic).ok).toBe(false);
    expect(checkClaim(board, none, { color: 'bleu', shape: 'L3', cells }, classic).ok).toBe(false);
  });

  it('petit triangle : la case suffit par défaut, orientation exigée si la règle est activée', () => {
    expect(checkClaim(board, none, { color: 'mauve', shape: 'tri1', cells: [{ r: 7, c: 7, corner: 'SW' }] }, classic).ok).toBe(true);
    const rules = { ...RULES, claimNeedsOrientation: true };
    expect(checkClaim(board, none, { color: 'mauve', shape: 'tri1', cells: [{ r: 7, c: 7, corner: 'SW' }] }, classic, rules).ok).toBe(false);
    expect(checkClaim(board, none, { color: 'mauve', shape: 'tri1', cells: [{ r: 7, c: 7, corner: 'NE' }] }, classic, rules).ok).toBe(true);
  });

  it('grand triangle : toutes les cases exactes, orientation non exigée', () => {
    const cat = catalogOf(TRIANGLES_SET);
    const t3: Placement = { pieceId: 'tri3.bleu.1', r: 4, c: 4, rot: 1 };
    const cells = placementParts(t3, cat);
    expect(cells).toHaveLength(6);
    const plain = cells.map(({ r, c }) => ({ r, c }));
    expect(checkClaim([t3], none, { color: 'bleu', shape: 'tri3', cells: plain }, cat).ok).toBe(true);
    expect(checkClaim([t3], none, { color: 'bleu', shape: 'tri3', cells: plain.slice(1) }, cat).ok).toBe(false);
    // mêmes cases que la bonne orientation, mais en miroir : refusé (cases différentes)
    const mirrored = plain.map(({ r, c }) => ({ r, c: 4 + (6 - c) }));
    expect(checkClaim([t3], none, { color: 'bleu', shape: 'tri3', cells: mirrored }, cat).ok).toBe(false);
  });

  it('plusieurs exemplaires identiques : celui qui occupe les cases est coulé', () => {
    const cat = catalogOf({ id: 'x', name: 'x', shapes: CLASSIC_SET.shapes, entries: [{ shape: 'carre', color: 'rouge', count: 2 }] });
    const ps: Placement[] = [
      { pieceId: 'carre.rouge.1', r: 0, c: 0, rot: 0 },
      { pieceId: 'carre.rouge.2', r: 5, c: 5, rot: 0 },
    ];
    expect(checkClaim(ps, none, { color: 'rouge', shape: 'carre', cells: [{ r: 5, c: 5 }] }, cat)).toEqual({ ok: true, pieceId: 'carre.rouge.2' });
  });

  it('une pièce déjà coulée ne peut plus être déclarée ; déclaration vide refusée', () => {
    expect(checkClaim(board, new Set(['L3.mauve.1']), { color: 'mauve', shape: 'L3', cells: [{ r: 2, c: 2 }, { r: 3, c: 2 }, { r: 3, c: 3 }] }, classic).ok).toBe(false);
    expect(checkClaim(board, none, { color: 'mauve', shape: 'L3', cells: [] }, classic).ok).toBe(false);
  });
});

describe('ordre des tours', () => {
  const shot = { action: { kind: 'shot' }, result: { kind: 'shot' } };
  const good = { action: { kind: 'claim' }, result: { kind: 'claim', ok: true } };
  const bad = { action: { kind: 'claim' }, result: { kind: 'claim', ok: false } };
  it('par défaut, tout coup fait passer la main (déclaration juste comprise)', () => {
    const log = [{ by: 0 as const, ...shot }, { by: 1 as const, ...good }, { by: 0 as const, ...bad }];
    expect([0, 1, 2, 3].map((n) => attackerAt(0, log, n))).toEqual([0, 1, 0, 1]);
  });
  it('règle "rejouer après une déclaration juste"', () => {
    const rules = { ...RULES, correctClaimPassesTurn: false };
    const log = [{ by: 0 as const, ...good }, { by: 0 as const, ...bad }, { by: 1 as const, ...shot }];
    expect([0, 1, 2, 3].map((n) => attackerAt(0, log, n, rules))).toEqual([0, 0, 1, 0]);
  });
});
