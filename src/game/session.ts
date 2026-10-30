/**
 * Session d'UN joueur (tourne sur son appareil).
 *
 * - Garde le placement secret, le journal des tours, les notes, le jeu de pièces.
 * - Calcule elle-même le résultat des actions adverses (avec le moteur) et n'envoie
 *   que le résultat public.
 * - Jeu de pièces : choisi par l'hôte (joueur 0), envoyé à l'invité qui l'accepte
 *   ou le refuse avant de placer ses pièces.
 * - Ordre des tours : voir engine/turns.ts (réglage correctClaimPassesTurn).
 * - Reconnexion : chacun sauvegarde son état ; à la reconnexion les deux envoient
 *   'sync'. Un tour récupéré n'est jamais accepté aveuglément : il doit être joué par
 *   le bon joueur, et si j'étais le défenseur, je recalcule moi-même le résultat.
 */

import { RULES } from '../config/rules';
import {
  attackerAt,
  buildGrid,
  catalogOf,
  checkClaim,
  pieceDef,
  placementParts,
  setHash,
  traceLaser,
  validatePlacement,
  type Catalog,
  type Claim,
  type Edge,
  type PieceSet,
  type Placement,
} from '../engine';
import {
  PROTOCOL_VERSION,
  appFingerprint,
  parseMessage,
  type Action,
  type Message,
  type PlayerIndex,
  type PublicTurn,
  type Result,
  type SyncMessage,
} from './protocol';
import type { Transport } from './transport';

export type Mode = 'online' | 'local' | 'bot';

/** Marques libres du carnet de notes. */
export type NoteMark = 'x' | 'o' | '?';

/** Forme supposée d'une pièce adverse, posée dans le carnet. */
export type GuessShape = Placement;

export interface Notes {
  marks: Record<string, NoteMark>;
  guesses: GuessShape[];
}

/** Tour du journal. `secret` n'existe que chez le défenseur et n'est jamais envoyé. */
export interface TurnEntry extends PublicTurn {
  secret?: {
    hits: string[];
    path: { x: number; y: number }[];
    sunkId?: string;
  };
}

export interface PlayerState {
  v: 2;
  gameId: string;
  mode: Mode;
  me: PlayerIndex;
  myName: string;
  oppName: string;
  /** Jeu de la partie (pour l'invité : seulement après acceptation). */
  pieceSet: PieceSet | null;
  /** Invité : jeu proposé par l'hôte, pas encore accepté. */
  proposedSet: PieceSet | null;
  /** Invité : empreinte du jeu refusé. */
  refusedHash: string | null;
  /** Hôte : empreinte du jeu accepté par l'invité. */
  oppSetHash: string | null;
  /** Hôte : l'invité a refusé le jeu proposé. */
  oppRefused: boolean;
  /** Dernier identifiant de partie que j'ai généré (départage des revanches simultanées). */
  myNewGameId: string | null;
  placement: Placement[];
  ready: boolean;
  oppReady: boolean;
  firstPlayer: PlayerIndex | null;
  log: TurnEntry[];
  pending: { n: number; action: Action } | null;
  notes: Notes;
}

export type Phase = 'review' | 'setup' | 'waiting' | 'playing' | 'over';

export type SessionEvent =
  | { type: 'incoming'; entry: TurnEntry }
  | { type: 'outcome'; entry: TurnEntry }
  | { type: 'started'; firstPlayer: PlayerIndex }
  | { type: 'newgame' }
  | { type: 'set-proposed' }
  | { type: 'set-refused' }
  | { type: 'set-accepted' }
  | { type: 'error'; message: string };

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function newGameId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function freshState(mode: Mode, me: PlayerIndex, myName: string, gameId: string, pieceSet: PieceSet | null): PlayerState {
  return {
    v: 2,
    gameId,
    mode,
    me,
    myName,
    oppName: '',
    pieceSet,
    proposedSet: null,
    refusedHash: null,
    oppSetHash: null,
    oppRefused: false,
    myNewGameId: null,
    placement: [],
    ready: false,
    oppReady: false,
    firstPlayer: null,
    log: [],
    pending: null,
    notes: { marks: {}, guesses: [] },
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class PlayerSession {
  state: PlayerState;
  private transport: Transport | null = null;
  private changeListeners = new Set<() => void>();
  private eventListeners = new Set<(e: SessionEvent) => void>();
  private catalogCache: { hash: string; catalog: Catalog } | null = null;

  constructor(
    state: PlayerState,
    private store: KeyValueStore | null = null,
    private storeKey = '',
    private random: () => number = Math.random,
  ) {
    this.state = state;
  }

  static load(store: KeyValueStore, key: string): PlayerSession | null {
    try {
      const raw = store.getItem(key);
      if (!raw) return null;
      const st = JSON.parse(raw) as PlayerState;
      if (st?.v !== 2) return null; // anciennes sauvegardes (version 1) ignorées
      return new PlayerSession(st, store, key);
    } catch {
      return null;
    }
  }

  // ---------- abonnements ----------

  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  onEvent(fn: (e: SessionEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  private changed(): void {
    this.persist();
    for (const fn of this.changeListeners) fn();
  }

  private emit(e: SessionEvent): void {
    for (const fn of this.eventListeners) fn(e);
  }

  persist(): void {
    if (this.store && this.storeKey) {
      try {
        this.store.setItem(this.storeKey, JSON.stringify(this.state));
      } catch {
        /* stockage plein ou indisponible : on continue en mémoire */
      }
    }
  }

  // ---------- transport ----------

  get connected(): boolean {
    return !!this.transport?.connected;
  }

  attach(transport: Transport): void {
    if (this.transport && this.transport !== transport) {
      this.transport.onMessage = null;
      this.transport.onStatus = null;
    }
    this.transport = transport;
    transport.onMessage = (raw) => this.receive(raw);
    transport.onStatus = (up) => {
      if (up) this.sendSync();
      this.changed();
    };
    if (transport.connected) this.sendSync();
    this.changed();
  }

  detach(): void {
    if (this.transport) {
      this.transport.onMessage = null;
      this.transport.onStatus = null;
    }
    this.transport = null;
    this.changed();
  }

  private send(msg: Message): void {
    if (this.transport?.connected) this.transport.send(msg);
  }

  private sendSync(ask = false): void {
    const s = this.state;
    const msg: SyncMessage = {
      t: 'sync',
      v: PROTOCOL_VERSION,
      fp: appFingerprint(),
      gameId: s.gameId,
      me: s.me,
      name: s.myName,
      ready: s.ready,
      firstPlayer: s.firstPlayer,
      log: s.log.map(({ n, by, action, result }) => ({ n, by, action, result })),
      pending: s.pending,
      set: s.me === 0 ? s.pieceSet : null,
      setHash: s.pieceSet ? setHash(s.pieceSet) : null,
      ask,
    };
    this.send(msg);
  }

  // ---------- état dérivé ----------

  get opp(): PlayerIndex {
    return (1 - this.state.me) as PlayerIndex;
  }

  /** Catalogue du jeu de la partie (null tant que l'invité n'a pas accepté). */
  get catalog(): Catalog | null {
    const set = this.state.pieceSet;
    if (!set) return null;
    const hash = setHash(set);
    if (this.catalogCache?.hash !== hash) this.catalogCache = { hash, catalog: catalogOf(set) };
    return this.catalogCache.catalog;
  }

  get mySetHash(): string | null {
    return this.state.pieceSet ? setHash(this.state.pieceSet) : null;
  }

  attackerOf(n: number): PlayerIndex | null {
    const f = this.state.firstPlayer;
    return f === null ? null : attackerAt(f, this.state.log, n, RULES);
  }

  get winner(): PlayerIndex | null {
    const last = this.state.log[this.state.log.length - 1];
    return last?.result.gameOver ? last.by : null;
  }

  get phase(): Phase {
    const s = this.state;
    if (this.winner !== null) return 'over';
    if (!s.pieceSet) return 'review';
    if (!s.ready) return 'setup';
    if (!s.oppReady || s.firstPlayer === null) return 'waiting';
    return 'playing';
  }

  get isMyTurn(): boolean {
    return this.phase === 'playing' && this.attackerOf(this.state.log.length) === this.state.me;
  }

  /** Mes pièces coulées par l'adversaire. */
  get mySunk(): Set<string> {
    const out = new Set<string>();
    for (const e of this.state.log) if (e.by === this.opp && e.secret?.sunkId) out.add(e.secret.sunkId);
    return out;
  }

  /** Pièces adverses que j'ai coulées (déclarations exactes). */
  get oppSunk(): Claim[] {
    return this.state.log
      .filter((e) => e.by === this.state.me && e.action.kind === 'claim' && e.result.kind === 'claim' && e.result.ok)
      .map((e) => (e.action as { kind: 'claim'; claim: Claim }).claim);
  }

  // ---------- jeu de pièces ----------

  /** Invité : accepte le jeu proposé. */
  acceptProposedSet(): void {
    const s = this.state;
    if (!s.proposedSet) return;
    s.pieceSet = s.proposedSet;
    s.proposedSet = null;
    s.refusedHash = null;
    s.placement = [];
    this.send({ t: 'set-accept', hash: setHash(s.pieceSet) });
    this.emit({ type: 'set-accepted' });
    this.changed();
  }

  /** Invité : refuse le jeu proposé. */
  refuseProposedSet(): void {
    const s = this.state;
    if (!s.proposedSet) return;
    s.refusedHash = setHash(s.proposedSet);
    this.send({ t: 'set-refuse', hash: s.refusedHash });
    this.changed();
  }

  // ---------- actions du joueur ----------

  setPlacement(placement: Placement[]): void {
    if (this.state.ready) return;
    this.state.placement = placement;
    this.changed();
  }

  /** Valide le placement complet et annonce "Prêt". Retourne false si invalide. */
  markReady(): boolean {
    const cat = this.catalog;
    if (this.state.ready) return true;
    if (!cat || validatePlacement(this.state.placement, cat, { requireAll: true }).length > 0) return false;
    this.state.ready = true;
    this.send({ t: 'ready' });
    this.maybeStart();
    this.changed();
    return true;
  }

  shoot(edge: Edge): boolean {
    return this.act({ kind: 'shot', edge });
  }

  claim(claim: Claim): boolean {
    return this.act({ kind: 'claim', claim });
  }

  private act(action: Action): boolean {
    if (!this.isMyTurn || this.state.pending) return false;
    this.state.pending = { n: this.state.log.length, action };
    this.send({ t: 'action', n: this.state.pending.n, action });
    this.changed();
    return true;
  }

  /** Renvoie l'action en attente (bouton "Renvoyer" si la réponse tarde). */
  resendPending(): void {
    if (this.state.pending) this.send({ t: 'action', ...this.state.pending });
    else this.sendSync(true);
  }

  /**
   * Nouvelle partie (revanche) avec le même adversaire. L'hôte peut changer de jeu de
   * pièces à cette occasion (`set`) ; l'invité devra alors l'accepter.
   */
  startNewGame(set?: PieceSet): void {
    const gameId = newGameId();
    const s = this.state;
    const newSet = s.me === 0 && set ? set : null;
    this.resetFor(gameId, newSet);
    this.state.myNewGameId = gameId;
    this.send({ t: 'newgame', gameId, set: s.me === 0 ? this.state.pieceSet : null });
    this.emit({ type: 'newgame' });
    this.changed();
  }

  setNotes(notes: Notes): void {
    this.state.notes = notes;
    this.changed();
  }

  /** Repart de zéro pour une nouvelle partie, en gardant les noms et le jeu (sauf changement). */
  private resetFor(gameId: string, newSet: PieceSet | null): void {
    const s = this.state;
    const next = freshState(s.mode, s.me, s.myName, gameId, s.pieceSet);
    next.oppName = s.oppName;
    next.oppSetHash = s.oppSetHash;
    if (newSet && (!s.pieceSet || setHash(newSet) !== setHash(s.pieceSet))) {
      if (s.me === 0) {
        next.pieceSet = newSet;
        next.oppSetHash = null;
      } else {
        next.pieceSet = null;
        next.proposedSet = newSet;
      }
    }
    this.state = next;
  }

  // ---------- réception ----------

  receive(raw: unknown): void {
    const msg = parseMessage(raw);
    if (!msg) return;
    switch (msg.t) {
      case 'sync':
        this.onSync(msg);
        return;
      case 'ready':
        this.state.oppReady = true;
        this.maybeStart();
        this.changed();
        return;
      case 'start':
        if (this.state.me === 1 && this.state.firstPlayer === null && this.state.pieceSet) {
          this.state.firstPlayer = msg.firstPlayer;
          this.emit({ type: 'started', firstPlayer: msg.firstPlayer });
          this.changed();
        }
        return;
      case 'action':
        this.onAction(msg.n, msg.action);
        return;
      case 'result':
        this.onResult(msg.n, msg.result);
        return;
      case 'newgame':
        this.onNewGame(msg.gameId, msg.set);
        return;
      case 'set-accept':
        if (this.state.me === 0 && msg.hash === this.mySetHash) {
          this.state.oppSetHash = msg.hash;
          this.state.oppRefused = false;
          this.maybeStart();
          this.changed();
        }
        return;
      case 'set-refuse':
        if (this.state.me === 0 && msg.hash === this.mySetHash) {
          this.state.oppRefused = true;
          this.emit({ type: 'set-refused' });
          this.changed();
        }
        return;
    }
  }

  private onNewGame(gameId: string, set: PieceSet | null): void {
    const s = this.state;
    if (gameId === s.gameId) return;
    // Revanche demandée des deux côtés en même temps : le plus petit identifiant gagne.
    if (s.myNewGameId === s.gameId && s.log.length === 0 && s.gameId < gameId) {
      this.send({ t: 'newgame', gameId: s.gameId, set: s.me === 0 ? s.pieceSet : null });
      return;
    }
    this.resetFor(gameId, s.me === 1 ? set : null);
    if (this.state.proposedSet) this.emit({ type: 'set-proposed' });
    this.emit({ type: 'newgame' });
    this.sendSync();
    this.changed();
  }

  private onSync(msg: SyncMessage): void {
    const s = this.state;
    if (msg.v !== PROTOCOL_VERSION || msg.fp !== appFingerprint()) {
      this.emit({ type: 'error', message: 'Les deux téléphones n’ont pas la même version de l’app (règles ou couleurs différentes). Rechargez l’app sur les deux.' });
      return;
    }
    if (msg.me === s.me) {
      this.emit({ type: 'error', message: 'Les deux téléphones ont le même rôle : cette connexion ne correspond pas à la partie.' });
      return;
    }
    if (msg.gameId !== s.gameId) {
      if (!s.gameId && msg.me === 0) {
        s.gameId = msg.gameId; // l'invité rejoint la partie de l'hôte
      } else if (!msg.gameId && s.me === 0) {
        if (s.log.length > 0 || s.ready && s.oppReady) {
          this.emit({ type: 'error', message: 'Cette partie est déjà en cours avec un autre téléphone.' });
          return;
        }
      } else if (this.phase === 'over' && msg.log.length === 0) {
        // l'autre a lancé une revanche pendant que nous étions déconnectés
        this.resetFor(msg.gameId, s.me === 1 ? msg.set : null);
        this.emit({ type: 'newgame' });
        this.onSync(msg);
        return;
      } else if (msg.log.length > 0 && msg.log[msg.log.length - 1].result.gameOver && s.log.length === 0 && s.myNewGameId === s.gameId) {
        // j'ai lancé une revanche que l'autre n'a pas reçue : je la renvoie
        this.send({ t: 'newgame', gameId: s.gameId, set: s.me === 0 ? s.pieceSet : null });
        return;
      } else {
        this.emit({ type: 'error', message: 'Ce téléphone joue une autre partie. Lancez une nouvelle partie des deux côtés.' });
        return;
      }
    }
    if (msg.name) s.oppName = msg.name;
    s.oppReady = msg.ready;

    // Jeu de pièces
    if (s.me === 1 && msg.set) {
      const h = setHash(msg.set);
      if (!s.pieceSet || setHash(s.pieceSet) !== h) {
        if (s.log.length > 0 || s.ready) {
          this.emit({ type: 'error', message: 'Le jeu de pièces de l’autre téléphone a changé en cours de partie.' });
          return;
        }
        if (s.refusedHash !== h && !(s.proposedSet && setHash(s.proposedSet) === h)) {
          s.pieceSet = null;
          s.proposedSet = msg.set;
          s.placement = [];
          this.emit({ type: 'set-proposed' });
        }
      }
    }
    if (s.me === 0) {
      s.oppSetHash = msg.setHash;
      if (msg.setHash === this.mySetHash) s.oppRefused = false;
    }
    if (s.firstPlayer === null && msg.firstPlayer !== null && s.me === 1 && s.pieceSet) s.firstPlayer = msg.firstPlayer;

    this.mergeLog(msg.log);
    if (s.pending && s.pending.n < s.log.length) s.pending = null;

    this.maybeStart();
    this.changed();

    // Action de l'adversaire jamais reçue : on la traite maintenant.
    if (msg.pending && msg.pending.n === s.log.length) this.onAction(msg.pending.n, msg.pending.action);
    // Mon action jamais reçue par l'adversaire : je la renvoie.
    if (s.pending && s.pending.n === s.log.length && s.pending.n >= msg.log.length) {
      this.send({ t: 'action', n: s.pending.n, action: s.pending.action });
    }
    if (msg.ask) this.sendSync(false);
  }

  /** Complète le journal avec les tours manqués, sans faire confiance à l'autre. */
  private mergeLog(theirs: PublicTurn[]): void {
    const s = this.state;
    if (s.firstPlayer === null || !this.catalog) return;
    for (const turn of [...theirs].sort((a, b) => a.n - b.n)) {
      if (turn.n < s.log.length) continue;
      if (turn.n > s.log.length) break;
      if (this.winner !== null) break;
      if (turn.by !== this.attackerOf(turn.n)) {
        this.emit({ type: 'error', message: 'Journal incohérent reçu de l’autre téléphone (mauvais joueur) : ignoré.' });
        break;
      }
      if (turn.by === s.me) {
        // J'étais l'attaquant : je reprends le résultat calculé par l'autre,
        // à condition qu'il réponde bien à MON action.
        if (s.pending && s.pending.n === turn.n && !sameJson(s.pending.action, turn.action)) {
          this.emit({ type: 'error', message: 'Journal incohérent reçu de l’autre téléphone (action différente) : ignoré.' });
          break;
        }
        if (turn.action.kind !== turn.result.kind) break;
        const entry: TurnEntry = { n: turn.n, by: turn.by, action: turn.action, result: turn.result };
        s.log.push(entry);
        if (s.pending?.n === turn.n) {
          s.pending = null;
          this.emit({ type: 'outcome', entry });
        }
      } else {
        // J'étais le défenseur : je recalcule moi-même (alimente aussi mes pièces coulées).
        const entry = this.resolve(turn.n, turn.action);
        s.log.push(entry);
        if (!sameJson(entry.result, turn.result)) this.send({ t: 'result', n: entry.n, result: entry.result });
      }
    }
  }

  private maybeStart(): void {
    const s = this.state;
    if (s.me === 0 && s.ready && s.oppReady && s.firstPlayer === null && s.pieceSet && s.oppSetHash === this.mySetHash) {
      s.firstPlayer = (this.random() < 0.5 ? 0 : 1) as PlayerIndex;
      this.send({ t: 'start', firstPlayer: s.firstPlayer });
      this.emit({ type: 'started', firstPlayer: s.firstPlayer });
    }
  }

  private onAction(n: number, action: Action): void {
    const s = this.state;
    if (n < s.log.length) {
      const prev = s.log[n];
      if (prev.by === this.opp) this.send({ t: 'result', n, result: prev.result });
      return;
    }
    if (n > s.log.length) {
      // l'autre est en avance : il me manque des tours, je demande une resynchronisation
      this.sendSync(true);
      return;
    }
    if (this.phase !== 'playing' || this.attackerOf(n) !== this.opp) return;
    const entry = this.resolve(n, action);
    s.log.push(entry);
    this.send({ t: 'result', n, result: entry.result });
    this.emit({ type: 'incoming', entry });
    this.changed();
  }

  /** Calcule le résultat d'une action adverse sur MON plateau. */
  private resolve(n: number, action: Action): TurnEntry {
    const s = this.state;
    const cat = this.catalog!;
    const sunk = this.mySunk;
    const by = this.opp;
    if (action.kind === 'shot') {
      const removed = RULES.sunkPiecesAreRemoved ? sunk : new Set<string>();
      const res = traceLaser(buildGrid(s.placement, cat, removed), action.edge);
      const colors = res.hits.map((id) => pieceDef(id, cat)?.color).filter((c): c is string => !!c);
      return { n, by, action, result: { kind: 'shot', exit: res.exit, colors }, secret: { hits: res.hits, path: res.path } };
    }
    const check = checkClaim(s.placement, sunk, action.claim, cat);
    let gameOver = false;
    if (check.ok && check.pieceId) gameOver = cat.pieces.every((p) => p.id === check.pieceId || sunk.has(p.id));
    return {
      n,
      by,
      action,
      result: gameOver ? { kind: 'claim', ok: check.ok, gameOver } : { kind: 'claim', ok: check.ok },
      secret: { hits: [], path: [], sunkId: check.ok ? check.pieceId : undefined },
    };
  }

  private onResult(n: number, result: Result): void {
    const s = this.state;
    if (!s.pending || s.pending.n !== n || n !== s.log.length) return;
    if (s.pending.action.kind !== result.kind) return;
    const entry: TurnEntry = { n, by: s.me, action: s.pending.action, result };
    s.log.push(entry);
    s.pending = null;
    this.emit({ type: 'outcome', entry });
    this.changed();
  }
}

/** Cases occupées par une forme supposée du carnet. */
export function guessParts(g: GuessShape, catalog: Catalog) {
  return placementParts(g, catalog);
}
