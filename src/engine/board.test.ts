import { describe, expect, it } from 'vitest';
import { BUILTIN_SETS, CLASSIC_SET, COLOR_IDS, TRIANGLES_SET } from '../config/pieces';
import { RULES } from '../config/rules';
import { buildGrid, catalogFits, placementCells, placementParts, randomPlacement, validatePlacement, type Placement } from './board';
import { rotateParts, rotationCount } from './geometry';
import { catalogOf, isConnected, pieceSetErrors, setHash, shapeError, triangleParts, type PieceSet, type ShapeDef } from './pieces';

const classic = catalogOf(CLASSIC_SET);
const id = (shape: string, color: string) => `${shape}.${color}.1`;

describe('formes et rotations', () => {
  it('le L tourne dans le sens horaire', () => {
    const L = CLASSIC_SET.shapes.find((s) => s.id === 'L3')!;
    expect(rotateParts(L.parts, 0)).toEqual([{ r: 0, c: 0 }, { r: 1, c: 0 }, { r: 1, c: 1 }]);
    expect(rotateParts(L.parts, 1)).toEqual(expect.arrayContaining([{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 1, c: 0 }]));
  });

  it('les coins des demi-cases tournent avec la forme', () => {
    expect(rotateParts([{ r: 0, c: 0, corner: 'SW' }], 1)).toEqual([{ r: 0, c: 0, corner: 'NW' }]);
    expect(rotateParts([{ r: 0, c: 0, corner: 'SW' }], 2)).toEqual([{ r: 0, c: 0, corner: 'NE' }]);
    expect(rotateParts([{ r: 0, c: 0, corner: 'SW' }], 3)).toEqual([{ r: 0, c: 0, corner: 'SE' }]);
  });

  it('triangle de côté n : forme en escalier, diagonale en demi-cases', () => {
    for (let n = 1; n <= 4; n++) {
      const parts = triangleParts(n);
      expect(parts).toHaveLength((n * (n + 1)) / 2);
      expect(parts.filter((p) => p.corner === 'SW').map((p) => [p.r, p.c])).toEqual(Array.from({ length: n }, (_, i) => [i, i]));
      expect(parts.filter((p) => !p.corner).every((p) => p.r > p.c)).toBe(true);
      expect(isConnected(parts)).toBe(true);
      expect(rotationCount(parts)).toBe(4);
    }
    // côté 3 :  ◣ . .
    //           ■ ◣ .
    //           ■ ■ ◣
    expect(triangleParts(3)).toEqual([
      { r: 0, c: 0, corner: 'SW' },
      { r: 1, c: 0 },
      { r: 1, c: 1, corner: 'SW' },
      { r: 2, c: 0 },
      { r: 2, c: 1 },
      { r: 2, c: 2, corner: 'SW' },
    ]);
  });

  it('nombre d’orientations distinctes', () => {
    const rc = (sid: string) => rotationCount([...CLASSIC_SET.shapes, ...TRIANGLES_SET.shapes].find((s) => s.id === sid)!.parts);
    expect(rc('carre')).toBe(1);
    expect(rc('barre2')).toBe(2);
    expect(rc('barre3')).toBe(2);
    expect(rc('L3')).toBe(4);
    expect(rc('tri1')).toBe(4);
  });

  it('barre 3 verticale', () => {
    expect(placementCells({ pieceId: id('barre3', 'bleu'), r: 2, c: 5, rot: 1 }, classic)).toEqual([
      { r: 2, c: 5 },
      { r: 3, c: 5 },
      { r: 4, c: 5 },
    ]);
  });
});

describe('validation des formes (éditeur)', () => {
  const sh = (parts: ShapeDef['parts'], name = 'Ma forme'): ShapeDef => ({ id: 'f1', name, parts });
  it('forme valide, avec demi-cases reliées par leurs côtés pleins', () => {
    expect(shapeError(sh([{ r: 0, c: 0 }, { r: 0, c: 1, corner: 'SW' }]))).toBeNull(); // côté W de la demi-case est plein
  });
  it('demi-case reliée par son côté ouvert : non connexe', () => {
    expect(shapeError(sh([{ r: 0, c: 0 }, { r: 0, c: 1, corner: 'NE' }]))).toMatch(/seul tenant/); // côté W de NE est ouvert
  });
  it('deux demi-cases qui ne se touchent que par un coin : non connexe', () => {
    expect(shapeError(sh([{ r: 0, c: 0, corner: 'SE' }, { r: 1, c: 1, corner: 'NW' }]))).toMatch(/seul tenant/);
  });
  it('vide, trop grande, doublon, non normalisée, nom vide', () => {
    expect(shapeError(sh([]))).toMatch(/vide/);
    expect(shapeError(sh(Array.from({ length: 6 }, (_, c) => ({ r: 0, c }))))).toMatch(/5 × 5/);
    expect(shapeError(sh([{ r: 0, c: 0 }, { r: 0, c: 0 }]))).toMatch(/même case/);
    expect(shapeError(sh([{ r: 1, c: 1 }]))).toMatch(/normalisée/);
    expect(shapeError(sh([{ r: 0, c: 0 }], ''))).toMatch(/Nom/);
    expect(shapeError(sh([{ r: 0, c: 0, corner: 'XX' as never }]))).toMatch(/Demi-case/);
  });
});

describe('validation des jeux de pièces', () => {
  const fits = (c: ReturnType<typeof catalogOf>) => catalogFits(c);
  it('les jeux prédéfinis sont valides et ont des empreintes différentes', () => {
    for (const set of BUILTIN_SETS) expect(pieceSetErrors(set, COLOR_IDS, fits)).toEqual([]);
    expect(setHash(CLASSIC_SET)).not.toBe(setHash(TRIANGLES_SET));
    // le nom ne change pas l'empreinte, la géométrie si
    expect(setHash({ ...CLASSIC_SET, name: 'Autre' })).toBe(setHash(CLASSIC_SET));
    expect(setHash({ ...CLASSIC_SET, entries: CLASSIC_SET.entries.slice(1) })).not.toBe(setHash(CLASSIC_SET));
  });

  const base = (): PieceSet => JSON.parse(JSON.stringify(CLASSIC_SET));
  it('refuse couleur inconnue (y compris __proto__), forme inconnue, nombre invalide', () => {
    const a = base();
    a.entries[0].color = '__proto__';
    expect(pieceSetErrors(a, COLOR_IDS, fits)[0]).toMatch(/couleur/);
    const b = base();
    b.entries[0].shape = 'constructor';
    expect(pieceSetErrors(b, COLOR_IDS, fits)[0]).toMatch(/forme inconnue/);
    const c = base();
    c.entries[0].count = 0;
    expect(pieceSetErrors(c, COLOR_IDS, fits)[0]).toMatch(/exemplaires/);
    const d = base();
    d.entries.push({ ...d.entries[0] });
    expect(pieceSetErrors(d, COLOR_IDS, fits)[0]).toMatch(/deux fois/);
  });

  it('refuse un jeu trop grand ou qui ne tient pas sur la grille', () => {
    const big: PieceSet = { id: 'g', name: 'Gros', shapes: TRIANGLES_SET.shapes, entries: [{ shape: 'tri4', color: 'bleu', count: 6 }] };
    expect(pieceSetErrors(big, COLOR_IDS, fits).join(' ')).toMatch(/trop de cases/);
    expect(pieceSetErrors(CLASSIC_SET, COLOR_IDS, () => false)[0]).toMatch(/Impossible de placer/);
    expect(pieceSetErrors(null, COLOR_IDS, fits)).toHaveLength(1);
    expect(pieceSetErrors({ ...base(), entries: [] }, COLOR_IDS, fits)[0]).toMatch(/aucune pièce/);
  });
});

describe('validation du placement', () => {
  it('placement valide (pièces qui se touchent autorisées par défaut)', () => {
    const ps: Placement[] = [
      { pieceId: id('barre3', 'bleu'), r: 0, c: 0, rot: 0 },
      { pieceId: id('L3', 'mauve'), r: 1, c: 0, rot: 0 },
    ];
    expect(validatePlacement(ps, classic)).toEqual([]);
  });

  it('hors grille', () => {
    expect(validatePlacement([{ pieceId: id('barre3', 'bleu'), r: 0, c: 8, rot: 0 }], classic)[0].kind).toBe('out-of-bounds');
    expect(validatePlacement([{ pieceId: id('carre', 'rouge'), r: -1, c: 0, rot: 0 }], classic)[0].kind).toBe('out-of-bounds');
    expect(validatePlacement([{ pieceId: id('barre3', 'bleu'), r: 8, c: 0, rot: 1 }], classic)[0].kind).toBe('out-of-bounds');
  });

  it('chevauchement interdit, y compris deux demi-cases complémentaires dans une même case', () => {
    expect(
      validatePlacement(
        [
          { pieceId: id('barre3', 'bleu'), r: 3, c: 3, rot: 0 },
          { pieceId: id('tri1', 'rouge'), r: 3, c: 5, rot: 2 },
        ],
        classic,
      )[0].kind,
    ).toBe('overlap');
    expect(
      validatePlacement(
        [
          { pieceId: id('tri1', 'rouge'), r: 3, c: 3, rot: 0 }, // SW
          { pieceId: id('tri1', 'bleu'), r: 3, c: 3, rot: 2 }, // NE
        ],
        classic,
      )[0].kind,
    ).toBe('overlap');
  });

  it('grand triangle : toutes ses cases comptent', () => {
    const cat = catalogOf(TRIANGLES_SET);
    const t4 = id('tri4', 'mauve');
    expect(placementParts({ pieceId: t4, r: 0, c: 0, rot: 0 }, cat)).toHaveLength(10);
    expect(validatePlacement([{ pieceId: t4, r: 7, c: 0, rot: 0 }], cat)[0].kind).toBe('out-of-bounds');
    expect(
      validatePlacement(
        [
          { pieceId: t4, r: 0, c: 0, rot: 0 },
          { pieceId: id('carre', 'turquoise'), r: 3, c: 2, rot: 0 }, // sous la diagonale = case pleine du triangle
        ],
        cat,
      )[0].kind,
    ).toBe('overlap');
    expect(
      validatePlacement(
        [
          { pieceId: t4, r: 0, c: 0, rot: 0 },
          { pieceId: id('carre', 'turquoise'), r: 0, c: 3, rot: 0 }, // au-dessus de la diagonale = libre
        ],
        cat,
      ),
    ).toEqual([]);
  });

  it('pièce inconnue, doublon, manquantes, contact interdit par règle', () => {
    expect(validatePlacement([{ pieceId: 'licorne', r: 0, c: 0, rot: 0 }], classic)[0].kind).toBe('unknown-piece');
    expect(
      validatePlacement(
        [
          { pieceId: id('carre', 'rouge'), r: 0, c: 0, rot: 0 },
          { pieceId: id('carre', 'rouge'), r: 5, c: 5, rot: 0 },
        ],
        classic,
      ),
    ).toEqual([{ kind: 'duplicate', pieceId: id('carre', 'rouge') }]);
    expect(validatePlacement([], classic, { requireAll: true })).toHaveLength(12);
    const touching: Placement[] = [
      { pieceId: id('carre', 'rouge'), r: 0, c: 0, rot: 0 },
      { pieceId: id('carre', 'orange'), r: 0, c: 1, rot: 0 },
    ];
    expect(validatePlacement(touching, classic, { rules: { ...RULES, allowTouchingPieces: false } })[0].kind).toBe('touching');
  });

  it('exemplaires multiples : chaque exemplaire est une pièce distincte', () => {
    const set: PieceSet = { id: 'x', name: 'x', shapes: CLASSIC_SET.shapes, entries: [{ shape: 'barre2', color: 'vert', count: 3 }] };
    const cat = catalogOf(set);
    expect(cat.pieces.map((p) => p.id)).toEqual(['barre2.vert.1', 'barre2.vert.2', 'barre2.vert.3']);
    expect(validatePlacement(randomPlacement(cat), cat, { requireAll: true })).toEqual([]);
  });

  it('placement aléatoire complet et valide pour chaque jeu prédéfini', () => {
    for (const set of BUILTIN_SETS) {
      const cat = catalogOf(set);
      for (let i = 0; i < 20; i++) {
        const ps = randomPlacement(cat);
        expect(validatePlacement(ps, cat, { requireAll: true })).toEqual([]);
        const total = cat.pieces.reduce((n, p) => n + cat.shapes[p.shape].parts.length, 0);
        expect(buildGrid(ps, cat).flat().filter(Boolean).length).toBe(total);
      }
    }
  });
});
