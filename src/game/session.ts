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
import { SPELL_IDS } from '../engine/spells';
import { isValidSpellAction } from './protocol';
import {
  attackerAt,
  buildGrid,
  catalogOf,
  checkClaim,
  pieceDef,
  cellKey,
  cloneSpellConfig,
  colorsIn,
  DEFAULT_SPELL_CONFIG,
  diagCells,
  halfCells,
  lineCells,
  occupiedCells,
  placementParts,
  randomSpot,
  setHash,
  spellDef,
  traceLaser,
  tryRandomPlacement,
  validatePlacement,
  zoneCells,
  cellColor,
  type Catalog,
  type DiagName,
  type HalfName,
  type PieceDef,
  type SpellConfig,
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
  type SpellAction,
  type SpellResult,
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
    /** Tirs multiples (Double tir, Salve) : un trajet par tir. */
    paths?: { x: number; y: number }[][];
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
  /** Réglages des sorts de la partie (décidés par l'hôte). */
  spellCfg: SpellConfig;
  /** Ma réserve de sorts (privée). */
  spells: string[];
  /** Un sort Silence m'empêche de lancer un sort jusqu'à ma prochaine action. */
  silenced: boolean;
  /** Effets en attente sur le prochain tir reçu. */
  fx: { fog: boolean; decoy: boolean };
  /** Mes pièces ressuscitées (n = numéro du tour où j'ai lancé le sort). */
  revives: { n: number; id: string }[];
  /** Quel sort j'ai lancé au tour n quand il était secret. */
  selfLog: Record<string, string>;
}

export type Phase = 'review' | 'setup' | 'waiting' | 'playing' | 'over';

export type SessionEvent =
  | { type: 'incoming'; entry: TurnEntry }
  | { type: 'outcome'; entry: TurnEntry }
  | { type: 'started'; firstPlayer: PlayerIndex }
  | { type: 'newgame' }
  | { type: 'spell-gained'; spell: string }
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

export function freshState(mode: Mode, me: PlayerIndex, myName: string, gameId: string, pieceSet: PieceSet | null, spellCfg: SpellConfig = DEFAULT_SPELL_CONFIG): PlayerState {
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
    spellCfg: cloneSpellConfig(spellCfg),
    spells: [],
    silenced: false,
    fx: { fog: false, decoy: false },
    revives: [],
    selfLog: {},
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
      // sauvegardes d'avant les sorts : valeurs par défaut
      st.spellCfg ??= cloneSpellConfig(DEFAULT_SPELL_CONFIG);
      st.spells ??= [];
      st.silenced ??= false;
      st.fx ??= { fog: false, decoy: false };
      st.revives ??= [];
      st.selfLog ??= {};
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
      cfg: s.me === 0 ? s.spellCfg : null,
    };
    this.send(msg);
  }

  // ---------- état dérivé ----------

  get opp(): PlayerIndex {
    return (1 - this.state.me) as PlayerIndex;
  }

  /** Pièces ajoutées en cours de partie par le sort Intrus (pour le joueur `owner`). */
  private get extras(): { owner: PlayerIndex; def: PieceDef }[] {
    const set = this.state.pieceSet;
    const out: { owner: PlayerIndex; def: PieceDef }[] = [];
    if (!set) return out;
    const base = catalogOf(set).pieces;
    for (const e of this.state.log) {
      const r = e.result;
      if (r.kind !== 'spell' || r.spell !== 'addpiece' || !r.piece) continue;
      const p = r.piece;
      if (!set.shapes.some((sh) => sh.id === p.shape) || base.some((b) => b.id === p.id) || out.some((x) => x.def.id === p.id)) continue;
      out.push({ owner: (1 - e.by) as PlayerIndex, def: { id: p.id, shape: p.shape, color: p.color } });
    }
    return out;
  }

  /** Catalogue du jeu de la partie, pièces ajoutées comprises (null tant que l'invité n'a pas accepté). */
  get catalog(): Catalog | null {
    const set = this.state.pieceSet;
    if (!set) return null;
    const extras = this.extras;
    const key = setHash(set) + '|' + extras.map((x) => x.def.id).join(',');
    if (this.catalogCache?.hash !== key) {
      const base = catalogOf(set);
      this.catalogCache = { hash: key, catalog: { ...base, pieces: [...base.pieces, ...extras.map((x) => x.def)] } };
    }
    return this.catalogCache.catalog;
  }

  /** Mes pièces (jeu de base + pièces que l'adversaire m'a ajoutées). */
  get myPieces(): PieceDef[] {
    return this.piecesOf(this.state.me);
  }

  /** Pièces de l'adversaire (jeu de base + pièces que je lui ai ajoutées). */
  get oppPieces(): PieceDef[] {
    return this.piecesOf(this.opp);
  }

  private piecesOf(owner: PlayerIndex): PieceDef[] {
    const set = this.state.pieceSet;
    if (!set) return [];
    return [...catalogOf(set).pieces, ...this.extras.filter((x) => x.owner === owner).map((x) => x.def)];
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
    const revives = this.state.revives;
    for (const e of this.state.log) {
      if (e.by === this.opp && e.secret?.sunkId) out.add(e.secret.sunkId);
      for (const r of revives) if (r.n === e.n) out.delete(r.id);
    }
    for (const r of revives) if (r.n >= this.state.log.length) out.delete(r.id); // sort lancé, pas encore dans le journal
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
    this.state.silenced = false;
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
  startNewGame(set?: PieceSet, cfg?: SpellConfig): void {
    const gameId = newGameId();
    const s = this.state;
    const newSet = s.me === 0 && set ? set : null;
    this.resetFor(gameId, newSet, s.me === 0 ? cfg : undefined);
    this.state.myNewGameId = gameId;
    this.send({ t: 'newgame', gameId, set: s.me === 0 ? this.state.pieceSet : null, cfg: s.me === 0 ? this.state.spellCfg : null });
    this.emit({ type: 'newgame' });
    this.changed();
  }

  setNotes(notes: Notes): void {
    this.state.notes = notes;
    this.changed();
  }

  /** Repart de zéro pour une nouvelle partie, en gardant les noms et le jeu (sauf changement). */
  private resetFor(gameId: string, newSet: PieceSet | null, cfg?: SpellConfig | null): void {
    const s = this.state;
    const next = freshState(s.mode, s.me, s.myName, gameId, s.pieceSet, cfg ?? s.spellCfg);
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
        this.onNewGame(msg.gameId, msg.set, msg.cfg ?? null);
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

  private onNewGame(gameId: string, set: PieceSet | null, cfg: SpellConfig | null): void {
    const s = this.state;
    if (gameId === s.gameId) return;
    // Revanche demandée des deux côtés en même temps : le plus petit identifiant gagne.
    if (s.myNewGameId === s.gameId && s.log.length === 0 && s.gameId < gameId) {
      this.send({ t: 'newgame', gameId: s.gameId, set: s.me === 0 ? s.pieceSet : null, cfg: s.me === 0 ? s.spellCfg : null });
      return;
    }
    this.resetFor(gameId, s.me === 1 ? set : null, s.me === 1 ? cfg : null);
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
        this.resetFor(msg.gameId, s.me === 1 ? msg.set : null, s.me === 1 ? msg.cfg : null);
        this.emit({ type: 'newgame' });
        this.onSync(msg);
        return;
      } else if (msg.log.length > 0 && msg.log[msg.log.length - 1].result.gameOver && s.log.length === 0 && s.myNewGameId === s.gameId) {
        // j'ai lancé une revanche que l'autre n'a pas reçue : je la renvoie
        this.send({ t: 'newgame', gameId: s.gameId, set: s.me === 0 ? s.pieceSet : null, cfg: s.me === 0 ? s.spellCfg : null });
        return;
      } else {
        this.emit({ type: 'error', message: 'Ce téléphone joue une autre partie. Lancez une nouvelle partie des deux côtés.' });
        return;
      }
    }
    if (msg.name) s.oppName = msg.name;
    s.oppReady = msg.ready;
    if (s.me === 1 && msg.cfg && s.log.length === 0 && !s.ready) s.spellCfg = cloneSpellConfig(msg.cfg);

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
        if (turn.action.kind === 'spell' && turn.result.kind === 'spell' && turn.action.spell !== turn.result.spell) break;
        const entry: TurnEntry = { n: turn.n, by: turn.by, action: turn.action, result: turn.result };
        s.log.push(entry);
        this.afterMine(entry);
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
      const shot = this.fire([action.edge], sunk);
      return { n, by, action, result: { kind: 'shot', exit: shot.shots[0].exit, colors: shot.shots[0].colors }, secret: { hits: shot.hits, path: shot.paths[0], paths: shot.paths } };
    }
    if (action.kind === 'spell') return this.resolveSpell(n, action, sunk);
    const check = checkClaim(s.placement, sunk, action.claim, cat);
    let gameOver = false;
    if (check.ok && check.pieceId) gameOver = this.myPieces.every((p) => p.id === check.pieceId || sunk.has(p.id));
    return {
      n,
      by,
      action,
      result: gameOver ? { kind: 'claim', ok: check.ok, gameOver } : { kind: 'claim', ok: check.ok },
      secret: { hits: [], path: [], sunkId: check.ok ? check.pieceId : undefined },
    };
  }

  /** Un ou plusieurs tirs sur mon plateau, avec les effets Brume et Leurre. */
  private fire(edges: Edge[], sunk: Set<string>) {
    const s = this.state;
    const cat = this.catalog!;
    const removed = RULES.sunkPiecesAreRemoved ? sunk : new Set<string>();
    const grid = buildGrid(s.placement, cat, removed);
    const fx = s.fx;
    const palette = [...new Set(cat.pieces.map((p) => p.color))];
    const shots: { exit: Edge; colors: string[] }[] = [];
    const paths: { x: number; y: number }[][] = [];
    const hits: string[] = [];
    edges.forEach((edge, i) => {
      const res = traceLaser(grid, edge);
      let colors = res.hits.map((id) => pieceDef(id, cat)?.color).filter((c): c is string => !!c);
      if (fx.fog) colors = [];
      if (fx.decoy && i === 0 && palette.length) colors = [...colors, palette[Math.floor(this.random() * palette.length)]];
      shots.push({ exit: res.exit, colors });
      paths.push(res.path);
      hits.push(...res.hits);
    });
    fx.fog = false;
    fx.decoy = false;
    return { shots, paths, hits };
  }

  private resolveSpell(n: number, a: SpellAction, sunk: Set<string>): TurnEntry {
    const s = this.state;
    const cat = this.catalog!;
    const by = this.opp;
    const grid = buildGrid(s.placement, cat, RULES.sunkPiecesAreRemoved ? sunk : new Set<string>());
    const done = (r: Omit<SpellResult, 'kind' | 'spell'>, secret?: TurnEntry['secret']): TurnEntry => ({ n, by, action: a, result: { kind: 'spell', spell: a.spell, ...r }, secret });
    const scan = (cells: { r: number; c: number }[]) => done({ count: occupiedCells(grid, cells).length, colors: colorsIn(grid, cat, cells) });
    switch (a.spell) {
      case 'reveal': {
        const cell = { r: a.r ?? 0, c: a.c ?? 0 };
        const col = cellColor(grid, cat, cell);
        return done({ occ: !!col, colors: col ? [col] : [] });
      }
      case 'radar':
        return done({ count: occupiedCells(grid, lineCells(a.axis ?? 'row', a.index ?? 0)).length });
      case 'prisme':
        return done({ colors: colorsIn(grid, cat, lineCells(a.axis ?? 'row', a.index ?? 0)) });
      case 'sonar':
        return scan(zoneCells(a.r ?? 0, a.c ?? 0));
      case 'diag':
        return done({ count: occupiedCells(grid, diagCells(a.opt as DiagName)).length });
      case 'half':
        return done({ count: occupiedCells(grid, halfCells(a.opt as HalfName)).length });
      case 'colorscan': {
        let count = 0;
        for (let r = 0; r < grid.length; r++) for (let c = 0; c < grid[r].length; c++) if (cellColor(grid, cat, { r, c }) === a.color) count++;
        return done({ count });
      }
      case 'hint': {
        const all: { r: number; c: number }[] = [];
        for (let r = 0; r < grid.length; r++) for (let c = 0; c < grid[r].length; c++) if (grid[r][c]) all.push({ r, c });
        if (!all.length) return done({ count: 0 });
        const cell = all[Math.floor(this.random() * all.length)];
        return done({ r: cell.r, c: cell.c, colors: [cellColor(grid, cat, cell)!] });
      }
      case 'double':
      case 'salve': {
        const shot = this.fire(a.edges ?? [], sunk);
        return done({ shots: shot.shots }, { hits: shot.hits, path: shot.paths[0] ?? [], paths: shot.paths });
      }
      case 'shuffle': {
        const next = tryRandomPlacement({ ...cat, pieces: this.myPieces }, { random: this.random });
        if (next) s.placement = next;
        return done({});
      }
      case 'addpiece': {
        const set = s.pieceSet!;
        const base = catalogOf(set).pieces;
        const pick = base[Math.floor(this.random() * base.length)];
        const def: PieceDef = { id: `x${n}.${pick.shape}.${pick.color}`, shape: pick.shape, color: pick.color };
        const spot = randomSpot(s.placement, { ...cat, pieces: [...cat.pieces, def] }, def.id, this.random);
        if (!spot) return done({ piece: null });
        s.placement = [...s.placement, spot];
        return done({ piece: def });
      }
      case 'steal': {
        if (!s.spells.length) return done({ got: null });
        const got = s.spells.splice(Math.floor(this.random() * s.spells.length), 1)[0];
        return done({ got });
      }
      case 'silence':
        s.silenced = true;
        return done({});
      default: // freeze, self
        return done({});
    }
  }

  // ---------- sorts ----------

  /** Tire un sort au hasard dans la liste des sorts autorisés. */
  private gain(): void {
    const pool = this.state.spellCfg.pool.filter((id) => SPELL_IDS.includes(id));
    if (!pool.length) return;
    const id = pool[Math.floor(this.random() * pool.length)];
    this.state.spells.push(id);
    this.emit({ type: 'spell-gained', spell: id });
  }

  /** Suites d'un de MES tours une fois son résultat connu : sorts gagnés, notes mises à jour. */
  private afterMine(entry: TurnEntry): void {
    const s = this.state;
    const cfg = s.spellCfg;
    if (cfg.enabled) {
      const mine = s.log.filter((e) => e.by === s.me).length;
      if (cfg.everyTurns > 0 && mine % cfg.everyTurns === 0) this.gain();
      if (cfg.onSink && entry.result.kind === 'claim' && entry.result.ok) this.gain();
    }
    const r = entry.result;
    if (r.kind !== 'spell') return;
    if (r.spell === 'steal' && r.got && SPELL_IDS.includes(r.got)) s.spells.push(r.got);
    if (r.spell === 'shuffle') s.notes = { marks: {}, guesses: [] };
    if (r.spell === 'reveal' && entry.action.kind === 'spell') {
      const k = cellKey({ r: entry.action.r ?? 0, c: entry.action.c ?? 0 });
      s.notes = { ...s.notes, marks: { ...s.notes.marks, [k]: r.occ ? 'x' : 'o' } };
    }
    if (r.spell === 'hint' && r.r !== undefined && r.c !== undefined) {
      s.notes = { ...s.notes, marks: { ...s.notes.marks, [cellKey({ r: r.r, c: r.c })]: 'x' } };
    }
  }

  /** Pourquoi je ne peux pas lancer ce sort maintenant (null = possible). */
  spellBlocked(id: string): string | null {
    const s = this.state;
    if (!s.spellCfg.enabled) return 'Les sorts sont désactivés dans cette partie.';
    if (!this.isMyTurn || s.pending) return 'Seulement à ton tour.';
    if (s.silenced) return 'Tu es réduit au silence pour ce tour.';
    if (!s.spells.includes(id)) return 'Tu n’as pas ce sort.';
    if (id === 'revive' && this.mySunk.size === 0) return 'Aucune de tes pièces n’est coulée.';
    return null;
  }

  /** Lance un sort (remplace le tir du tour). Retourne false si impossible. */
  cast(id: string, params: Partial<SpellAction> = {}): boolean {
    const def = spellDef(id);
    if (!def || this.spellBlocked(id)) return false;
    const s = this.state;
    const n = s.log.length;
    let action: SpellAction;
    if (def.target === 'self') {
      action = { kind: 'spell', spell: 'self' };
    } else {
      action = { ...params, kind: 'spell', spell: id } as SpellAction;
      if (!isValidSpellAction(action as unknown as Record<string, unknown>)) return false;
    }
    s.spells.splice(s.spells.indexOf(id), 1);
    if (def.target === 'self') {
      if (!this.applySelf(id, n)) {
        s.spells.push(id);
        return false;
      }
      s.selfLog[String(n)] = id;
    }
    return this.act(action);
  }

  /** Effet d'un sort secret sur mon propre plateau. */
  private applySelf(id: string, n: number): boolean {
    const s = this.state;
    const rnd = () => this.random();
    switch (id) {
      case 'revive': {
        const ids = [...this.mySunk];
        if (!ids.length) return false;
        s.revives.push({ n, id: ids[Math.floor(rnd() * ids.length)] });
        return true;
      }
      case 'fog':
        s.fx.fog = true;
        return true;
      case 'decoy':
        s.fx.decoy = true;
        return true;
      case 'relocate': {
        const sunk = this.mySunk;
        const alive = s.placement.filter((p) => !sunk.has(p.pieceId));
        if (!alive.length) return false;
        const cat = this.catalog!;
        for (let i = 0; i < 5; i++) {
          const chosen = alive[Math.floor(rnd() * alive.length)];
          const others = s.placement.filter((p) => p.pieceId !== chosen.pieceId);
          const spot = randomSpot(others, cat, chosen.pieceId, rnd);
          if (spot) {
            s.placement = s.placement.map((p) => (p.pieceId === chosen.pieceId ? spot : p));
            return true;
          }
        }
        return false;
      }
      case 'draw':
        this.gain();
        this.gain();
        return true;
    }
    return false;
  }

  private onResult(n: number, result: Result): void {
    const s = this.state;
    if (!s.pending || s.pending.n !== n || n !== s.log.length) return;
    if (s.pending.action.kind !== result.kind) return;
    if (s.pending.action.kind === 'spell' && result.kind === 'spell' && s.pending.action.spell !== result.spell) return;
    const entry: TurnEntry = { n, by: s.me, action: s.pending.action, result };
    s.log.push(entry);
    this.afterMine(entry);
    s.pending = null;
    this.emit({ type: 'outcome', entry });
    this.changed();
  }
}

/** Cases occupées par une forme supposée du carnet. */
export function guessParts(g: GuessShape, catalog: Catalog) {
  return placementParts(g, catalog);
}
