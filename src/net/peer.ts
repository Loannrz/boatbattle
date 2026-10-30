/**
 * Connexion pair à pair WebRTC avec signalisation manuelle (échange de codes).
 *
 *  Téléphone A (crée)            Téléphone B (rejoint)
 *  createOffer() -> code A  ---> acceptOffer(code A) -> code B
 *  acceptAnswer(code B) <-------------------------------'
 *  ... canal de données ouvert des deux côtés.
 *
 * Pas de "trickle ICE" : on attend la fin de la collecte des adresses pour que tout
 * tienne dans un seul code. Le canal de données est "négocié" (id 0), pas besoin
 * d'échange supplémentaire. Un message de vie (ping) détecte les coupures.
 */

import { HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS, ICE_GATHER_TIMEOUT_MS, ICE_SERVERS } from '../config/network';
import type { Message } from '../game/protocol';
import type { Transport } from '../game/transport';
import { buildSdp, decodeDesc, encodeDesc, parseSdp } from './sdpCodec';

export type LinkState = 'new' | 'waiting-answer' | 'connecting' | 'open' | 'closed' | 'failed';

export class PeerLink implements Transport {
  private pc: RTCPeerConnection;
  private dc: RTCDataChannel;
  private heartbeat: number | undefined;
  private lastSeen = 0;
  state: LinkState = 'new';
  onMessage: ((msg: unknown) => void) | null = null;
  onStatus: ((connected: boolean) => void) | null = null;
  /** Changement d'état détaillé (pour l'écran de connexion). */
  onState: ((s: LinkState) => void) | null = null;

  constructor() {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.dc = this.pc.createDataChannel('boatbattle', { negotiated: true, id: 0, ordered: true });
    this.dc.onopen = () => this.setState('open');
    this.dc.onclose = () => this.setState('closed');
    this.dc.onmessage = (ev) => {
      this.lastSeen = Date.now();
      if (ev.data === '{"t":"ping"}') return; // message de vie
      this.onMessage?.(ev.data);
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed') this.setState('failed');
      if (s === 'closed') this.setState('closed');
    };
  }

  get connected(): boolean {
    return this.state === 'open' && this.dc.readyState === 'open';
  }

  private setState(s: LinkState): void {
    if (this.state === s) return;
    const wasOpen = this.state === 'open';
    // Après une fermeture/échec, on ne revient pas en arrière.
    if ((this.state === 'closed' || this.state === 'failed') && s !== 'closed') return;
    this.state = s;
    this.onState?.(s);
    if (s === 'open') {
      this.lastSeen = Date.now();
      this.startHeartbeat();
      this.onStatus?.(true);
    } else if (wasOpen) {
      this.stopHeartbeat();
      this.onStatus?.(false);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = window.setInterval(() => {
      if (Date.now() - this.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        this.close();
        return;
      }
      this.rawSend('{"t":"ping"}');
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) window.clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private rawSend(s: string): void {
    try {
      if (this.dc.readyState === 'open') this.dc.send(s);
    } catch {
      /* canal en cours de fermeture */
    }
  }

  send(msg: Message): void {
    this.rawSend(JSON.stringify(msg));
  }

  close(): void {
    this.stopHeartbeat();
    try {
      this.dc.close();
      this.pc.close();
    } catch {
      /* déjà fermé */
    }
    this.setState('closed');
  }

  /** Attend la fin de la collecte des candidats ICE (ou un délai raisonnable). */
  private waitForIce(): Promise<void> {
    return new Promise((resolve) => {
      if (this.pc.iceGatheringState === 'complete') return resolve();
      let srflxSeen = false;
      let early: number | undefined;
      const done = () => {
        window.clearTimeout(timer);
        if (early) window.clearTimeout(early);
        this.pc.removeEventListener('icegatheringstatechange', onState);
        this.pc.removeEventListener('icecandidate', onCand);
        resolve();
      };
      const onState = () => this.pc.iceGatheringState === 'complete' && done();
      const onCand = (e: RTCPeerConnectionIceEvent) => {
        if (!e.candidate) return done();
        // Dès qu'on a une adresse publique, on laisse encore un court délai puis on y va.
        if (!srflxSeen && / typ srflx /.test(e.candidate.candidate)) {
          srflxSeen = true;
          early = window.setTimeout(done, 1200);
        }
      };
      const timer = window.setTimeout(done, ICE_GATHER_TIMEOUT_MS);
      this.pc.addEventListener('icegatheringstatechange', onState);
      this.pc.addEventListener('icecandidate', onCand);
    });
  }

  private localCode(type: 'offer' | 'answer'): string {
    const sdp = this.pc.localDescription?.sdp;
    if (!sdp) throw new Error('Description locale absente');
    const desc = parseSdp(sdp, type);
    if (desc.candidates.length === 0) throw new Error('Aucune adresse réseau trouvée. Vérifiez la connexion (wifi ou données mobiles).');
    return encodeDesc(desc);
  }

  /** Téléphone A : crée le code d'invitation. */
  async createOffer(): Promise<string> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.waitForIce();
    this.setState('waiting-answer');
    return this.localCode('offer');
  }

  /** Téléphone B : lit le code d'invitation et produit le code de réponse. */
  async acceptOffer(text: string): Promise<string> {
    const desc = decodeDesc(text);
    if (desc.type !== 'offer') throw new Error("Ce code est un code de réponse : il faut le coller sur le téléphone qui a créé l'invitation.");
    await this.pc.setRemoteDescription({ type: 'offer', sdp: buildSdp(desc) });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.waitForIce();
    this.setState('connecting');
    return this.localCode('answer');
  }

  /** Téléphone A : lit le code de réponse ; la connexion s'établit ensuite toute seule. */
  async acceptAnswer(text: string): Promise<void> {
    const desc = decodeDesc(text);
    if (desc.type !== 'answer') throw new Error("Ce code est un code d'invitation. Il faut coller le code de RÉPONSE affiché par l'autre téléphone.");
    this.setState('connecting');
    await this.pc.setRemoteDescription({ type: 'answer', sdp: buildSdp(desc) });
  }
}
