/**
 * Connexion en étoile : chaque invité n'est relié qu'à l'hôte, qui relaie les messages.
 *
 *  Invité i  --lien WebRTC-->  Hôte (HubHost)  --lien WebRTC-->  Invité j
 *
 * Sur un lien circulent des textes JSON :
 *  - à l'arrivée d'un invité : { t:'hello', me, gameId, name } puis la réponse de l'hôte
 *    { t:'welcome', you } ou { t:'reject', reason } ;
 *  - ensuite des enveloppes { t:'env', to, msg } (invité → hôte) et { t:'env', from, msg }
 *    (hôte → invité). L'hôte, seul à connaître le lien d'origine, fixe `from` : un invité ne
 *    peut pas se faire passer pour un autre. L'hôte voit passer les messages qu'il relaie
 *    (choix accepté : pas de chiffrement de bout en bout entre invités).
 *
 * Tout ce qui arrive est vérifié (forme, bornes) avant d'être traité ou relayé ; la charge
 * utile est validée par la session destinataire (game/protocol.ts).
 */

import { MAX_PLAYERS, type PlayerIndex } from '../engine/turns';
import type { Message } from '../game/protocol';
import { isPlayer } from '../game/protocol';
import type { Recipient, Transport } from '../game/transport';

/** Lien brut entre deux appareils (WebRTC en pratique). */
export interface RawLink {
  readonly connected: boolean;
  /** Retourne false si l'envoi a échoué (canal fermé, message trop gros). */
  sendRaw(text: string): boolean;
  onMessage: ((text: string) => void) | null;
  onStatus: ((connected: boolean) => void) | null;
  close(): void;
}

const MAX_TEXT = 200_000;
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

function parse(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string' || text.length > MAX_TEXT) return null;
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

export interface HelloInfo {
  me: PlayerIndex | null;
  gameId: string;
  name: string;
  /** Jeton de la place, reçu dans `welcome` à la première connexion (exigé à la reconnexion). */
  token?: string | null;
}

export type Admit = (hello: HelloInfo) => { ok: true; index: PlayerIndex; token: string } | { ok: false; reason: string };

/** Un lien qui n'a rien dit au bout de ce délai est fermé. */
const HELLO_TIMEOUT_MS = 30_000;

/** Côté hôte : accueille les liens des invités et relaie. */
export class HubHost implements Transport {
  private links = new Map<PlayerIndex, RawLink>();
  private pending = new Set<RawLink>();
  onMessage: ((msg: unknown, from: PlayerIndex) => void) | null = null;
  onStatus: ((connected: boolean) => void) | null = null;
  onPeer: ((peer: PlayerIndex, up: boolean) => void) | null = null;
  /** Un invité vient d'être accepté (pour l'écran de salon). */
  onAdmitted: ((peer: PlayerIndex) => void) | null = null;

  constructor(private admit: Admit) {}

  get connected(): boolean {
    for (const l of this.links.values()) if (l.connected) return true;
    return false;
  }

  peerConnected(peer: PlayerIndex): boolean {
    return !!this.links.get(peer)?.connected;
  }

  link(peer: PlayerIndex): RawLink | undefined {
    return this.links.get(peer);
  }

  /** Message qu'un lien n'a pas pu envoyer (trop gros, canal fermé) : à signaler. */
  onSendFailed: ((to: PlayerIndex | 'all') => void) | null = null;
  private helloTimers = new Map<RawLink, ReturnType<typeof setTimeout>>();

  /** Un nouveau lien : on attend un `hello` VALIDE (au plus 30 s après son ouverture). */
  addLink(link: RawLink): void {
    this.pending.add(link);
    const arm = () => {
      this.disarm(link);
      this.helloTimers.set(
        link,
        setTimeout(() => {
          this.helloTimers.delete(link);
          if (this.pending.has(link)) this.forget(link);
        }, HELLO_TIMEOUT_MS),
      );
    };
    link.onMessage = (text) => this.onPendingText(link, text);
    link.onStatus = (up) => {
      if (up) arm();
      else {
        this.disarm(link);
        this.pending.delete(link);
      }
    };
    if (link.connected) arm();
  }

  private disarm(link: RawLink): void {
    const t = this.helloTimers.get(link);
    if (t !== undefined) clearTimeout(t);
    this.helloTimers.delete(link);
  }

  /** Détache et ferme un lien dont on ne veut plus. */
  private forget(link: RawLink, delayMs = 0): void {
    this.disarm(link);
    this.pending.delete(link);
    link.onMessage = null;
    link.onStatus = null;
    if (delayMs > 0) setTimeout(() => link.close(), delayMs);
    else link.close();
  }

  private onPendingText(link: RawLink, text: string): void {
    const m = parse(text);
    if (!m || m.t !== 'hello') return; // le délai continue de courir
    const me = m.me === null ? null : isPlayer(m.me) ? m.me : undefined;
    if (me === undefined || typeof m.gameId !== 'string' || m.gameId.length > 64) return;
    if (m.token !== undefined && m.token !== null && !(typeof m.token === 'string' && m.token.length <= 64)) return;
    const name = typeof m.name === 'string' ? m.name.slice(0, 40) : '';
    const verdict = this.admit({ me, gameId: m.gameId, name, token: (m.token as string | null | undefined) ?? null });
    if (!verdict.ok) {
      link.sendRaw(JSON.stringify({ t: 'reject', reason: verdict.reason }));
      this.forget(link, 300); // le refus part, puis le lien est fermé et plus écouté
      return;
    }
    this.disarm(link);
    this.pending.delete(link);
    const idx = verdict.index;
    const old = this.links.get(idx);
    if (old && old !== link) {
      old.onMessage = null;
      old.onStatus = null;
      old.close();
    }
    this.links.set(idx, link);
    link.onMessage = (t) => this.onText(idx, link, t);
    link.onStatus = (up) => {
      if (up) return;
      if (this.links.get(idx) === link) {
        this.links.delete(idx);
        this.onPeer?.(idx, false);
        if (!this.connected) this.onStatus?.(false);
      }
    };
    const wasConnected = this.connected && this.links.size > 1;
    link.sendRaw(JSON.stringify({ t: 'welcome', you: idx, token: verdict.token }));
    this.onAdmitted?.(idx);
    if (!wasConnected) this.onStatus?.(true);
    this.onPeer?.(idx, true);
  }

  private onText(from: PlayerIndex, link: RawLink, text: string): void {
    if (this.links.get(from) !== link) return;
    const m = parse(text);
    if (!m || m.t !== 'env' || !('msg' in m) || !isObj(m.msg)) return;
    const to = m.to;
    if (!(to === 'all' || isPlayer(to))) return;
    if (to === 'all' || to === 0) this.onMessage?.(m.msg, from);
    if (to === 0) return;
    const relay = JSON.stringify({ t: 'env', from, msg: m.msg });
    for (const [idx, l] of this.links) {
      if (idx === from) continue;
      if (to !== 'all' && idx !== to) continue;
      if (l.connected && !l.sendRaw(relay)) this.onSendFailed?.(idx);
    }
  }

  send(msg: Message, to: Recipient): void {
    const text = JSON.stringify({ t: 'env', from: 0, msg });
    for (const [idx, l] of this.links) {
      if (to !== 'all' && idx !== to) continue;
      if (l.connected && !l.sendRaw(text)) this.onSendFailed?.(idx);
    }
  }

  /** Salon : un invité change de place (après le retrait d'un autre). */
  reassign(from: PlayerIndex, to: PlayerIndex): void {
    const old = this.links.get(to);
    if (old) {
      this.links.delete(to);
      old.onMessage = null;
      old.onStatus = null;
      old.close();
    }
    const l = this.links.get(from);
    if (!l) return;
    this.links.delete(from);
    this.links.set(to, l);
    l.onMessage = (t) => this.onText(to, l, t);
    l.onStatus = (up) => {
      if (up) return;
      if (this.links.get(to) === l) {
        this.links.delete(to);
        this.onPeer?.(to, false);
        if (!this.connected) this.onStatus?.(false);
      }
    };
  }

  /** Ferme le lien d'un invité (retiré du salon). */
  drop(peer: PlayerIndex): void {
    const l = this.links.get(peer);
    if (!l) return;
    this.links.delete(peer);
    l.onMessage = null;
    l.onStatus = null;
    l.close();
    this.onPeer?.(peer, false);
  }

  close(): void {
    for (const l of this.links.values()) {
      l.onMessage = null;
      l.onStatus = null;
      l.close();
    }
    for (const l of this.pending) l.close();
    this.links.clear();
    this.pending.clear();
  }
}

/** Côté invité : un seul lien, vers l'hôte. */
export class HubGuest implements Transport {
  private welcomed = false;
  onMessage: ((msg: unknown, from: PlayerIndex) => void) | null = null;
  onStatus: ((connected: boolean) => void) | null = null;
  onPeer: ((peer: PlayerIndex, up: boolean) => void) | null = null;
  /** Place et jeton attribués par l'hôte (avant `onStatus(true)`). */
  onWelcome: ((you: PlayerIndex, token: string) => void) | null = null;
  onReject: ((reason: string) => void) | null = null;
  /** Message impossible à envoyer (trop gros, canal fermé). */
  onSendFailed: ((to: PlayerIndex | 'all') => void) | null = null;

  constructor(
    private link: RawLink,
    private hello: HelloInfo,
  ) {
    link.onMessage = (text) => this.onText(text);
    link.onStatus = (up) => {
      if (up) this.sayHello();
      else if (this.welcomed) {
        this.welcomed = false;
        this.onStatus?.(false);
      }
    };
    if (link.connected) this.sayHello();
  }

  get connected(): boolean {
    return this.welcomed && this.link.connected;
  }

  /** Seul l'hôte est joignable directement ; la présence des autres invités vient de l'hôte (message 'presence'). */
  peerConnected(_peer: PlayerIndex): boolean {
    return this.connected;
  }

  private sayHello(): void {
    this.link.sendRaw(JSON.stringify({ t: 'hello', me: this.hello.me, gameId: this.hello.gameId, name: this.hello.name, token: this.hello.token ?? null }));
  }

  private onText(text: string): void {
    const m = parse(text);
    if (!m) return;
    if (!this.welcomed) {
      if (m.t === 'welcome' && isPlayer(m.you) && m.you !== 0 && typeof m.token === 'string' && m.token.length > 0 && m.token.length <= 64) {
        this.welcomed = true;
        this.hello = { ...this.hello, me: m.you, token: m.token };
        this.onWelcome?.(m.you, m.token);
        this.onStatus?.(true);
      } else if (m.t === 'reject') {
        this.onReject?.(typeof m.reason === 'string' ? m.reason.slice(0, 200) : 'Connexion refusée par l’hôte.');
        this.link.close();
      }
      return;
    }
    // `from` est fixé par l'hôte ; la session ignore d'elle-même ce qui viendrait de sa propre place.
    if (m.t !== 'env' || !isPlayer(m.from) || !isObj(m.msg)) return;
    this.onMessage?.(m.msg, m.from);
  }

  send(msg: Message, to: Recipient): void {
    if (!this.connected) return;
    if (to !== 'all' && to >= MAX_PLAYERS) return;
    if (!this.link.sendRaw(JSON.stringify({ t: 'env', to, msg }))) this.onSendFailed?.(to);
  }

  close(): void {
    this.link.onMessage = null;
    this.link.onStatus = null;
    this.link.close();
    if (this.welcomed) {
      this.welcomed = false;
      this.onStatus?.(false);
    }
  }
}
