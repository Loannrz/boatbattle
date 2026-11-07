/**
 * Abstraction du canal de communication entre les joueurs (2 à 4).
 *
 * Chaque session envoie des messages à un joueur précis ou à tous ; elle reçoit chaque
 * message avec l'indice de son expéditeur. Deux réalisations :
 *  - en étoile par WebRTC (chaque invité relié à l'hôte, qui relaie) : src/net/hub.ts ;
 *  - en mémoire (un seul appareil, robot, tests) : createLocalPair() / createLocalHub().
 */

import type { Message, PlayerIndex } from './protocol';

export type Recipient = PlayerIndex | 'all';

export interface Transport {
  /** Mon lien est ouvert (pour l'hôte : au moins un invité connecté). */
  readonly connected: boolean;
  /** Ce joueur est-il joignable en ce moment ? */
  peerConnected(peer: PlayerIndex): boolean;
  send(msg: Message, to: Recipient): void;
  onMessage: ((msg: unknown, from: PlayerIndex) => void) | null;
  /** Mon propre lien monte ou descend. */
  onStatus: ((connected: boolean) => void) | null;
  /** Un joueur précis devient joignable ou non (hôte : à chaque invité). */
  onPeer: ((peer: PlayerIndex, up: boolean) => void) | null;
  /** Hôte, dans le salon : un invité change de place. */
  reassign?(from: PlayerIndex, to: PlayerIndex): void;
  /** Hôte : coupe le lien d'un invité (retiré du salon). */
  drop?(peer: PlayerIndex): void;
  close(): void;
}

/** Hub en mémoire : `n` transports reliés entre eux, livraison asynchrone (comme sur le réseau). */
export class LocalHub {
  readonly ports: LocalTransport[] = [];
  constructor(n: number) {
    for (let i = 0; i < n; i++) this.ports.push(new LocalTransport(i as PlayerIndex, this));
  }
  deliver(from: PlayerIndex, to: Recipient, json: string): void {
    for (const p of this.ports) {
      if (p.me === from) continue;
      if (to !== 'all' && p.me !== to) continue;
      if (!p.connected || !this.ports[from].connected) continue;
      setTimeout(() => p.connected && p.onMessage?.(json, from), 0);
    }
  }
  /** Simule la coupure (ou le retour) du joueur `i` : les autres en sont avertis. */
  setConnected(i: PlayerIndex, up: boolean): void {
    const p = this.ports[i];
    if (p.connected === up) return;
    p.connected = up;
    p.onStatus?.(up);
    for (const q of this.ports) if (q !== p && q.connected) q.onPeer?.(i, up);
  }
}

/** Deux transports reliés en mémoire (joueurs 0 et 1). */
export function createLocalPair(): [LocalTransport, LocalTransport] {
  const hub = new LocalHub(2);
  return [hub.ports[0], hub.ports[1]];
}

/** `n` transports reliés en mémoire (tests à 3 ou 4 joueurs). */
export function createLocalHub(n: number): LocalHub {
  return new LocalHub(n);
}

export class LocalTransport implements Transport {
  connected = true;
  onMessage: ((msg: unknown, from: PlayerIndex) => void) | null = null;
  onStatus: ((connected: boolean) => void) | null = null;
  onPeer: ((peer: PlayerIndex, up: boolean) => void) | null = null;
  /** Pour les tests : si vrai, les messages envoyés sont perdus. */
  dropOutgoing = false;

  constructor(
    readonly me: PlayerIndex,
    private hub: LocalHub,
  ) {}

  peerConnected(peer: PlayerIndex): boolean {
    return this.connected && !!this.hub.ports[peer]?.connected;
  }

  send(msg: Message, to: Recipient): void {
    if (!this.connected || this.dropOutgoing) return;
    this.hub.deliver(this.me, to, JSON.stringify(msg)); // copie, comme sur le réseau
  }

  close(): void {
    this.hub.setConnected(this.me, false);
  }
}
