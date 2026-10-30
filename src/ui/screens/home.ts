import { setStats } from '../../engine';
import { h, icon, modal } from '../dom';
import { ICONS } from '../icons';
import { activeSet } from '../library';
import { claimRuleText } from './game';
import type { App } from '../app';

export function rulesContent(): HTMLElement {
  return h(
    'div',
    { class: 'rules' },
    h('p', null, 'Chaque joueur cache ses pièces sur sa grille de 10 × 10 (colonnes A à J, lignes 1 à 10). Les deux joueurs ont le même jeu de pièces, choisi par celui qui crée la partie.'),
    h('p', null, 'À ton tour, tire un laser depuis un bord : une colonne par le haut ou le bas, ou une ligne par la gauche ou la droite.'),
    h(
      'ul',
      null,
      h('li', null, 'Case vide : le laser la traverse.'),
      h('li', null, 'Face plate (carré, barre, L, ou côtés de l’angle droit d’un triangle) : il revient par où il est entré.'),
      h('li', null, 'Diagonale d’un triangle (le miroir) : il tourne à 90°. Un grand triangle a une longue diagonale : le laser y rebondit où qu’il l’atteigne.'),
      h('li', null, 'On annonce où il ressort, et les couleurs touchées dans l’ordre.'),
    ),
    h('p', null, `Au lieu de tirer, tu peux déclarer une pièce adverse (couleur, forme et toutes ses cases). ${claimRuleText()} Le premier qui coule toutes les pièces adverses gagne.`),
  );
}

export function renderHome(app: App): HTMLElement {
  const resume = app.savedGameSummary();
  const set = activeSet();
  const stats = setStats(set);
  const nameInput = h('input', {
    id: 'name',
    class: 'input',
    type: 'text',
    maxlength: 20,
    autocomplete: 'given-name',
    value: app.myName(),
    placeholder: 'Ton prénom',
    oninput: (e: Event) => app.setMyName((e.target as HTMLInputElement).value),
  });

  const big = (label: string, sub: string, ic: string, onclick: () => void, kind = 'secondary') =>
    h('button', { class: `menu-btn btn-${kind}`, onclick }, icon(ic), h('span', { class: 'menu-text' }, h('strong', null, label), h('small', null, sub)));

  return h(
    'main',
    { class: 'screen home' },
    h(
      'header',
      { class: 'hero' },
      h('div', { class: 'logo', 'aria-hidden': 'true', html: logoSvg() }),
      h('h1', { class: 'brand' }, 'Boatbattle'),
      h('p', { class: 'tagline' }, 'Bataille navale aux lasers et miroirs'),
    ),
    h('label', { class: 'field' }, h('span', null, 'Ton prénom'), nameInput),
    resume ? big('Reprendre la partie', resume, ICONS.play, () => app.resume(), 'primary') : null,
    h('h2', { class: 'section-title' }, 'Deux téléphones'),
    big('Créer une partie', `Avec le jeu « ${set.name} » (${stats.pieces} pièces)`, ICONS.link, () => app.startOnline('host'), resume ? 'secondary' : 'primary'),
    big('Rejoindre une partie', 'Scanne ou colle le code reçu', ICONS.camera, () => app.startOnline('guest')),
    h('h2', { class: 'section-title' }, 'Un seul téléphone'),
    big('Se passer le téléphone', 'Deux joueurs, chacun son tour', ICONS.users, () => app.startLocal()),
    big('S’entraîner contre un robot', 'Le robot tire au hasard', ICONS.robot, () => app.startBot()),
    h('h2', { class: 'section-title' }, 'Pièces'),
    big('Réglages des pièces', `Jeu actuel : ${set.name} · créer des jeux et des formes`, ICONS.shapes, () => app.openSettings()),
    h('button', { class: 'btn btn-ghost', onclick: () => modal('Règles du jeu', rulesContent(), [{ label: 'Compris', value: 'ok', kind: 'primary' }]) }, icon(ICONS.book), 'Règles du jeu'),
    h('p', { class: 'footnote' }, 'Aucun compte, aucun serveur : les téléphones se parlent directement. Le placement de tes pièces ne quitte jamais ton téléphone.'),
  );
}

/** Logo : une feuille quadrillée, un triangle de papier et le fil rouge qui rebondit. */
export function logoSvg(): string {
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="6" width="54" height="54" rx="3" fill="#2f2a22" opacity=".12"/><rect x="4" y="4" width="54" height="54" rx="3" fill="#fbf8f1" stroke="#cfc6b6"/><path d="M13 4v54M22 4v54M31 4v54M40 4v54M49 4v54M4 13h54M4 22h54M4 31h54M4 40h54M4 49h54" stroke="#8f887c" stroke-width=".5" opacity=".6"/><path d="M31 13H49V31Z" fill="#9A6DAF" stroke="#5f3f70" stroke-width=".8"/><rect x="31" y="40" width="18" height="9" fill="#3F6FAE" stroke="#27466f" stroke-width=".8"/><path d="M4 35.5H40V22H4" fill="none" stroke="#B3261E" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
}
