/**
 * Rendu SVG façon papier : grille au crayon, pièces en papier coloré mat, fil rouge.
 * Unité : 10 par case. Avec gouttière, la grille est entourée d'une marge
 * (étiquettes A..J / 1..10, ou bords cliquables pour viser).
 */

import { COLORS, type PatternId } from '../config/pieces';
import {
  COL_LABELS,
  GRID_SIZE,
  cellKey,
  pieceDef,
  placementParts,
  type Catalog,
  type Cell,
  type Edge,
  type Part,
  type Placement,
} from '../engine';
import type { NoteMark } from '../game/session';
import { h, s } from './dom';

const U = 10;
const N = GRID_SIZE;

export type PieceStyle = 'normal' | 'selected' | 'sunk' | 'guess' | 'ghost-ok' | 'ghost-bad';

export interface BoardPiece extends Placement {
  style?: PieceStyle;
}

export interface EdgeShade {
  edge: Edge;
  kind: 'in' | 'out' | 'in-last' | 'out-last' | 'both-last';
}

/** Habillage visuel d'un sort sur la grille. */
export type Overlay =
  | { kind: 'cells'; cells: { r: number; c: number; fill?: string; text?: string }[]; tone: 'zone' | 'found' | 'empty' }
  | { kind: 'band'; axis: 'row' | 'col'; index: number; text?: string }
  | { kind: 'bars'; axis: 'row' | 'col'; counts: number[] }
  | { kind: 'caption'; text: string }
  | { kind: 'glyph'; text: string };

export interface BoardOptions {
  catalog: Catalog | null;
  gutter: 'labels' | 'buttons' | 'none';
  pieces?: BoardPiece[];
  marks?: Record<string, NoteMark>;
  paths?: { points: { x: number; y: number }[]; dim?: boolean }[];
  edgeShades?: EdgeShade[];
  overlays?: Overlay[];
  selectedEdge?: Edge | null;
  label: string;
  description?: string;
  className?: string;
}

export interface BoardView {
  root: HTMLElement;
  svg: SVGSVGElement;
  /** Case sous le doigt ; -1 ou N dans la marge ; null hors du plateau ou dans un coin. */
  rawCellAt(clientX: number, clientY: number): Cell | null;
  unitPx(): number;
  gridOrigin(): { left: number; top: number };
  setPreview(piece: BoardPiece | null): void;
}

// ---------- définitions partagées (motifs, ombre) ----------

export function installPatternDefs(): void {
  if (document.getElementById('bb-defs')) return;
  const ink = '#1c1a17';
  const sw = 0.45;
  const pat = (id: PatternId, size: number, ...children: SVGElement[]) =>
    s('pattern', { id: `pat-${id}`, patternUnits: 'userSpaceOnUse', width: size, height: size }, ...children);
  const defs = s(
    'defs',
    null,
    pat('stripes', 3, s('path', { d: 'M-1 1l2-2M0 3l3-3M2 4l2-2', stroke: ink, 'stroke-width': sw })),
    pat('dots', 3, s('circle', { cx: 1.5, cy: 1.5, r: 0.55, fill: ink })),
    pat('hlines', 3, s('path', { d: 'M0 1.5h3', stroke: ink, 'stroke-width': sw })),
    pat('grid', 3, s('path', { d: 'M0 1.5h3M1.5 0v3', stroke: ink, 'stroke-width': sw * 0.8 })),
    pat('vlines', 3, s('path', { d: 'M1.5 0v3', stroke: ink, 'stroke-width': sw })),
    pat('checker', 4, s('rect', { x: 0, y: 0, width: 2, height: 2, fill: ink }), s('rect', { x: 2, y: 2, width: 2, height: 2, fill: ink })),
    pat('cross', 3, s('path', { d: 'M0 0l3 3M3 0l-3 3', stroke: ink, 'stroke-width': sw * 0.8 })),
    pat('rings', 4, s('circle', { cx: 2, cy: 2, r: 1.1, fill: 'none', stroke: ink, 'stroke-width': sw * 0.8 })),
    // ombre portée très douce d'une pièce de papier posée sur la feuille
    s(
      'filter',
      { id: 'paper-shadow', x: '-20%', y: '-20%', width: '140%', height: '150%' },
      s('feDropShadow', { dx: 0.25, dy: 0.5, stdDeviation: 0.45, 'flood-color': '#3b2f20', 'flood-opacity': 0.28 }),
    ),
    s(
      'filter',
      { id: 'paper-lift', x: '-30%', y: '-30%', width: '160%', height: '170%' },
      s('feDropShadow', { dx: 0.5, dy: 1.2, stdDeviation: 1, 'flood-color': '#3b2f20', 'flood-opacity': 0.3 }),
    ),
  );
  const holder = s('svg', { id: 'bb-defs', width: 0, height: 0, 'aria-hidden': 'true', style: 'position:absolute' }, defs);
  document.body.prepend(holder);
}

// ---------- géométrie du contour ----------

type V = [number, number];

function partPolygon(p: Part): V[] {
  const { r, c } = p;
  switch (p.corner) {
    case 'SW':
      return [[c, r], [c + 1, r + 1], [c, r + 1]];
    case 'NW':
      return [[c, r], [c + 1, r], [c, r + 1]];
    case 'NE':
      return [[c, r], [c + 1, r], [c + 1, r + 1]];
    case 'SE':
      return [[c + 1, r], [c + 1, r + 1], [c, r + 1]];
    default:
      return [[c, r], [c + 1, r], [c + 1, r + 1], [c, r + 1]];
  }
}

/**
 * Contour de l'union des parts : on garde les arêtes non partagées (une arête
 * commune à deux parts apparaît dans les deux sens et s'annule), puis on les enchaîne.
 */
export function outlineLoops(parts: readonly Part[]): { loops: V[][]; diagonals: [V, V][] } {
  const edges = new Map<string, [V, V]>();
  const key = (a: V, b: V) => `${a[0]},${a[1]}>${b[0]},${b[1]}`;
  for (const p of parts) {
    const poly = partPolygon(p);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const rev = key(b, a);
      if (edges.has(rev)) edges.delete(rev);
      else edges.set(key(a, b), [a, b]);
    }
  }
  const diagonals = [...edges.values()].filter(([a, b]) => a[0] !== b[0] && a[1] !== b[1]);
  const from = new Map<string, [V, V][]>();
  for (const e of edges.values()) {
    const k = `${e[0][0]},${e[0][1]}`;
    if (!from.has(k)) from.set(k, []);
    from.get(k)!.push(e);
  }
  const loops: V[][] = [];
  const used = new Set<[V, V]>();
  for (const start of edges.values()) {
    if (used.has(start)) continue;
    const loop: V[] = [start[0]];
    let cur = start;
    for (let guard = 0; guard < 400; guard++) {
      used.add(cur);
      loop.push(cur[1]);
      const next = (from.get(`${cur[1][0]},${cur[1][1]}`) ?? []).find((e) => !used.has(e));
      if (!next) break;
      cur = next;
    }
    loops.push(loop);
  }
  return { loops, diagonals };
}

function darken(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(v * (1 - k));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

/** Dessine des parts (coordonnées en cases) colorées dans un <g>, décalé de (ox, oy) unités. */
export function drawParts(parts: readonly Part[], colorId: string, style: PieceStyle, ox: number, oy: number): SVGGElement {
  const color = COLORS[colorId] ?? { hex: '#999', letter: '?', pattern: 'dots' as PatternId, name: '?' };
  const { loops, diagonals } = outlineLoops(parts);
  const d = loops.map((l) => 'M' + l.map(([x, y]) => `${ox + x * U} ${oy + y * U}`).join('L') + 'Z').join('');
  const g = s('g', { class: `piece piece-${style}` });
  const body = s('g', { class: 'piece-body', filter: style === 'guess' ? undefined : style === 'selected' ? 'url(#paper-lift)' : 'url(#paper-shadow)' });
  body.append(s('path', { d, fill: color.hex, class: 'piece-fill', 'fill-rule': 'nonzero' }));
  body.append(s('path', { d, fill: `url(#pat-${color.pattern})`, class: 'piece-pattern' }));
  g.append(body);
  g.append(s('path', { d, class: 'piece-edge', stroke: darken(color.hex, 0.35) }));
  if (diagonals.length) {
    const dd = diagonals.map(([a, b]) => `M${ox + a[0] * U} ${oy + a[1] * U}L${ox + b[0] * U} ${oy + b[1] * U}`).join('');
    g.append(s('path', { d: dd, class: 'piece-mirror', stroke: darken(color.hex, 0.5) }));
  }
  // lettre : au centre de la première case pleine, sinon dans la première demi-case
  const full = parts.find((p) => !p.corner);
  let lx: number;
  let ly: number;
  let small = false;
  if (full) {
    lx = full.c + 0.5;
    ly = full.r + 0.5;
  } else {
    const poly = partPolygon(parts[0]);
    lx = poly.reduce((a, v) => a + v[0], 0) / poly.length;
    ly = poly.reduce((a, v) => a + v[1], 0) / poly.length;
    small = true;
  }
  g.append(s('text', { x: ox + lx * U, y: oy + ly * U, class: `piece-letter${small ? ' small' : ''}` }, color.letter));
  return g;
}

export function drawPiece(piece: BoardPiece, catalog: Catalog, ox: number, oy: number): SVGGElement {
  const def = pieceDef(piece.pieceId, catalog);
  if (!def) return s('g');
  return drawParts(placementParts(piece, catalog), def.color, piece.style ?? 'normal', ox, oy);
}

/** Vignette SVG de parts, à échelle fixe (`cellPx` pixels par case). */
export function partsThumb(parts: readonly Part[], colorId: string, cellPx = 12): SVGSVGElement {
  const w = Math.max(...parts.map((p) => p.c)) + 1;
  const hh = Math.max(...parts.map((p) => p.r)) + 1;
  const pad = 1.5;
  const svg = s('svg', {
    viewBox: `${-pad} ${-pad} ${w * U + 2 * pad} ${hh * U + 2 * pad}`,
    class: 'thumb',
    'aria-hidden': 'true',
    width: Math.round(w * cellPx + (2 * pad * cellPx) / U),
    height: Math.round(hh * cellPx + (2 * pad * cellPx) / U),
  });
  svg.append(drawParts(parts, colorId, 'normal', 0, 0));
  return svg;
}

export function pieceThumb(pieceId: string, catalog: Catalog, rot: 0 | 1 | 2 | 3 = 0): SVGSVGElement {
  const def = pieceDef(pieceId, catalog)!;
  return partsThumb(placementParts({ pieceId, r: 0, c: 0, rot }, catalog), def.color, 13);
}

// ---------- grille au crayon ----------

/** Pseudo-aléatoire fixe : le tremblé du crayon est identique à chaque affichage. */
function jitterFactory(seed: number) {
  let x = seed;
  return () => {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    return (x / 4294967296 - 0.5) * 0.5;
  };
}

function pencilLine(x1: number, y1: number, x2: number, y2: number, j: () => number): string {
  const steps = 4;
  let d = `M${(x1 + j() * 0.6).toFixed(2)} ${(y1 + j() * 0.6).toFixed(2)}`;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = x1 + (x2 - x1) * t + (x1 === x2 ? j() : 0);
    const y = y1 + (y2 - y1) * t + (y1 === y2 ? j() : 0);
    d += `L${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return d;
}

// ---------- plateau ----------

export function edgeAt(cell: Cell): Edge | null {
  const { r, c } = cell;
  if (r === -1 && c >= 0 && c < N) return { side: 'top', index: c };
  if (r === N && c >= 0 && c < N) return { side: 'bottom', index: c };
  if (c === -1 && r >= 0 && r < N) return { side: 'left', index: r };
  if (c === N && r >= 0 && r < N) return { side: 'right', index: r };
  return null;
}

function drawOverlays(list: readonly Overlay[], G: number): SVGElement {
  const g = s('g', { class: 'overlays' });
  const total = N * U + 2 * G;
  for (const o of list) {
    if (o.kind === 'cells') {
      for (const cell of o.cells) {
        const x = G + cell.c * U;
        const y = G + cell.r * U;
        if (o.tone === 'empty') {
          g.append(s('circle', { cx: x + U / 2, cy: y + U / 2, r: 2.6, class: 'ov-empty' }));
        } else {
          g.append(s('rect', { x: x + 0.5, y: y + 0.5, width: U - 1, height: U - 1, rx: 1, class: `ov-cell ov-${o.tone}`, style: cell.fill ? `fill:${cell.fill}` : undefined }));
        }
        if (cell.text) g.append(s('text', { x: x + U / 2, y: y + U / 2, class: 'ov-text' }, cell.text));
      }
    } else if (o.kind === 'band') {
      const row = o.axis === 'row';
      g.append(s('rect', { x: row ? G : G + o.index * U, y: row ? G + o.index * U : G, width: row ? N * U : U, height: row ? U : N * U, class: 'ov-band' }));
      if (o.text) g.append(s('text', { x: row ? G + N * U - 3 : G + o.index * U + U / 2, y: row ? G + o.index * U + U / 2 : G + 4, class: 'ov-text ov-text-band' }, o.text));
    } else if (o.kind === 'bars') {
      const row = o.axis === 'row';
      o.counts.forEach((n, i) => {
        const len = Math.max(n, 0) * U * 0.9;
        g.append(
          s('rect', row ? { x: G + 0.5, y: G + i * U + 2, width: Math.max(len, 0.8), height: U - 4, rx: 1, class: 'ov-bar' } : { x: G + i * U + 2, y: G + 0.5, width: U - 4, height: Math.max(len, 0.8), rx: 1, class: 'ov-bar' }),
          s('text', row ? { x: G + len + 2.5, y: G + i * U + U / 2, class: 'ov-text ov-text-bar' } : { x: G + i * U + U / 2, y: G + len + 3.5, class: 'ov-text ov-text-bar' }, String(n)),
        );
      });
    } else if (o.kind === 'caption') {
      const w = Math.min(total - 4, o.text.length * 2.5 + 8);
      g.append(s('rect', { x: total / 2 - w / 2, y: total / 2 - 5, width: w, height: 10, rx: 3, class: 'ov-caption-bg' }), s('text', { x: total / 2, y: total / 2, class: 'ov-caption' }, o.text));
    } else {
      g.append(s('text', { x: total / 2, y: total / 2, class: 'ov-glyph' }, o.text));
    }
  }
  return g;
}

export function createBoard(opts: BoardOptions): BoardView {
  const G = opts.gutter === 'none' ? 0 : opts.gutter === 'buttons' ? 1.35 * U : 0.9 * U;
  const total = N * U + 2 * G;
  const descId = opts.description ? `d${Math.random().toString(36).slice(2)}` : undefined;
  const svg = s('svg', {
    viewBox: `0 0 ${total} ${total}`,
    class: `board ${opts.className ?? ''} gutter-${opts.gutter}`,
    role: 'img',
    'aria-label': opts.label,
    'aria-describedby': descId,
  });

  // grille au crayon
  const j = jitterFactory(7);
  let d = '';
  for (let i = 1; i < N; i++) {
    d += pencilLine(G + i * U, G, G + i * U, G + N * U, j);
    d += pencilLine(G, G + i * U, G + N * U, G + i * U, j);
  }
  svg.append(s('path', { d, class: 'gridlines' }));
  svg.append(
    s('path', {
      d: pencilLine(G, G, G + N * U, G, j) + pencilLine(G + N * U, G, G + N * U, G + N * U, j) + pencilLine(G + N * U, G + N * U, G, G + N * U, j) + pencilLine(G, G + N * U, G, G, j),
      class: 'gridframe',
    }),
  );

  // marge : étiquettes ou bords à viser
  if (G) {
    const gut = s('g', { class: 'gutter' });
    const shades = new Map<string, EdgeShade['kind']>();
    for (const sh of opts.edgeShades ?? []) {
      const k = `${sh.edge.side}${sh.edge.index}`;
      if (!shades.has(k) || sh.kind.endsWith('last')) shades.set(k, sh.kind);
    }
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      for (let i = 0; i < N; i++) {
        const vertical = side === 'top' || side === 'bottom';
        const x = vertical ? G + i * U : side === 'left' ? 0 : G + N * U;
        const y = vertical ? (side === 'top' ? 0 : G + N * U) : G + i * U;
        const w = vertical ? U : G;
        const hh = vertical ? G : U;
        const sel = !!opts.selectedEdge && opts.selectedEdge.side === side && opts.selectedEdge.index === i;
        const label = vertical ? COL_LABELS[i] : String(i + 1);
        if (opts.gutter === 'buttons') gut.append(s('rect', { x: x + 0.6, y: y + 0.6, width: w - 1.2, height: hh - 1.2, rx: 1.4, class: `edge-btn${sel ? ' edge-selected' : ''}` }));
        // étiquette décalée vers l'extérieur, marqueur de tir côté grille
        const cx = x + w / 2;
        const cy = y + hh / 2;
        const toward = { top: [0, 1], bottom: [0, -1], left: [1, 0], right: [-1, 0] }[side];
        const off = opts.gutter === 'buttons' ? 1.7 : 1.2; // étiquette vers l'extérieur, marqueur côté grille
        gut.append(s('text', { x: cx - toward[0] * off, y: cy - toward[1] * off, class: `edge-label${sel ? ' sel' : ''}` }, label));
        const shade = shades.get(`${side}${i}`);
        if (shade) {
          const mx = cx + toward[0] * (w / 2 - 2.2);
          const my = cy + toward[1] * (hh / 2 - 2.2);
          const last = shade.endsWith('last');
          if (shade.startsWith('in') || shade === 'both-last') gut.append(s('circle', { cx: mx, cy: my, r: 1.1, class: `mark-in${last ? ' last' : ''}` }));
          if (shade.startsWith('out') || shade === 'both-last') gut.append(s('circle', { cx: mx, cy: my, r: 1.9, class: `mark-out${last ? ' last' : ''}` }));
        }
      }
    }
    svg.append(gut);
  }

  // ligne de visée
  if (opts.selectedEdge && G) {
    const e = opts.selectedEdge;
    const p = G + e.index * U + U / 2;
    svg.append(
      e.side === 'top' || e.side === 'bottom'
        ? s('line', { x1: p, y1: G, x2: p, y2: G + N * U, class: 'aim' })
        : s('line', { x1: G, y1: p, x2: G + N * U, y2: p, class: 'aim' }),
    );
  }

  // marques du carnet (au crayon)
  const marks = s('g', { class: 'marks' });
  for (const [k, m] of Object.entries(opts.marks ?? {})) {
    const [r, c] = k.split(',').map(Number);
    const cx = G + c * U + U / 2;
    const cy = G + r * U + U / 2;
    if (m === 'x') marks.append(s('path', { d: `M${cx - 2.6} ${cy - 2.4}l5.3 4.9M${cx + 2.5} ${cy - 2.6}l-5.1 5.2`, class: 'mark-x' }));
    else if (m === 'o') marks.append(s('circle', { cx, cy, r: 2.5, class: 'mark-o' }));
    else marks.append(s('text', { x: cx, y: cy, class: 'mark-q' }, '?'));
  }
  svg.append(marks);

  // pièces
  const pieces = s('g', { class: 'pieces' });
  if (opts.catalog) for (const p of opts.pieces ?? []) pieces.append(drawPiece(p, opts.catalog, G, G));
  svg.append(pieces);

  // sorts : zones, lignes, barres, légendes
  if (opts.overlays?.length) svg.append(drawOverlays(opts.overlays, G));

  // trajets du laser : un fil rouge
  for (const path of opts.paths ?? []) {
    if (path.points.length < 2) continue;
    const pts = path.points.map((p) => `${G + p.x * U},${G + p.y * U}`).join(' ');
    svg.append(s('polyline', { points: pts, class: `laser${path.dim ? ' dim' : ''}` }));
    const [a] = path.points;
    svg.append(s('circle', { cx: G + a.x * U, cy: G + a.y * U, r: 1, class: `laser-dot${path.dim ? ' dim' : ''}` }));
  }

  const preview = s('g', { class: 'preview' });
  svg.append(preview);

  const root = h('div', { class: `board-wrap gutter-${opts.gutter}` }, svg, opts.description ? h('p', { id: descId, class: 'sr-only' }, opts.description) : null);

  const scale = () => svg.getBoundingClientRect().width / total;
  return {
    root,
    svg,
    unitPx: () => scale() * U,
    gridOrigin() {
      const rect = svg.getBoundingClientRect();
      return { left: rect.left + G * scale(), top: rect.top + G * scale() };
    },
    rawCellAt(x, y) {
      const rect = svg.getBoundingClientRect();
      if (x < rect.left || y < rect.top || x > rect.right || y > rect.bottom) return null;
      const k = scale();
      const gx = ((x - rect.left) / k - G) / U;
      const gy = ((y - rect.top) / k - G) / U;
      const c = gx < 0 ? -1 : gx >= N ? N : Math.floor(gx);
      const r = gy < 0 ? -1 : gy >= N ? N : Math.floor(gy);
      if ((r === -1 || r === N) && (c === -1 || c === N)) return null; // coin
      return { r, c };
    },
    setPreview(piece) {
      preview.replaceChildren();
      if (piece && opts.catalog) preview.append(drawPiece(piece, opts.catalog, G, G));
    },
  };
}

/** Description textuelle d'un plateau (lecteurs d'écran). */
export function describePieces(pieces: readonly Placement[], catalog: Catalog, sunk: ReadonlySet<string> = new Set()): string {
  if (pieces.length === 0) return 'Aucune pièce sur la grille.';
  return pieces
    .map((p) => {
      const def = pieceDef(p.pieceId, catalog);
      const cells = placementParts(p, catalog)
        .map((x) => `${COL_LABELS[x.c]}${x.r + 1}`)
        .join(' ');
      return `${def ? COLORS[def.color]?.name : '?'} ${def ? catalog.shapes[def.shape]?.name : ''} en ${cells}${sunk.has(p.pieceId) ? ' (coulée)' : ''}`;
    })
    .join(' ; ');
}

export { cellKey };
