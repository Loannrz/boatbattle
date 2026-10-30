/**
 * Abstraction du canal de communication entre les deux joueurs.
 * - WebRTC (deux téléphones) : src/net/peer.ts
 * - Local (un seul appareil, ou robot) : createLocalPair() ci-dessous
 */

import type { Message } from './protocol';

export interface Transport {
  readonly connected: boolean;
  send(msg: Message): void;
  onMessage: ((msg: unknown) => void) | null;
  onStatus: ((connected: boolean) => void) | null;
  close(): void;
}

/** Deux transports reliés en mémoire. Les messages sont livrés de façon asynchrone. */
export function createLocalPair(): [LocalTransport, LocalTransport] {
  const a = new LocalTransport();
  const b = new LocalTransport();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

export class LocalTransport implements Transport {
  peer: LocalTransport | null = null;
  connected = true;
  onMessage: ((msg: unknown) => void) | null = null;
  onStatus: ((connected: boolean) => void) | null = null;
  /** Pour les tests : si vrai, les messages envoyés sont perdus. */
  dropOutgoing = false;

  send(msg: Message): void {
    if (!this.connected || this.dropOutgoing) return;
    const json = JSON.stringify(msg); // copie, comme sur le réseau
    const peer = this.peer;
    setTimeout(() => peer?.connected && peer.onMessage?.(json), 0);
  }

  close(): void {
    this.connected = false;
    this.onStatus?.(false);
  }
}
