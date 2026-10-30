import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Génère public/sw.js au moment du build, avec la liste exacte des fichiers
 * à mettre en cache pour le hors-ligne (noms avec empreinte générés par Vite).
 */
function serviceWorker(): Plugin {
  return {
    name: 'boatbattle-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const extra = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];
      const assets = [...new Set([...extra, ...files])];
      const version = createHash('sha256').update(assets.join('|')).update(String(Date.now())).digest('hex').slice(0, 12);
      const source = `// Généré au build. Ne pas modifier à la main.
const CACHE = 'boatbattle-${version}';
const ASSETS = ${JSON.stringify(assets)};

self.addEventListener('install', (event) => {
  // cache: 'reload' : on contourne le cache HTTP pour ne pas figer une ancienne version
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // Pages : réseau d'abord (pour recevoir les mises à jour), cache si hors ligne.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req, { cache: 'no-cache' }).catch(() => caches.match('index.html', { ignoreSearch: true })));
    return;
  }
  // Fichiers statiques (noms avec empreinte) : cache d'abord.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })),
  );
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  // Chemins relatifs : fonctionne à la racine d'un domaine comme dans un sous-dossier (GitHub Pages).
  base: './',
  plugins: [serviceWorker()],
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
