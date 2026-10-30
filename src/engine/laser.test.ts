import { describe, expect, it } from 'vitest';
import { CLASSIC_SET, TRIANGLES_SET } from '../config/pieces';
import { RULES } from '../config/rules';
import { buildGrid, randomPlacement, seededRandom, type Grid, type Placement } from './board';
import { edgeLabel, sameEdge, type Corner, type Edge, type Rotation, type Side } from './geometry';
import { traceLaser } from './laser';
import { catalogOf, triangleParts, type PieceSet } from './pieces';

const N = 10;
const empty = (): Grid => Array.from({ length: N }, () => Array(N).fill(null));
const block = (g: Grid, r: number, c: number, id: string) => (g[r][c] = { pieceId: id });
const tri = (g: Grid, r: number, c: number, corner: Corner, id: string) => (g[r][c] = { pieceId: id, corner });
const E = (side: Side, index: number): Edge => ({ side, index });
const ALL_EDGES: Edge[] = [];
for (const side of ['top', 'bottom', 'left', 'right'] as Side[]) for (let i = 0; i < N; i++) ALL_EDGES.push(E(side, i));

describe('laser : grille vide', () => {
  it('traverse et ressort au bord opposé', () => {
    const res = traceLaser(empty(), E('top', 1));
    expect(res.exit).toEqual(E('bottom', 1));
    expect(res.hits).toEqual([]);
    expect(edgeLabel(E('top', 1))).toBe('B haut');
    expect(edgeLabel(res.exit)).toBe('B bas');
  });

  it('"10 gauche" ressort en "10 droite"', () => {
    expect(edgeLabel(E('left', 9))).toBe('10 gauche');
    expect(traceLaser(empty(), E('left', 9)).exit).toEqual(E('right', 9));
  });

  it('chaque bord ressort en face', () => {
    for (let i = 0; i < N; i++) {
      expect(traceLaser(empty(), E('top', i)).exit).toEqual(E('bottom', i));
      expect(traceLaser(empty(), E('bottom', i)).exit).toEqual(E('top', i));
      expect(traceLaser(empty(), E('left', i)).exit).toEqual(E('right', i));
      expect(traceLaser(empty(), E('right', i)).exit).toEqual(E('left', i));
    }
  });
});

describe('laser : face plate', () => {
  it('repart par où il est entré et annonce la pièce', () => {
    const g = empty();
    block(g, 4, 1, 'a');
    const res = traceLaser(g, E('top', 1));
    expect(res.exit).toEqual(E('top', 1));
    expect(res.hits).toEqual(['a']);
    expect(res.path).toEqual([
      { x: 1.5, y: 0 },
      { x: 1.5, y: 4 },
      { x: 1.5, y: 0 },
    ]);
  });

  it('pièce collée au bord : rebond immédiat', () => {
    const g = empty();
    block(g, 9, 0, 'b');
    expect(traceLaser(g, E('left', 9))).toMatchObject({ exit: E('left', 9), hits: ['b'] });
    expect(traceLaser(g, E('bottom', 0))).toMatchObject({ exit: E('bottom', 0), hits: ['b'] });
  });

  it('seule la première pièce rencontrée est touchée', () => {
    const g = empty();
    block(g, 5, 2, 'a');
    block(g, 5, 7, 'b');
    expect(traceLaser(g, E('left', 5)).hits).toEqual(['a']);
    expect(traceLaser(g, E('right', 5)).hits).toEqual(['b']);
  });
});

describe('laser : petit triangle (demi-case), 4 orientations x 4 directions', () => {
  const shots = { S: E('top', 4), N: E('bottom', 4), E: E('left', 4), W: E('right', 4) };
  const exitFor = { N: E('top', 4), S: E('bottom', 4), E: E('right', 4), W: E('left', 4) };
  const table: Record<Corner, Record<'S' | 'N' | 'E' | 'W', 'N' | 'S' | 'E' | 'W' | 'retour'>> = {
    SW: { S: 'E', W: 'N', N: 'retour', E: 'retour' },
    NW: { N: 'E', W: 'S', S: 'retour', E: 'retour' },
    NE: { N: 'W', E: 'S', S: 'retour', W: 'retour' },
    SE: { S: 'W', E: 'N', N: 'retour', W: 'retour' },
  };
  for (const corner of Object.keys(table) as Corner[]) {
    for (const incoming of ['S', 'N', 'E', 'W'] as const) {
      const expected = table[corner][incoming];
      it(`demi-case ${corner}, laser allant vers ${incoming} -> ${expected}`, () => {
        const g = empty();
        tri(g, 4, 4, corner, 't');
        const res = traceLaser(g, shots[incoming]);
        expect(res.hits).toEqual(['t']);
        if (expected === 'retour') {
          expect(res.exit).toEqual(shots[incoming]);
          expect(res.events[0].kind).toBe('face');
        } else {
          expect(res.exit).toEqual(exitFor[expected]);
          expect(res.events[0].kind).toBe('miroir');
          expect(res.path[1]).toEqual({ x: 4.5, y: 4.5 });
        }
      });
    }
  }

  it('ne pas annoncer les déviations si la règle est désactivée', () => {
    const g = empty();
    tri(g, 4, 4, 'SW', 't');
    const res = traceLaser(g, E('top', 4), { ...RULES, announceDeflections: false });
    expect(res.exit).toEqual(E('right', 4));
    expect(res.hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Grands triangles : comparaison avec un ORACLE géométrique indépendant.
// L'oracle lance un vrai rayon (coordonnées continues) contre le polygone du
// triangle : côtés de l'angle droit = retour, diagonale = réflexion à 90°.
// ---------------------------------------------------------------------------

type Pt = { x: number; y: number };

function trianglePolygon(r0: number, c0: number, n: number, corner: Corner) {
  const box: Record<Corner, Pt> = {
    NW: { x: c0, y: r0 },
    NE: { x: c0 + n, y: r0 },
    SE: { x: c0 + n, y: r0 + n },
    SW: { x: c0, y: r0 + n },
  };
  const opposite: Record<Corner, Corner> = { SW: 'NE', NE: 'SW', NW: 'SE', SE: 'NW' };
  const others = (Object.keys(box) as Corner[]).filter((k) => k !== corner && k !== opposite[corner]);
  const k = box[corner];
  const a = box[others[0]];
  const b = box[others[1]];
  return {
    legs: [
      [k, a],
      [k, b],
    ] as [Pt, Pt][],
    hyp: [a, b] as [Pt, Pt],
  };
}

function intersect(p: Pt, d: Pt, [a, b]: [Pt, Pt]): { t: number; pt: Pt } | null {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const den = d.x * ey - d.y * ex;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((a.x - p.x) * ey - (a.y - p.y) * ex) / den;
  const s = ((a.x - p.x) * d.y - (a.y - p.y) * d.x) / den;
  if (t <= 1e-9 || s < -1e-9 || s > 1 + 1e-9) return null;
  return { t, pt: { x: p.x + t * d.x, y: p.y + t * d.y } };
}

function exitFrom(p: Pt, d: Pt): Edge {
  if (d.y < 0) return E('top', Math.floor(p.x));
  if (d.y > 0) return E('bottom', Math.floor(p.x));
  if (d.x < 0) return E('left', Math.floor(p.y));
  return E('right', Math.floor(p.y));
}

/** Oracle : un seul triangle sur une grille vide. */
function oracle(r0: number, c0: number, n: number, corner: Corner, entry: Edge) {
  const start: Record<Side, { p: Pt; d: Pt }> = {
    // le rayon part d'une case à l'extérieur de la grille
    top: { p: { x: entry.index + 0.5, y: -1 }, d: { x: 0, y: 1 } },
    bottom: { p: { x: entry.index + 0.5, y: N + 1 }, d: { x: 0, y: -1 } },
    left: { p: { x: -1, y: entry.index + 0.5 }, d: { x: 1, y: 0 } },
    right: { p: { x: N + 1, y: entry.index + 0.5 }, d: { x: -1, y: 0 } },
  };
  const { p, d } = start[entry.side];
  const poly = trianglePolygon(r0, c0, n, corner);
  const hits = [...poly.legs.map((s) => ({ s, kind: 'leg' as const })), { s: poly.hyp, kind: 'hyp' as const }]
    .map((x) => ({ ...x, i: intersect(p, d, x.s) }))
    .filter((x) => x.i)
    .sort((a, b) => a.i!.t - b.i!.t);
  if (hits.length === 0) return { exit: exitFrom(p, d), hit: false, point: null };
  const first = hits[0];
  if (first.kind === 'leg') return { exit: entry, hit: true, point: first.i!.pt };
  // réflexion sur la diagonale : d' = 2(d.u)u - d
  const [a, b] = poly.hyp;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const dot = d.x * u.x + d.y * u.y;
  const nd = { x: Math.round(2 * dot * u.x - d.x), y: Math.round(2 * dot * u.y - d.y) };
  return { exit: exitFrom(first.i!.pt, nd), hit: true, point: first.i!.pt };
}

const triSet = (n: number): PieceSet => ({
  id: 't',
  name: 't',
  shapes: [{ id: `tri${n}`, name: 'T', parts: triangleParts(n) }],
  entries: [{ shape: `tri${n}`, color: 'bleu', count: 1 }],
});
const CORNER_OF_ROT: Corner[] = ['SW', 'NW', 'NE', 'SE'];

describe('laser : grands triangles (côté 1 à 4) contre l’oracle géométrique', () => {
  for (let n = 1; n <= 4; n++) {
    for (let rot = 0 as Rotation; rot < 4; rot++) {
      it(`triangle de côté ${n}, rotation ${rot * 90}° (${CORNER_OF_ROT[rot]}) : 40 bords x 4 positions`, () => {
        const cat = catalogOf(triSet(n));
        const id = cat.pieces[0].id;
        const anchors = [
          [0, 0],
          [3, 2],
          [N - n, N - n],
          [1, N - n],
        ];
        let deflections = 0;
        for (const [r0, c0] of anchors) {
          const grid = buildGrid([{ pieceId: id, r: r0, c: c0, rot: rot as Rotation }], cat);
          // la forme occupe bien n(n-1)/2 cases pleines + n demi-cases dans un carré n x n
          const occ = grid.flat().filter(Boolean);
          expect(occ.length).toBe((n * (n + 1)) / 2);
          expect(occ.filter((o) => o!.corner).length).toBe(n);
          expect(occ.filter((o) => o!.corner).every((o) => o!.corner === CORNER_OF_ROT[rot])).toBe(true);
          for (const edge of ALL_EDGES) {
            const want = oracle(r0, c0, n, CORNER_OF_ROT[rot], edge);
            const got = traceLaser(grid, edge);
            expect(got.exit, `${edgeLabel(edge)} @${r0},${c0}`).toEqual(want.exit);
            expect(got.hits).toEqual(want.hit ? [id] : []);
            if (want.point) expect(got.path[1]).toEqual(want.point);
            if (got.events.some((e) => e.kind === 'miroir')) deflections++;
          }
        }
        expect(deflections).toBeGreaterThan(0);
      });
    }
  }

  it('longe la diagonale sans la toucher : passe dans les cases vides au-dessus', () => {
    const cat = catalogOf(triSet(4));
    const id = cat.pieces[0].id;
    // triangle SW de côté 4 en A1 : cases vides au-dessus de la diagonale (ex. D1, D2, D3)
    const grid = buildGrid([{ pieceId: id, r: 0, c: 0, rot: 0 }], cat);
    expect(grid[0][3]).toBeNull();
    // colonne D depuis le haut : D1, D2, D3 vides, puis D4 = demi-case -> miroir, part à droite
    const res = traceLaser(grid, E('top', 3));
    expect(res.exit).toEqual(E('right', 3));
    expect(res.path).toEqual([
      { x: 3.5, y: 0 },
      { x: 3.5, y: 3.5 },
      { x: 10, y: 3.5 },
    ]);
    // ligne 1 depuis la droite : J1..B1 vides, puis A1 = demi-case par son côté ouvert -> monte
    expect(traceLaser(grid, E('right', 0)).exit).toEqual(E('top', 0));
    // ligne 4 depuis la gauche : A4 est une case pleine -> retour
    expect(traceLaser(grid, E('left', 3))).toMatchObject({ exit: E('left', 3), hits: [id] });
  });

  it('chaîne : deux grands triangles se renvoient le laser', () => {
    const set: PieceSet = {
      id: 'c',
      name: 'c',
      shapes: [
        { id: 'tri3', name: 'T3', parts: triangleParts(3) },
        { id: 'tri2', name: 'T2', parts: triangleParts(2) },
      ],
      entries: [
        { shape: 'tri3', color: 'bleu', count: 1 },
        { shape: 'tri2', color: 'rouge', count: 1 },
      ],
    };
    const cat = catalogOf(set);
    const [big, small] = cat.pieces.map((p) => p.id);
    // grand triangle SW en A1..C3, petit triangle NE (rotation 2) en H1..I2
    const grid = buildGrid(
      [
        { pieceId: big, r: 0, c: 0, rot: 0 },
        { pieceId: small, r: 0, c: 7, rot: 2 },
      ],
      cat,
    );
    // B haut : descend, B2 est sur la diagonale du grand -> part à droite ligne 2,
    // arrive dans I2, demi-case NE par son côté ouvert gauche -> descend colonne I
    const res = traceLaser(grid, E('top', 1));
    expect(res.hits).toEqual([big, small]);
    expect(res.exit).toEqual(E('bottom', 8));
    // et le trajet inverse revient au point de départ
    expect(traceLaser(grid, res.exit).exit).toEqual(E('top', 1));
  });
});

describe('laser : chaînes de demi-cases', () => {
  const chain = () => {
    const g = empty();
    tri(g, 3, 2, 'SW', 't1');
    tri(g, 3, 7, 'NE', 't2');
    return g;
  };

  it('deux miroirs : sort par un autre bord', () => {
    const res = traceLaser(chain(), E('top', 2));
    expect(res.exit).toEqual(E('bottom', 7));
    expect(res.hits).toEqual(['t1', 't2']);
  });

  it('deux miroirs puis face plate : revient, chaque pièce annoncée une fois', () => {
    const g = chain();
    block(g, 8, 7, 'b');
    const res = traceLaser(g, E('top', 2));
    expect(res.exit).toEqual(E('top', 2));
    expect(res.hits).toEqual(['t1', 't2', 'b']);
    expect(res.events.map((e) => e.pieceId)).toEqual(['t1', 't2', 'b', 't2', 't1']);
  });

  it('sans dédoublonnage, les pièces repassées sont réannoncées', () => {
    const g = chain();
    block(g, 8, 7, 'b');
    expect(traceLaser(g, E('top', 2), { ...RULES, countEachPieceOnce: false }).hits).toEqual(['t1', 't2', 'b', 't2', 't1']);
  });

  it('trois miroirs à la suite : ressort par un troisième bord', () => {
    const g = empty();
    tri(g, 2, 5, 'NE', 'a');
    tri(g, 6, 5, 'SE', 'b');
    tri(g, 6, 1, 'SW', 'c');
    const res = traceLaser(g, E('left', 2));
    expect(res.hits).toEqual(['a', 'b', 'c']);
    expect(res.exit).toEqual(E('top', 1));
  });
});

describe('laser : propriétés sur des plateaux aléatoires', () => {
  for (const set of [CLASSIC_SET, TRIANGLES_SET]) {
    it(`jeu ${set.name} : tout tir ressort et le trajet inverse ramène au départ (30 plateaux x 40 bords)`, () => {
      const cat = catalogOf(set);
      for (let s = 1; s <= 30; s++) {
        const grid = buildGrid(randomPlacement(cat, { random: seededRandom(s) }), cat);
        for (const edge of ALL_EDGES) {
          const res = traceLaser(grid, edge);
          expect(res.exit.index).toBeGreaterThanOrEqual(0);
          expect(res.exit.index).toBeLessThan(N);
          const back = traceLaser(grid, res.exit);
          expect(sameEdge(back.exit, edge)).toBe(true);
          expect(new Set(back.hits)).toEqual(new Set(res.hits));
        }
      }
    });
  }

  it('une pièce coulée (retirée) est traversée, grand triangle compris', () => {
    const cat = catalogOf(triSet(4));
    const id = cat.pieces[0].id;
    const ps: Placement[] = [{ pieceId: id, r: 3, c: 3, rot: 1 }];
    let hitsSomething = 0;
    const sunkGrid = buildGrid(ps, cat, new Set([id]));
    for (const edge of ALL_EDGES) {
      if (traceLaser(buildGrid(ps, cat), edge).hits.length) hitsSomething++;
      const res = traceLaser(sunkGrid, edge);
      expect(res.hits).toEqual([]);
      expect(traceLaser(empty(), edge).exit).toEqual(res.exit);
    }
    expect(hitsSomething).toBeGreaterThan(0);
  });
});
