import '@fontsource/newsreader/latin-400.css';
import '@fontsource/newsreader/latin-600.css';
import './styles.css';
import { App } from './ui/app';
import { installPatternDefs } from './ui/boardView';
import { h } from './ui/dom';

installPatternDefs();

// Empêche le zoom par pincement sur iOS (le double-tap est bloqué par touch-action en CSS).
document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });

const root = document.getElementById('app')!;
new App(root);

/**
 * Service worker : fonctionnement hors ligne (production uniquement).
 * Une nouvelle version est téléchargée en arrière-plan ; la page ouverte garde l'ancienne
 * jusqu'au prochain chargement. On propose donc de recharger (la partie est sauvegardée).
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || document.querySelector('.update-bar')) return;
      const bar = h(
        'div',
        { class: 'update-bar', role: 'status' },
        h('span', null, 'Nouvelle version prête.'),
        h('button', { class: 'btn btn-sm btn-primary', onclick: () => location.reload() }, 'Recharger'),
        h('button', { class: 'btn btn-sm btn-ghost', 'aria-label': 'Plus tard', onclick: () => bar.remove() }, 'Plus tard'),
      );
      document.body.append(bar);
    });
  });
}
