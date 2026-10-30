/**
 * Éditeur de pièces sur une grille : glisser-déposer au doigt, ou toucher une pièce du bac
 * puis une case. Toucher une pièce posée la sélectionne ; la toucher encore la fait pivoter.
 * Sert au placement de ses propres pièces et aux formes supposées dans le carnet.
 *
 * Défilement : la page reste défilable au doigt partout, sauf quand le geste commence
 * sur une pièce (elle est alors déplacée).
 */

import { COLORS } from '../config/pieces';
import {
  inBounds,
  pieceDef,
  placementCells,
  rotationCount,
  shapePartsRotated,
  type Catalog,
  type Cell,
  type Placement,
  type Rotation,
} from '../engine';
import { createBoard, drawPiece, pieceThumb, type BoardOptions, type BoardPiece, type PieceStyle } from './boardView';
import { buzz, h, icon, s, toast } from './dom';
import { ICONS } from './icons';

export interface EditorConfig {
  key: string;
  catalog: Catalog;
  board: Omit<BoardOptions, 'catalog'>;
  placements: Placement[];
  fixed?: BoardPiece[];
  editableStyle?: PieceStyle;
  trayIds: string[];
  trayTitle: string;
  selectedId: string | null;
  isValid(placements: Placement[]): boolean;
  onCommit(placements: Placement[]): void;
  onSelect(id: string | null): void;
  onCellTap?(cell: Cell): void;
  extraActions?(id: string, placed: boolean): HTMLElement[];
  setDragging(active: boolean): void;
}

const trayRotations = new Map<string, Rotation>();
const DRAG_THRESHOLD = 8;

export function pieceName(pieceId: string, catalog: Catalog): string {
  const def = pieceDef(pieceId, catalog);
  if (!def) return pieceId;
  const shape = catalog.shapes[def.shape]?.name ?? def.shape;
  return `${shape} ${(COLORS[def.color]?.name ?? def.color).toLowerCase()}`;
}

/** Empêche le défilement pendant qu'une pièce est tenue (iOS et Android). */
let holding = false;
let touchGuardInstalled = false;
function installTouchGuard() {
  if (touchGuardInstalled) return;
  touchGuardInstalled = true;
  document.addEventListener(
    'touchmove',
    (e) => {
      if (holding && e.cancelable) e.preventDefault();
    },
    { passive: false },
  );
}

export function createPieceEditor(cfg: EditorConfig): HTMLElement {
  installTouchGuard();
  const cat = cfg.catalog;
  const placed = new Map(cfg.placements.map((p) => [p.pieceId, p]));
  const trayRot = (id: string): Rotation => trayRotations.get(`${cfg.key}:${id}`) ?? 0;

  const pieces: BoardPiece[] = [
    ...(cfg.fixed ?? []),
    ...cfg.placements.map((p) => ({ ...p, style: (p.pieceId === cfg.selectedId ? 'selected' : cfg.editableStyle ?? 'normal') as PieceStyle })),
  ];
  const board = createBoard({ ...cfg.board, catalog: cat, pieces });
  board.svg.classList.add('editable');

  const others = (id: string) => cfg.placements.filter((p) => p.pieceId !== id);
  const fits = (p: Placement) => placementCells(p, cat).every((c) => inBounds(c));
  const tryPlace = (cand: Placement) => fits(cand) && cfg.isValid([...others(cand.pieceId), cand]);

  const commit = (cand: Placement) => {
    cfg.onCommit([...others(cand.pieceId), cand]);
    cfg.onSelect(cand.pieceId);
  };

  const shapeOfPiece = (id: string) => cat.shapes[pieceDef(id, cat)!.shape];

  /** Pose une pièce pour qu'elle couvre la case touchée, si possible. */
  const placeAtCell = (pieceId: string, rot: Rotation, cell: Cell): boolean => {
    for (const off of shapePartsRotated(shapeOfPiece(pieceId), rot)) {
      const cand = { pieceId, rot, r: cell.r - off.r, c: cell.c - off.c };
      if (tryPlace(cand)) {
        commit(cand);
        return true;
      }
    }
    return false;
  };

  /** Fait pivoter une pièce (posée ou dans le bac) en la décalant si besoin. */
  const rotate = (id: string) => {
    const count = rotationCount(shapeOfPiece(id).parts);
    if (!placed.has(id)) {
      trayRotations.set(`${cfg.key}:${id}`, ((trayRot(id) + 1) % count) as Rotation);
      cfg.onCommit(cfg.placements);
      return;
    }
    const p = placed.get(id)!;
    if (count === 1) {
      toast('Cette pièce est identique dans tous les sens.', 'info', 1500);
      return;
    }
    const rot = ((p.rot + 1) % count) as Rotation;
    const shifts: { dr: number; dc: number }[] = [];
    for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) shifts.push({ dr, dc });
    shifts.sort((a, b) => Math.abs(a.dr) + Math.abs(a.dc) - (Math.abs(b.dr) + Math.abs(b.dc)));
    for (const { dr, dc } of shifts) {
      const cand = { ...p, rot, r: p.r + dr, c: p.c + dc };
      if (tryPlace(cand)) {
        commit(cand);
        return;
      }
    }
    toast('Pas la place pour pivoter ici', 'warn', 1600);
  };

  // ---------- glisser ----------

  interface Drag {
    pieceId: string;
    rot: Rotation;
    fromBoard: boolean;
    startX: number;
    startY: number;
    pointerType: string;
    active: boolean;
    ghost?: HTMLElement;
    grabX: number;
    grabY: number;
    candidate: Placement | null;
    valid: boolean;
  }
  let drag: Drag | null = null;

  const makeGhost = (d: Drag, unit: number) => {
    const parts = shapePartsRotated(shapeOfPiece(d.pieceId), d.rot);
    const w = Math.max(...parts.map((p) => p.c)) + 1;
    const hh = Math.max(...parts.map((p) => p.r)) + 1;
    const svg = s('svg', { viewBox: `-1 -1 ${w * 10 + 2} ${hh * 10 + 2}`, width: w * unit + unit / 5, height: hh * unit + unit / 5 });
    svg.append(drawPiece({ pieceId: d.pieceId, r: 0, c: 0, rot: d.rot, style: 'selected' }, cat, 0, 0));
    const el = h('div', { class: 'drag-ghost' }, svg);
    document.body.append(el);
    return { el, w: w * unit, h: hh * unit };
  };

  const end = () => {
    holding = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };

  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      drag.active = true;
      cfg.setDragging(true);
      const unit = board.unitPx();
      const ghost = makeGhost(drag, unit);
      drag.ghost = ghost.el;
      const lift = drag.pointerType === 'mouse' ? 0 : unit * 1.3;
      if (drag.fromBoard) {
        const p = placed.get(drag.pieceId)!;
        const origin = board.gridOrigin();
        drag.grabX = drag.startX - (origin.left + p.c * unit);
        drag.grabY = drag.startY - (origin.top + p.r * unit) + lift;
      } else {
        drag.grabX = ghost.w / 2;
        drag.grabY = ghost.h / 2 + lift;
      }
    }
    e.preventDefault();
    const left = e.clientX - drag.grabX;
    const top = e.clientY - drag.grabY;
    drag.ghost!.style.transform = `translate(${left}px, ${top}px)`;
    const unit = board.unitPx();
    const origin = board.gridOrigin();
    const cand: Placement = { pieceId: drag.pieceId, rot: drag.rot, r: Math.round((top - origin.top) / unit), c: Math.round((left - origin.left) / unit) };
    const anyInside = placementCells(cand, cat).some((c) => inBounds(c));
    drag.candidate = anyInside ? cand : null;
    drag.valid = anyInside && tryPlace(cand);
    board.setPreview(anyInside ? { ...cand, style: drag.valid ? 'ghost-ok' : 'ghost-bad' } : null);
  };

  const onUp = (e: PointerEvent) => {
    end();
    const d = drag;
    drag = null;
    if (!d) return;
    if (!d.active) {
      if (e.type !== 'pointerup') return;
      // simple toucher : sélectionner, ou faire pivoter si déjà sélectionnée
      if (cfg.selectedId === d.pieceId) {
        if (d.fromBoard) rotate(d.pieceId);
        else cfg.onSelect(null);
      } else cfg.onSelect(d.pieceId);
      return;
    }
    d.ghost?.remove();
    board.setPreview(null);
    cfg.setDragging(false);
    if (e.type === 'pointerup' && d.candidate && d.valid) {
      buzz();
      commit(d.candidate);
    } else if (e.type === 'pointerup' && d.fromBoard && !board.rawCellAt(e.clientX, e.clientY)) {
      cfg.onCommit(others(d.pieceId)); // lâchée hors de la grille : retour au bac
      cfg.onSelect(null);
    } else {
      if (d.candidate && e.type === 'pointerup') toast('Emplacement impossible (bord ou chevauchement)', 'warn', 1800);
      cfg.onCommit(cfg.placements);
    }
  };

  const beginDrag = (e: PointerEvent, pieceId: string, rot: Rotation, fromBoard: boolean) => {
    if (e.button !== undefined && e.button > 0) return;
    holding = true;
    drag = { pieceId, rot, fromBoard, startX: e.clientX, startY: e.clientY, pointerType: e.pointerType, active: false, grabX: 0, grabY: 0, candidate: null, valid: false };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  board.svg.addEventListener('pointerdown', (e) => {
    const cell = board.rawCellAt(e.clientX, e.clientY);
    if (!cell || !inBounds(cell)) return;
    const hit = cfg.placements.find((p) => placementCells(p, cat).some((c) => c.r === cell.r && c.c === cell.c));
    if (hit) {
      beginDrag(e, hit.pieceId, hit.rot, true);
      return;
    }
    // case vide : on attend la fin du geste (un glissement = défilement de la page)
    const sx = e.clientX;
    const sy = e.clientY;
    const up = (ev: PointerEvent) => {
      board.svg.removeEventListener('pointerup', up);
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > DRAG_THRESHOLD) return;
      const armed = cfg.selectedId && !placed.has(cfg.selectedId) && cfg.trayIds.includes(cfg.selectedId) ? cfg.selectedId : null;
      if (armed) {
        if (!placeAtCell(armed, trayRot(armed), cell)) toast('Pas la place ici', 'warn', 1500);
      } else if (cfg.onCellTap) cfg.onCellTap(cell);
      else if (cfg.selectedId) cfg.onSelect(null);
    };
    board.svg.addEventListener('pointerup', up);
  });

  // ---------- barre de sélection ----------

  const sel = cfg.selectedId && cfg.trayIds.includes(cfg.selectedId) ? cfg.selectedId : null;
  let bar: HTMLElement;
  if (sel) {
    const isPlaced = placed.has(sel);
    bar = h(
      'div',
      { class: 'selbar' },
      h('div', { class: 'selbar-name' }, pieceThumb(sel, cat, isPlaced ? placed.get(sel)!.rot : trayRot(sel)), h('span', null, pieceName(sel, cat))),
      h(
        'div',
        { class: 'selbar-actions' },
        h('button', { class: 'btn btn-secondary btn-sm', onclick: () => rotate(sel) }, icon(ICONS.rotate), 'Pivoter'),
        isPlaced
          ? h(
              'button',
              {
                class: 'btn btn-secondary btn-sm',
                onclick: () => {
                  cfg.onCommit(others(sel));
                  cfg.onSelect(null);
                },
              },
              icon(ICONS.trash),
              'Retirer',
            )
          : null,
        ...(cfg.extraActions?.(sel, isPlaced) ?? []),
      ),
      h('p', { class: 'hint' }, isPlaced ? 'Touche-la encore pour la faire pivoter, ou fais-la glisser.' : 'Touche une case de la grille pour la poser, ou fais-la glisser.'),
    );
  } else {
    bar = h('div', { class: 'selbar selbar-empty' }, h('p', { class: 'hint' }, 'Fais glisser une pièce sur la grille, ou touche-la puis touche une case. Touche une pièce posée pour la sélectionner, puis encore pour la pivoter.'));
  }

  // ---------- bac ----------

  const trayItems = cfg.trayIds.filter((id) => !placed.has(id));
  const tray = h(
    'div',
    { class: 'tray', role: 'list', 'aria-label': cfg.trayTitle },
    ...trayItems.map((id) => {
      const btn = h(
        'button',
        { class: `tray-item ${id === cfg.selectedId ? 'selected' : ''}`, role: 'listitem', 'aria-label': pieceName(id, cat), 'aria-pressed': id === cfg.selectedId ? 'true' : 'false' },
        pieceThumb(id, cat, trayRot(id)),
      );
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        beginDrag(e, id, trayRot(id), false);
      });
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          cfg.onSelect(id);
        }
      });
      return btn;
    }),
  );

  return h(
    'div',
    { class: 'editor' },
    board.root,
    bar,
    trayItems.length ? h('div', { class: 'tray-wrap' }, h('div', { class: 'tray-title' }, `${cfg.trayTitle} (${trayItems.length})`), tray) : null,
  );
}
