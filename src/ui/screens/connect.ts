/**
 * Écran de connexion entre deux téléphones (échange manuel de codes).
 * Ce module gère son propre affichage (pas de re-rendu global pendant la saisie).
 */

import { PeerLink } from '../../net/peer';
import { extractCode, decodeDesc } from '../../net/sdpCodec';
import { qrSvg, startScanner, type Scanner } from '../../net/qr';
import type { PlayerSession } from '../../game/session';
import { h, icon, toast } from '../dom';
import { ICONS } from '../icons';
import type { App } from '../app';

export type ConnectRole = 'host' | 'guest';

export interface ConnectOptions {
  session: PlayerSession;
  role: ConnectRole;
  /** Reconnexion d'une partie en cours (le rôle peut être changé). */
  reconnect: boolean;
  prefill?: string;
}

const CONNECT_TIMEOUT_MS = 30000;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

async function shareText(text: string, title: string): Promise<void> {
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  if (await copyText(text)) toast('Copié ! Colle-le dans un message.', 'ok');
  else toast('Impossible de copier automatiquement : sélectionne le code à la main.', 'warn');
}

export function inviteUrl(code: string): string {
  return `${location.origin}${location.pathname}#c=${code}`;
}

export function renderConnect(app: App, opts: ConnectOptions): { el: HTMLElement; dispose: () => void } {
  let link: PeerLink | null = null;
  let scanner: Scanner | null = null;
  let scanStarting = false;
  /** Un code est en cours de traitement : on ignore un second collage ou scan. */
  let busy = false;
  let timeout: number | undefined;
  let disposed = false;
  let role: ConnectRole = opts.role;

  const body = h('div', { class: 'connect-body' });
  const status = h('div', { class: 'connect-status', role: 'status', 'aria-live': 'polite' });

  const setStatus = (text: string, kind: 'info' | 'ok' | 'warn' | 'error' | 'busy' = 'info') => {
    status.className = `connect-status status-${kind}`;
    status.replaceChildren(kind === 'busy' ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : '', h('span', null, text));
  };

  const stopScanner = () => {
    scanner?.stop();
    scanner = null;
  };

  const dispose = () => {
    disposed = true;
    stopScanner();
    if (timeout) clearTimeout(timeout);
    // Si on quitte sans être connecté, on ferme la tentative.
    if (link && !link.connected) link.close();
  };

  const newLink = () => {
    if (link && !link.connected) link.close();
    link = new PeerLink();
    opts.session.attach(link);
    link.onState = (st) => {
      if (disposed) return;
      if (st === 'open') {
        if (timeout) clearTimeout(timeout);
        setStatus('Connecté !', 'ok');
        app.onConnected(opts.session, link!);
      } else if (st === 'failed') {
        setStatus('La connexion a échoué. Vérifiez que les deux téléphones ont internet, puis recommencez.', 'error');
      } else if (st === 'connecting') {
        setStatus('Connexion en cours…', 'busy');
        if (timeout) clearTimeout(timeout);
        timeout = window.setTimeout(() => {
          if (!link?.connected) {
            setStatus(
              'La connexion ne s’établit pas. Essayez sur le même wifi, ou passez un des téléphones en 4G/5G, puis recommencez. Certains réseaux bloquent les connexions directes.',
              'warn',
            );
          }
        }, CONNECT_TIMEOUT_MS);
      }
    };
    return link;
  };

  /** Bloc "lire un code" : scanner, coller, ou saisir. */
  const codeInput = (label: string, onCode: (text: string) => void, prefill = '') => {
    const ta = h('textarea', {
      class: 'input code-input',
      rows: 3,
      placeholder: 'Colle le code ici (il commence par BB1.)',
      autocapitalize: 'off',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': label,
    });
    ta.value = prefill;
    const video = h('video', { class: 'scanner-video', playsinline: true, muted: true, 'aria-label': 'Caméra' });
    const scanBox = h('div', { class: 'scanner hidden' }, video, h('div', { class: 'scanner-frame', 'aria-hidden': 'true' }));
    const submit = () => {
      const text = ta.value.trim();
      if (!extractCode(text)) {
        toast('Code invalide ou incomplet. Vérifie le copier-coller.', 'error');
        return;
      }
      onCode(text);
    };
    const scanBtn = h(
      'button',
      {
        class: 'btn btn-secondary',
        onclick: async () => {
          if (scanner || scanStarting) {
            stopScanner();
            scanBox.classList.add('hidden');
            return;
          }
          scanStarting = true; // évite un double démarrage de la caméra
          scanBox.classList.remove('hidden');
          try {
            scanner = await startScanner(video, (text) => {
              scanner = null;
              scanBox.classList.add('hidden');
              ta.value = text;
              if (extractCode(text)) onCode(text);
              else toast('Ce QR code ne contient pas de code Boatbattle.', 'warn');
            });
          } catch (e) {
            scanBox.classList.add('hidden');
            toast(`Caméra indisponible : ${(e as Error).message || 'accès refusé'}. Colle le code à la place.`, 'warn', 4500);
          } finally {
            scanStarting = false;
            if (disposed) stopScanner();
          }
        },
      },
      icon(ICONS.camera),
      'Scanner',
    );
    const pasteBtn = h(
      'button',
      {
        class: 'btn btn-secondary',
        onclick: async () => {
          try {
            const text = await navigator.clipboard.readText();
            ta.value = text;
            if (extractCode(text)) onCode(text);
            else toast('Le presse-papiers ne contient pas de code.', 'warn');
          } catch {
            ta.focus();
            toast('Appuie longuement dans la zone de texte puis « Coller ».', 'info', 4000);
          }
        },
      },
      icon(ICONS.paste),
      'Coller',
    );
    return h(
      'div',
      { class: 'code-reader' },
      h('div', { class: 'btn-row' }, scanBtn, pasteBtn),
      scanBox,
      ta,
      h('button', { class: 'btn btn-primary', onclick: submit }, 'Valider le code'),
    );
  };

  /** Bloc "montrer un code" : QR + partager + copier. */
  const codeOutput = (qrText: string, shareMsg: string, rawCode: string) => {
    const details = h('details', { class: 'raw-code' }, h('summary', null, 'Voir le code texte'), h('code', null, rawCode));
    return h(
      'div',
      { class: 'code-output' },
      h('div', { class: 'qr', html: qrSvg(qrText) }),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn btn-primary', onclick: () => shareText(shareMsg, 'Boatbattle') }, icon(ICONS.share), 'Partager'),
        h(
          'button',
          {
            class: 'btn btn-secondary',
            onclick: async () => toast((await copyText(shareMsg)) ? 'Code copié' : 'Copie impossible', 'ok'),
          },
          icon(ICONS.copy),
          'Copier',
        ),
      ),
      details,
    );
  };

  const step = (n: number, title: string, ...content: (Node | null)[]) =>
    h('section', { class: 'step' }, h('h2', null, h('span', { class: 'step-num' }, String(n)), title), ...content);

  // ---------- hôte ----------
  const runHost = async () => {
    body.replaceChildren(step(1, 'Envoie l’invitation', h('p', { class: 'muted' }, 'Préparation du code…')));
    setStatus('Recherche des adresses réseau…', 'busy');
    const l = newLink();
    let code: string;
    try {
      code = await l.createOffer();
    } catch (e) {
      setStatus(`Impossible de créer le code : ${(e as Error).message}`, 'error');
      return;
    }
    if (disposed) return;
    const url = inviteUrl(code);
    body.replaceChildren(
      step(
        1,
        'Envoie l’invitation',
        h('p', { class: 'muted' }, 'Fais scanner ce QR par l’autre téléphone avec le bouton « Scanner » de Boatbattle, ou partage le lien par message. (Avec l’appareil photo de l’iPhone, le lien s’ouvre dans Safari et non dans l’app installée.)'),
        codeOutput(url, `Partie Boatbattle ! Ouvre ce lien ou colle ce code dans l’app :\n${url}`, code),
      ),
      step(
        2,
        'Récupère sa réponse',
        h('p', { class: 'muted' }, 'L’autre téléphone affiche alors un code de réponse : scanne-le ou colle-le ici.'),
        codeInput('Code de réponse', async (text) => {
          if (busy || l.state !== 'waiting-answer') {
            toast('Réponse déjà prise en compte : connexion en cours…', 'info', 2500);
            return;
          }
          busy = true;
          try {
            const d = decodeDesc(text);
            if (d.type !== 'answer') throw new Error('C’est un code d’invitation : il faut le code de RÉPONSE de l’autre téléphone.');
            stopScanner();
            await l.acceptAnswer(text);
          } catch (e) {
            toast((e as Error).message, 'error', 4500);
          } finally {
            busy = false;
          }
        }),
      ),
    );
    setStatus('En attente de la réponse de l’autre téléphone.', 'info');
  };

  // ---------- invité ----------
  const runGuest = () => {
    const onInvite = async (text: string) => {
      if (busy) return; // double collage : un seul code à la fois
      stopScanner();
      let d;
      try {
        d = decodeDesc(text);
      } catch (e) {
        toast((e as Error).message, 'error');
        return;
      }
      if (d.type !== 'offer') {
        toast('C’est un code de réponse : il se colle sur le téléphone qui a créé la partie.', 'error', 4500);
        return;
      }
      setStatus('Préparation de la réponse…', 'busy');
      busy = true;
      const l = newLink();
      let answer: string;
      try {
        answer = await l.acceptOffer(text);
      } catch (e) {
        setStatus(`Code refusé : ${(e as Error).message}`, 'error');
        return;
      } finally {
        busy = false;
      }
      if (disposed) return;
      body.replaceChildren(
        step(
          2,
          'Renvoie ta réponse',
          h('p', { class: 'muted' }, 'Montre ce QR à l’autre téléphone, ou envoie-lui le code. La connexion se fera toute seule.'),
          codeOutput(answer, `Réponse Boatbattle :\n${answer}`, answer),
        ),
      );
      setStatus('En attente de l’autre téléphone…', 'busy');
    };
    body.replaceChildren(
      step(
        1,
        'Lis l’invitation',
        h('p', { class: 'muted' }, 'Scanne le QR affiché par l’autre téléphone, ou colle le code reçu par message.'),
        codeInput('Code d’invitation', onInvite, opts.prefill ?? ''),
      ),
    );
    setStatus('En attente du code d’invitation.', 'info');
    if (opts.prefill && extractCode(opts.prefill)) void onInvite(opts.prefill);
  };

  const start = () => {
    stopScanner();
    if (role === 'host') void runHost();
    else runGuest();
  };

  const roleSwitch = opts.reconnect
    ? h(
        'div',
        { class: 'segmented', role: 'tablist', 'aria-label': 'Qui crée le code ?' },
        ...(['host', 'guest'] as const).map((r) =>
          h(
            'button',
            {
              role: 'tab',
              class: `seg ${r === role ? 'active' : ''}`,
              'aria-selected': r === role ? 'true' : 'false',
              onclick: (e: Event) => {
                role = r;
                (e.currentTarget as HTMLElement).parentElement!.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b === e.currentTarget));
                start();
              },
            },
            r === 'host' ? 'Je crée le code' : 'J’ai reçu un code',
          ),
        ),
      )
    : null;

  const el = h(
    'div',
    { class: 'screen connect' },
    h(
      'header',
      { class: 'topbar' },
      h('button', { class: 'icon-btn', 'aria-label': 'Retour', onclick: () => app.leaveConnect() }, icon(ICONS.chevronLeft)),
      h('h1', null, opts.reconnect ? 'Reconnexion' : role === 'host' ? 'Créer une partie' : 'Rejoindre une partie'),
    ),
    h(
      'main',
      { class: 'scroll' },
      opts.reconnect ? h('p', { class: 'muted' }, 'La partie est sauvegardée sur chaque téléphone. Un des deux crée un code, l’autre le lit : le jeu reprend où il en était.') : null,
      roleSwitch,
      status,
      body,
      h(
        'aside',
        { class: 'tips' },
        h('strong', null, 'Conseils'),
        h('ul', null, h('li', null, 'Restez sur cet écran pendant l’échange des codes.'), h('li', null, 'Sur iPhone, quitter l’app ou verrouiller l’écran peut couper la connexion : la partie reprendra avec « Reconnecter ».'), h('li', null, 'À distance, ça marche dans la plupart des cas ; certains réseaux mobiles ou d’entreprise bloquent les connexions directes.')),
      ),
    ),
  );
  start();
  return { el, dispose };
}
