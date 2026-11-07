/**
 * Réglages : jeux de pièces (choisir, voir, modifier, dupliquer, supprimer) et
 * éditeur de formes. Écran autonome (gère sa propre navigation interne).
 */

import { COLORS, COLOR_IDS } from '../../config/pieces';
import { CORNERS, SPELLS, normalizeParts, rotateParts, setStats, shapeError, type Corner, type Part, type PieceSet, type ShapeDef } from '../../engine';
import { partsThumb } from '../boardView';
import { confirmBox, h, icon, modal, s, toast } from '../dom';
import { ICONS } from '../icons';
import {
  activeSetId,
  allSets,
  allShapes,
  customShapes,
  deleteSet,
  deleteShape,
  duplicateSet,
  isBuiltinSet,
  saveSet,
  saveShape,
  saveSpellConfig,
  spellConfig,
  setActiveSet,
  setErrors,
  uid,
} from '../library';

type View = { kind: 'home' } | { kind: 'set'; id: string } | { kind: 'shape'; id: string | null; back: View };

const CORNER_LABEL: Record<Corner, string> = { SW: 'Demi-case, angle en bas à gauche', NW: 'Demi-case, angle en haut à gauche', NE: 'Demi-case, angle en haut à droite', SE: 'Demi-case, angle en bas à droite' };
const EDITOR_SIZE = 5;

function setSummary(set: PieceSet): string {
  const { pieces, cells } = setStats(set);
  return `${pieces} pièce${pieces > 1 ? 's' : ''} · ${cells} case${cells > 1 ? 's' : ''}`;
}

function setPreview(set: PieceSet): HTMLElement {
  return h(
    'div',
    { class: 'set-preview', 'aria-hidden': 'true' },
    ...set.entries.flatMap((e) => {
      const shape = set.shapes.find((x) => x.id === e.shape);
      if (!shape) return [];
      const t = partsThumb(shape.parts, e.color, 9);
      return [e.count > 1 ? h('span', { class: 'thumb-count' }, t, h('small', null, `×${e.count}`)) : t];
    }),
  );
}

/** Liste lisible d'un jeu (aussi utilisée pour l'acceptation par l'invité). */
export function setDetails(set: PieceSet): HTMLElement {
  return h(
    'ul',
    { class: 'set-details' },
    ...set.entries.map((e) => {
      const shape = set.shapes.find((x) => x.id === e.shape);
      return h(
        'li',
        null,
        h('span', { class: 'thumb-box' }, shape ? partsThumb(shape.parts, e.color, 11) : ''),
        h('span', null, `${shape?.name ?? e.shape} ${COLORS[e.color]?.name.toLowerCase() ?? e.color}`),
        h('span', { class: 'muted' }, `×${e.count}`),
      );
    }),
  );
}

export function renderSettings(onBack: () => void): HTMLElement {
  const root = h('div', { class: 'screen settings' });
  let view: View = { kind: 'home' };

  const go = (v: View) => {
    view = v;
    render();
    root.querySelector('.scroll')?.scrollTo(0, 0);
  };

  const header = (title: string, back: () => void) =>
    h('header', { class: 'topbar' }, h('button', { class: 'icon-btn', 'aria-label': 'Retour', onclick: back }, icon(ICONS.chevronLeft)), h('h1', null, title));

  function render() {
    if (view.kind === 'home') root.replaceChildren(header('Réglages', onBack), homeView());
    else if (view.kind === 'set') root.replaceChildren(header('Jeu de pièces', () => go({ kind: 'home' })), setView(view.id));
    else {
      const back = view.back;
      root.replaceChildren(header(view.id ? 'Modifier la forme' : 'Nouvelle forme', () => go(back)), shapeView(view.id, back));
    }
  }

  // ---------- sorts ----------
  function spellsSection(): HTMLElement {
    const cfg = spellConfig();
    const update = (patch: Partial<typeof cfg>) => {
      saveSpellConfig({ ...cfg, ...patch });
      render();
    };
    const check = (label: string, checked: boolean, onChange: (v: boolean) => void, hint?: string) =>
      h(
        'label',
        { class: 'check-row' },
        h('input', { type: 'checkbox', checked, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) }),
        h('span', null, label, hint ? h('small', { class: 'muted' }, hint) : null),
      );
    return h(
      'section',
      { class: 'paper-card spells-settings' },
      h('h2', { class: 'section-title' }, 'Sorts'),
      h('p', { class: 'muted small' }, 'Des pouvoirs spéciaux, gagnés en jouant. Lancer un sort remplace ton tir. Seul le téléphone qui crée la partie décide : l’autre suit ses réglages.'),
      check('Activer les sorts dans les nouvelles parties', cfg.enabled, (v) => update({ enabled: v })),
      cfg.enabled
        ? h(
            'div',
            { class: 'spells-options' },
            h(
              'label',
              { class: 'field' },
              h('span', null, 'Un sort tous les'),
              h(
                'select',
                { class: 'input', 'aria-label': 'Fréquence des sorts', onchange: (e: Event) => update({ everyTurns: Number((e.target as HTMLSelectElement).value) }) },
                ...[0, 1, 2, 3, 4, 5, 6, 8, 10].map((n) => h('option', { value: String(n), selected: n === cfg.everyTurns }, n === 0 ? 'jamais (pas de gain par tour)' : n === 1 ? 'tour' : `${n} tours`)),
              ),
            ),
            check('Un sort à chaque pièce adverse coulée', cfg.onSink, (v) => update({ onSink: v })),
            h('h3', null, `Sorts qui peuvent apparaître (${cfg.pool.length}/${SPELLS.length})`),
            h(
              'div',
              { class: 'btn-row' },
              h('button', { class: 'btn btn-ghost btn-sm', onclick: () => update({ pool: SPELLS.map((s) => s.id) }) }, 'Tous'),
              h('button', { class: 'btn btn-ghost btn-sm', onclick: () => update({ pool: [] }) }, 'Aucun'),
            ),
            ...SPELLS.map((sp) =>
              check(sp.name, cfg.pool.includes(sp.id), (v) => update({ pool: v ? [...cfg.pool, sp.id] : cfg.pool.filter((x) => x !== sp.id) }), sp.desc),
            ),
            cfg.pool.length === 0 ? h('p', { class: 'error small' }, 'Aucun sort n’apparaîtra tant que la liste est vide.') : null,
          )
        : null,
    );
  }

  // ---------- accueil des réglages ----------
  function homeView(): HTMLElement {
    const active = activeSetId();
    const sets = allSets();
    const shapes = customShapes();
    return h(
      'main',
      { class: 'scroll' },
      spellsSection(),
      h('h2', { class: 'section-title' }, 'Jeu de pièces des nouvelles parties'),
      h('p', { class: 'muted small' }, 'Le téléphone qui crée la partie choisit le jeu ; l’autre le voit et l’accepte avant de placer ses pièces.'),
      h(
        'div',
        { class: 'set-list', role: 'radiogroup', 'aria-label': 'Jeu de pièces' },
        ...sets.map((set) => {
          const errs = isBuiltinSet(set.id) ? [] : setErrors(set);
          const checked = set.id === active;
          return h(
            'article',
            { class: `set-card${checked ? ' active' : ''}` },
            h(
              'button',
              {
                class: 'set-choose',
                role: 'radio',
                'aria-checked': checked ? 'true' : 'false',
                disabled: errs.length > 0,
                onclick: () => {
                  setActiveSet(set.id);
                  render();
                },
              },
              h('span', { class: 'radio', 'aria-hidden': 'true' }),
              h('span', { class: 'set-name' }, h('strong', null, set.name), h('small', null, `${setSummary(set)}${isBuiltinSet(set.id) ? ' · prédéfini' : ''}`)),
            ),
            setPreview(set),
            errs.length ? h('p', { class: 'error small' }, errs[0]) : null,
            h(
              'div',
              { class: 'card-actions' },
              h('button', { class: 'btn btn-ghost btn-sm', onclick: () => go({ kind: 'set', id: set.id }) }, isBuiltinSet(set.id) ? 'Voir' : 'Modifier'),
              h(
                'button',
                {
                  class: 'btn btn-ghost btn-sm',
                  onclick: () => {
                    const copy = duplicateSet(set);
                    toast(`« ${copy.name} » créé`, 'ok');
                    go({ kind: 'set', id: copy.id });
                  },
                },
                'Dupliquer',
              ),
              isBuiltinSet(set.id)
                ? null
                : h(
                    'button',
                    {
                      class: 'btn btn-ghost btn-sm danger-text',
                      onclick: async () => {
                        if (await confirmBox('Supprimer ce jeu ?', `« ${set.name} » sera supprimé de ce téléphone.`, 'Supprimer', true)) {
                          deleteSet(set.id);
                          render();
                        }
                      },
                    },
                    'Supprimer',
                  ),
            ),
          );
        }),
      ),
      h(
        'button',
        {
          class: 'btn btn-secondary',
          onclick: () => {
            const set: PieceSet = { id: uid('jeu'), name: 'Mon jeu', shapes: [], entries: [] };
            saveSet(set);
            go({ kind: 'set', id: set.id });
          },
        },
        icon(ICONS.plus),
        'Nouveau jeu',
      ),
      h('h2', { class: 'section-title' }, 'Mes formes'),
      shapes.length === 0
        ? h('p', { class: 'muted small' }, 'Aucune forme créée. Les formes prédéfinies (carrés, barres, L, T, triangles de 1 à 4…) sont toujours disponibles.')
        : h(
            'ul',
            { class: 'shape-list' },
            ...shapes.map((sh) =>
              h(
                'li',
                null,
                partsThumb(sh.parts, 'gris', 11),
                h('span', { class: 'grow' }, sh.name),
                h('button', { class: 'btn btn-ghost btn-sm', onclick: () => go({ kind: 'shape', id: sh.id, back: { kind: 'home' } }) }, 'Modifier'),
                h(
                  'button',
                  {
                    class: 'btn btn-ghost btn-sm danger-text',
                    onclick: async () => {
                      if (!(await confirmBox('Supprimer cette forme ?', `« ${sh.name} » sera supprimée.`, 'Supprimer', true))) return;
                      const blocker = deleteShape(sh.id);
                      if (blocker) toast(`Utilisée par le jeu « ${blocker} » : retirez-la d’abord de ce jeu.`, 'warn', 4500);
                      render();
                    },
                  },
                  'Supprimer',
                ),
              ),
            ),
          ),
      h('button', { class: 'btn btn-secondary', onclick: () => go({ kind: 'shape', id: null, back: { kind: 'home' } }) }, icon(ICONS.shapes), 'Créer une forme'),
    );
  }

  // ---------- éditeur de jeu ----------
  function setView(id: string): HTMLElement {
    const found = allSets().find((x) => x.id === id);
    if (!found) return h('main', { class: 'scroll' }, h('p', null, 'Jeu introuvable.'), h('button', { class: 'btn btn-secondary', onclick: () => go({ kind: 'home' }) }, 'Retour aux réglages'));
    const builtin = isBuiltinSet(id);
    const set: PieceSet = JSON.parse(JSON.stringify(found));
    const errs = builtin ? [] : setErrors(set);
    const { pieces, cells } = setStats(set);

    const update = (mutate: (s: PieceSet) => void) => {
      mutate(set);
      saveSet(set);
      render();
    };

    if (builtin) {
      return h(
        'main',
        { class: 'scroll' },
        h('h2', { class: 'screen-title' }, set.name, h('span', { class: 'count' }, `${pieces} pièces · ${cells} cases`)),
        h('p', { class: 'muted small' }, 'Jeu prédéfini, non modifiable. Dupliquez-le pour créer votre version.'),
        setDetails(set),
        h(
          'button',
          {
            class: 'btn btn-primary',
            onclick: () => {
              const copy = duplicateSet(set);
              go({ kind: 'set', id: copy.id });
            },
          },
          'Dupliquer pour modifier',
        ),
      );
    }

    const nameInput = h('input', { class: 'input', value: set.name, maxlength: 24, 'aria-label': 'Nom du jeu' });
    nameInput.addEventListener('change', () => update((s) => (s.name = nameInput.value.trim().slice(0, 24) || 'Mon jeu')));

    const colorSelect = (value: string, onChange: (c: string) => void, label: string) => {
      const sel = h('select', { class: 'input select', 'aria-label': label }, ...COLOR_IDS.map((c) => h('option', { value: c, selected: c === value }, COLORS[c].name)));
      sel.addEventListener('change', () => onChange(sel.value));
      return h('span', { class: 'color-field' }, h('span', { class: 'swatch', style: { background: COLORS[value].hex } }, COLORS[value].letter), sel);
    };

    const rows = set.entries.map((e, i) => {
      const shape = set.shapes.find((x) => x.id === e.shape);
      return h(
        'li',
        { class: 'entry' },
        h('span', { class: 'thumb-box' }, shape ? partsThumb(shape.parts, e.color, 11) : ''),
        h('div', { class: 'entry-main' }, h('strong', null, shape?.name ?? e.shape), colorSelect(e.color, (c) => update((s) => (s.entries[i].color = c)), `Couleur de ${shape?.name ?? 'la pièce'}`)),
        h(
          'div',
          { class: 'stepper', role: 'group', 'aria-label': 'Nombre d’exemplaires' },
          h('button', { class: 'icon-btn', 'aria-label': 'Un de moins', onclick: () => update((s) => (s.entries[i].count > 1 ? s.entries[i].count-- : s.entries.splice(i, 1))) }, e.count > 1 ? icon(ICONS.minus) : icon(ICONS.trash)),
          h('span', { class: 'stepper-value', 'aria-live': 'polite' }, String(e.count)),
          h('button', { class: 'icon-btn', 'aria-label': 'Un de plus', onclick: () => update((s) => (s.entries[i].count = Math.min(6, s.entries[i].count + 1))) }, icon(ICONS.plus)),
        ),
      );
    });

    const addPiece = async () => {
      const shapes = allShapes();
      let picked: ShapeDef | null = null;
      const grid = h(
        'div',
        { class: 'shape-picker' },
        ...shapes.map((sh) =>
          h(
            'button',
            {
              class: 'shape-pick',
              onclick: (ev: Event) => {
                picked = sh;
                (ev.currentTarget as HTMLElement).closest('.overlay')?.querySelector<HTMLButtonElement>('.btn-primary')?.click();
              },
            },
            partsThumb(sh.parts, 'gris', 11),
            h('span', null, sh.name),
          ),
        ),
      );
      const v = await modal('Ajouter une pièce', [grid], [
        { label: 'Créer une forme', value: 'new' },
        { label: 'Annuler', value: 'no' },
        { label: 'OK', value: 'ok', kind: 'primary' },
      ]);
      if (v === 'new') {
        go({ kind: 'shape', id: null, back: { kind: 'set', id } });
        return;
      }
      const sh = picked as ShapeDef | null;
      if (v !== 'ok' || !sh) return;
      update((s) => {
        if (!s.shapes.some((x) => x.id === sh.id)) s.shapes.push(sh);
        const used = new Set(s.entries.filter((e) => e.shape === sh.id).map((e) => e.color));
        const color = COLOR_IDS.find((c) => !used.has(c)) ?? COLOR_IDS[0];
        const existing = s.entries.find((e) => e.shape === sh.id && e.color === color);
        if (existing) existing.count++;
        else s.entries.push({ shape: sh.id, color, count: 1 });
      });
    };

    return h(
      'main',
      { class: 'scroll' },
      h('label', { class: 'field' }, h('span', null, 'Nom du jeu'), nameInput),
      h('p', { class: `set-stats ${errs.length ? 'bad' : 'good'}`, role: 'status' }, `${pieces} pièce${pieces > 1 ? 's' : ''} · ${cells} case${cells > 1 ? 's' : ''} sur 100 (50 au plus)`),
      errs.length ? h('ul', { class: 'error-list' }, ...errs.map((e) => h('li', null, e))) : h('p', { class: 'ok-text small' }, 'Jeu valide : il tient sur la grille.'),
      h('ul', { class: 'entry-list' }, ...rows),
      h('button', { class: 'btn btn-secondary', onclick: addPiece }, icon(ICONS.plus), 'Ajouter une pièce'),
      h(
        'button',
        {
          class: 'btn btn-primary',
          disabled: errs.length > 0,
          onclick: () => {
            setActiveSet(set.id);
            toast(`« ${set.name} » sera utilisé pour les nouvelles parties.`, 'ok');
            go({ kind: 'home' });
          },
        },
        'Utiliser ce jeu',
      ),
      h('p', { class: 'muted small' }, 'Les changements sont enregistrés automatiquement sur ce téléphone. Une même forme peut apparaître plusieurs fois avec des couleurs différentes.'),
    );
  }

  // ---------- éditeur de forme ----------
  let draft: { id: string | null; name: string; color: string; parts: Part[] } | null = null;
  let tool: 'full' | Corner | 'erase' = 'full';

  function shapeView(id: string | null, back: View): HTMLElement {
    if (!draft || draft.id !== id) {
      const existing = id ? customShapes().find((x) => x.id === id) : null;
      draft = { id, name: existing?.name ?? '', color: 'bleu', parts: existing ? existing.parts.map((p) => ({ ...p })) : [] };
    }
    const d = draft;
    const norm = normalizeParts(d.parts);
    const candidate: ShapeDef = { id: d.id ?? 'nouvelle', name: d.name.trim() || 'Sans nom', parts: norm };
    const err = d.parts.length ? shapeError(candidate) : 'Dessine la forme dans la grille.';

    // grille de dessin
    const SZ = 10;
    const svg = s('svg', { viewBox: `-1 -1 ${EDITOR_SIZE * SZ + 2} ${EDITOR_SIZE * SZ + 2}`, class: 'shape-canvas', role: 'grid', 'aria-label': 'Grille de dessin de la forme' });
    for (let r = 0; r < EDITOR_SIZE; r++) {
      for (let c = 0; c < EDITOR_SIZE; c++) {
        svg.append(s('rect', { x: c * SZ, y: r * SZ, width: SZ, height: SZ, class: 'canvas-cell' }));
      }
    }
    if (d.parts.length) {
      const g = partsThumb(d.parts, d.color).firstElementChild as SVGGElement;
      svg.append(g);
    }
    svg.addEventListener('click', (ev) => {
      const rect = svg.getBoundingClientRect();
      const k = rect.width / (EDITOR_SIZE * SZ + 2);
      const c = Math.floor(((ev as MouseEvent).clientX - rect.left) / k / SZ - 0.1);
      const r = Math.floor(((ev as MouseEvent).clientY - rect.top) / k / SZ - 0.1);
      if (r < 0 || c < 0 || r >= EDITOR_SIZE || c >= EDITOR_SIZE) return;
      const idx = d.parts.findIndex((p) => p.r === r && p.c === c);
      const want: Part | null = tool === 'erase' ? null : tool === 'full' ? { r, c } : { r, c, corner: tool };
      const same = idx >= 0 && want && d.parts[idx].corner === want.corner;
      if (idx >= 0) d.parts.splice(idx, 1);
      if (want && !same) d.parts.push(want);
      render();
    });

    const toolBtn = (t: typeof tool, label: string, content: Node) =>
      h('button', { class: `tool${tool === t ? ' active' : ''}`, 'aria-pressed': tool === t ? 'true' : 'false', 'aria-label': label, title: label, onclick: () => ((tool = t), render()) }, content);
    const cornerIcon = (cr: Corner) => {
      const pts = { SW: '4,4 4,20 20,20', NW: '4,4 20,4 4,20', NE: '4,4 20,4 20,20', SE: '20,4 20,20 4,20' }[cr];
      const el = s('svg', { viewBox: '0 0 24 24', class: 'icon', 'aria-hidden': 'true' });
      el.append(s('polygon', { points: pts, fill: 'currentColor' }));
      return el;
    };
    const fullIcon = s('svg', { viewBox: '0 0 24 24', class: 'icon', 'aria-hidden': 'true' }, s('rect', { x: 4, y: 4, width: 16, height: 16, fill: 'currentColor' }));

    const nameInput = h('input', { class: 'input', value: d.name, maxlength: 24, placeholder: 'Ex. : Zigzag', 'aria-label': 'Nom de la forme' });
    nameInput.addEventListener('input', () => {
      d.name = nameInput.value;
      const save = root.querySelector<HTMLButtonElement>('.save-shape');
      if (save) save.disabled = !!err || !d.name.trim();
    });
    const colorSel = h('select', { class: 'input select', 'aria-label': 'Couleur de l’aperçu' }, ...COLOR_IDS.map((c) => h('option', { value: c, selected: c === d.color }, COLORS[c].name)));
    colorSel.addEventListener('change', () => ((d.color = colorSel.value), render()));

    const previews = !err
      ? h('div', { class: 'rot-previews', 'aria-label': 'Les 4 orientations' }, ...[0, 1, 2, 3].map((rot) => partsThumb(rotateParts(norm, rot as 0 | 1 | 2 | 3), d.color, 13)))
      : null;

    return h(
      'main',
      { class: 'scroll' },
      h('label', { class: 'field' }, h('span', null, 'Nom'), nameInput),
      h('div', { class: 'toolbar six', role: 'toolbar', 'aria-label': 'Outils de dessin' }, toolBtn('full', 'Case pleine', fullIcon), ...CORNERS.map((cr) => toolBtn(cr, CORNER_LABEL[cr], cornerIcon(cr))), toolBtn('erase', 'Gomme', icon(ICONS.eraser))),
      h('div', { class: 'canvas-wrap' }, svg),
      h('p', { class: 'muted small' }, 'Touche une case pour la remplir avec l’outil choisi (touche-la encore pour l’effacer). Les côtés pleins arrêtent le laser, les diagonales le dévient. Au plus 12 cases, d’un seul tenant.'),
      err ? h('p', { class: 'error small', role: 'status' }, err) : h('p', { class: 'ok-text small', role: 'status' }, 'Forme valide.'),
      previews,
      h('label', { class: 'field' }, h('span', null, 'Couleur de l’aperçu (la couleur réelle se choisit dans le jeu)'), colorSel),
      h(
        'div',
        { class: 'btn-row' },
        h(
          'button',
          {
            class: 'btn btn-secondary',
            onclick: () => {
              d.parts = [];
              render();
            },
          },
          'Tout effacer',
        ),
        h(
          'button',
          {
            class: 'btn btn-primary save-shape',
            disabled: !!err || !d.name.trim(),
            onclick: () => {
              const shape: ShapeDef = { id: d.id ?? uid('f'), name: d.name.trim().slice(0, 24), parts: norm };
              const e2 = shapeError(shape);
              if (e2) return toast(e2, 'error');
              saveShape(shape);
              draft = null;
              toast(`Forme « ${shape.name} » enregistrée`, 'ok');
              go(back);
            },
          },
          'Enregistrer',
        ),
      ),
      h('p', { class: 'muted small' }, 'Donne un nom à la forme pour l’enregistrer.'),
    );
  }

  render();
  return root;
}
