/**
 * Session d'UN joueur (tourne sur son appareil), dans une partie de 2 à 4 joueurs.
 *
 * - Garde le placement secret, le journal des tours, les carnets (un par adversaire), le
 *   jeu de pièces, la réserve de sorts.
 * - Calcule elle-même le résultat des actions qui visent SA grille (avec le moteur) et
 *   n'envoie que le résultat public : version complète au lanceur, version masquée aux
 *   autres pour les sorts privés.
 * - Jeu de pièces et réglages : choisis par l'hôte (joueur 0), envoyés aux invités qui les
 *   acceptent ou les refusent avant de placer leurs pièces.
 * - Salon : l'hôte accueille les invités (places 1 à 3) puis lance la partie ; les places
 *   sont alors figées.
 * - Ordre des tours, éliminations : voir engine/turns.ts.
 * - Reconnexion : chacun sauvegarde son état ; à la reconnexion on s'échange des 'sync'.
 *   Un tour récupéré n'est jamais accepté aveuglément : il doit être joué par le bon
 *   joueur sur une cible valide, et si ma grille est visée, je recalcule moi-même.
 */

import { RULES } from '../config/rules';
import { SPELL_IDS, spellsFor } from '../engine/spells';
import { isValidSpellAction } from './protocol';
import {
  MAX_PLAYERS,
  alivePlayersAt,
  attackerAt,
  orderAt,
  buildGrid,
  catalogOf,
  checkClaim,
  pieceDef,
  blockCells,
  cellKey,
  centerCells,
  cloneSpellConfig,
  eliminatedAt,
  forcedTargetAt,
  pivotSpot,
  ringCells,
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
  isPlayer,
  parseMessage,
  type Action,
  type Activity,
  type Message,
  type PendingAction,
  type PlayerIndex,
  type PublicTurn,
  type Result,
  type SpellAction,
  type SpellResult,
  type SyncMessage,
} from './protocol';
import type { Recipient, Transport } from './transport';

export type Mode = 'online' | 'local' | 'bot';

/** Marques libres du carnet de notes. */
export type NoteMark = 'x' | 'o' | '?';

/** Forme supposée d'une pièce adverse, posée dans le carnet. */
export type GuessShape = Placement;

export interface Notes {
  marks: Record<string, NoteMark>;
  guesses: GuessShape[];
}

export const EMPTY_NOTES: Notes = { marks: {}, guesses: [] };

/** Tour du journal. `secret` n'existe que chez le défenseur et n'est jamais envoyé. */
export interface TurnEntry extends PublicTurn {
  secret?: {
    hits: string[];
    path: { x: number; y: number }[];
    /** Tirs multiples (Double tir, Salve, Rafale) : un trajet par tir. */
    paths?: { x: number; y: number }[][];
    sunkId?: string;
  };
}

/** Un joueur de la partie (l'indice dans `players` est sa place). */
export interface PlayerSlot {
  name: string;
  ready: boolean;
  /** Hôte : empreinte du jeu accepté par ce joueur. */
  setHash: string | null;
  /** Hôte : ce joueur a refusé le jeu proposé. */
  refused: boolean;
  /**
   * Jeton secret de la place (hôte : pour chaque invité ; invité : le sien). Il est donné
   * à l'arrivée et exigé à la reconnexion : personne ne peut prendre la place d'un autre.
   */
  token?: string;
}

export interface PlayerState {
  v: 3;
  gameId: string;
  mode: Mode;
  me: PlayerIndex;
  myName: string;
  /** Joueurs de la partie (2 à 4). L'hôte fait autorité sur cette liste. */
  players: PlayerSlot[];
  /** La partie est lancée (salon fermé, places figées). */
  launched: boolean;
  /** Jeu de la partie (pour l'invité : seulement après acceptation). */
  pieceSet: PieceSet | null;
  /** Invité : jeu proposé par l'hôte, pas encore accepté. */
  proposedSet: PieceSet | null;
  /** Invité : empreinte du jeu refusé. */
  refusedHash: string | null;
  /** Dernier identifiant de partie que j'ai généré (hôte). */
  myNewGameId: string | null;
  placement: Placement[];
  ready: boolean;
  firstPlayer: PlayerIndex | null;
  log: TurnEntry[];
  pending: PendingAction | null;
  /** Carnets, un par adversaire (clé : indice du joueur). */
  notes: Record<string, Notes>;
  /** Réglages des sorts de la partie (décidés par l'hôte). */
  spellCfg: SpellConfig;
  /** Ma réserve de sorts (privée). */
  spells: string[];
  /** Un sort Silence m'empêche de lancer un sort jusqu'à ma prochaine action. */
  silenced: boolean;
  /** Effets en attente sur le prochain tir reçu. */
  fx: { fog: boolean; decoy: boolean; mirage?: boolean; camouflage?: boolean };
  /** Mes pièces ressuscitées (n = numéro du tour où j'ai lancé le sort). */
  revives: { n: number; id: string }[];
  /** Quel sort j'ai lancé au tour n quand il était secret. */
  selfLog: Record<string, string>;
}

export type Phase = 'lobby' | 'review' | 'setup' | 'waiting' | 'playing' | 'over';

export type SessionEvent =
  | { type: 'incoming'; entry: TurnEntry }
  | { type: 'outcome'; entry: TurnEntry }
  /** Tour entre deux autres joueurs (ou sort d'un autre joueur sur lui-même). */
  | { type: 'turn'; entry: TurnEntry }
  | { type: 'started'; firstPlayer: PlayerIndex }
  | { type: 'newgame' }
  | { type: 'spell-gained'; spell: string }
  | { type: 'set-proposed' }
  | { type: 'set-refused'; by: PlayerIndex }
  | { type: 'set-accepted' }
  | { type: 'roster' }
  | { type: 'eliminated'; player: PlayerIndex }
  | { type: 'error'; message: string };

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Ce qu'un invité annonce en arrivant sur le hub de l'hôte. */
export interface Hello {
  me: PlayerIndex | null;
  gameId: string;
  name: string;
  /** Jeton reçu à la première connexion (reconnexion). */
  token?: string | null;
}

export function newGameId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const emptySlot = (name = ''): PlayerSlot => ({ name, ready: false, setHash: null, refused: false });

function newToken(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function freshState(mode: Mode, me: PlayerIndex, myName: string, gameId: string, pieceSet: PieceSet | null, spellCfg: SpellConfig = DEFAULT_SPELL_CONFIG, players?: string[]): PlayerState {
  const names = players ?? (me === 0 ? [myName] : Array.from({ length: me + 1 }, (_, i) => (i === me ? myName : '')));
  return {
    v: 3,
    gameId,
    mode,
    me,
    myName,
    players: names.map((n, i) => emptySlot(i === me ? myName : n)),
    launched: mode !== 'online',
    pieceSet,
    proposedSet: null,
    refusedHash: null,
    myNewGameId: null,
    placement: [],
    ready: false,
    firstPlayer: null,
    log: [],
    pending: null,
    notes: {},
    spellCfg: cloneSpellConfig(spellCfg),
    spells: [],
    silenced: false,
    fx: { fog: false, decoy: false },
    revives: [],
    selfLog: {},
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Nombre minimal de joueurs ENCORE EN JEU pour qu'un sort ait un effet : Double saut, Inversion,
 * Relais et Diversion n'ont aucun sens à deux (Saut : le lanceur rejoue, ce qui reste un effet).
 */
export function minAliveFor(id: string): number {
  return id === 'doubleskip' || id === 'reverse' || id === 'relay' || id === 'divert' ? 3 : 2;
}

/** Un sort que le lanceur résout lui-même (secret, sa grille, ordre des tours). */
function isOwnAction(a: Action): boolean {
  if (a.kind !== 'spell') return false;
  if (a.spell === 'self') return true;
  const d = spellDef(a.spell);
  return !!d && d.target === 'own';
}

export class PlayerSession {
  state: PlayerState;
  private transport: Transport | null = null;
  private changeListeners = new Set<() => void>();
  private eventListeners = new Set<(e: SessionEvent) => void>();
  private catalogCache: { hash: string; catalog: Catalog } | null = null;
  /** Ce que fait chaque joueur (éphémère, non sauvegardé). */
  activities: Partial<Record<PlayerIndex, Activity>> = {};
  private myActivity: Activity | null = null;
  /** Invité : présence des autres joueurs, annoncée par l'hôte (éphémère). */
  private presence: boolean[] = [];
  /** Longueur du journal de chaque joueur d'après son dernier 'sync' (éphémère) : on n'envoie que la suite. */
  private peerLen: Partial<Record<PlayerIndex, number>> = {};

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
      if (st?.v !== 3) return null; // anciennes sauvegardes (versions 1 et 2, à deux joueurs) ignorées
      if (!Array.isArray(st.players) || !isPlayer(st.me) || !Array.isArray(st.log) || st.players.length <= st.me) return null;
      st.notes ??= {};
      st.spells ??= [];
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

  private refresh(): void {
    for (const fn of this.changeListeners) fn(); // rien à sauvegarder
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

  /** Ce joueur est-il joignable ? (toujours vrai hors ligne : un seul appareil) */
  isOnline(i: PlayerIndex): boolean {
    if (this.state.mode !== 'online') return true;
    if (i === this.state.me) return this.connected;
    if (!this.connected) return false;
    if (this.state.me === 0) return !!this.transport?.peerConnected(i);
    return i === 0 ? true : this.presence[i] === true;
  }

  attach(transport: Transport): void {
    if (this.transport && this.transport !== transport) {
      this.transport.onMessage = null;
      this.transport.onStatus = null;
      this.transport.onPeer = null;
    }
    this.transport = transport;
    this.peerLen = {}; // nouvelle connexion : on repart d'un échange complet
    transport.onMessage = (raw, from) => this.receive(raw, from);
    transport.onStatus = (up) => {
      if (up) {
        this.sendSyncAll(true);
        if (this.myActivity) this.send({ t: 'activity', a: this.myActivity }, 'all');
      } else this.activities = {};
      this.changed();
    };
    transport.onPeer = (peer, up) => this.onPeer(peer, up);
    if (transport.connected) this.sendSyncAll(true);
    this.changed();
  }

  detach(): void {
    if (this.transport) {
      this.transport.onMessage = null;
      this.transport.onStatus = null;
      this.transport.onPeer = null;
    }
    this.transport = null;
    this.changed();
  }

  private send(msg: Message, to: Recipient): void {
    if (this.transport?.connected) this.transport.send(msg, to);
  }

  /** Hôte : un invité se connecte ou se déconnecte. */
  private onPeer(peer: PlayerIndex, up: boolean): void {
    const s = this.state;
    if (s.me !== 0) return;
    if (up) {
      while (!s.launched && s.players.length <= peer && s.players.length < MAX_PLAYERS) s.players.push(emptySlot());
      this.sendSync(peer, true);
      this.sendRoster();
    } else {
      delete this.activities[peer];
    }
    this.send({ t: 'presence', online: s.players.map((_, i) => this.isOnline(i as PlayerIndex)) }, 'all');
    this.emit({ type: 'roster' });
    this.changed();
  }

  private sendRoster(): void {
    const s = this.state;
    if (s.me !== 0) return;
    this.send({ t: 'roster', players: s.players.map((p) => p.name), launched: s.launched }, 'all');
  }

  /**
   * Hôte : un invité se présente sur le hub. Retourne sa place, ou une raison de refus.
   * `me` null = nouvel invité (place libre attribuée) ; sinon reconnexion à sa place.
   */
  admit(hello: Hello): { ok: true; index: PlayerIndex; token: string } | { ok: false; reason: string } {
    const s = this.state;
    if (s.me !== 0) return { ok: false, reason: 'Ce téléphone n’est pas l’hôte.' };
    if (hello.me === null) {
      if (s.launched) return { ok: false, reason: 'La partie est déjà lancée : on ne peut plus la rejoindre.' };
      for (let i = 1; i < MAX_PLAYERS; i++) {
        const idx = i as PlayerIndex;
        if (idx < s.players.length && this.isOnline(idx)) continue;
        while (s.players.length <= idx) s.players.push(emptySlot());
        const token = newToken();
        s.players[idx] = { ...emptySlot(), token }; // place neuve : l'ancien occupant éventuel (parti) est oublié
        this.persist();
        return { ok: true, index: idx, token };
      }
      return { ok: false, reason: 'La partie est complète (4 joueurs).' };
    }
    if (hello.me === 0) return { ok: false, reason: 'Deux téléphones ne peuvent pas être l’hôte de la même partie.' };
    if (hello.me >= s.players.length) return { ok: false, reason: 'Cette place n’existe pas dans la partie.' };
    // Un identifiant de partie différent n'est pas bloquant : le jeton prouve la place, et la
    // synchronisation remettra le joueur à niveau (par exemple s'il a raté une revanche).
    const expected = s.players[hello.me].token;
    if (!expected || hello.token !== expected) return { ok: false, reason: 'Ce téléphone n’est pas le joueur de cette place (jeton de reconnexion invalide).' };
    return { ok: true, index: hello.me, token: expected };
  }

  /** Invité : jeton de ma place, reçu de l'hôte. */
  setToken(token: string): void {
    const s = this.state;
    while (s.players.length <= s.me) s.players.push(emptySlot());
    if (s.players[s.me].token === token) return;
    s.players[s.me].token = token;
    this.changed();
  }

  /** Invité : place attribuée par l'hôte à l'arrivée dans le salon. */
  setIndex(i: PlayerIndex): void {
    const s = this.state;
    if (s.me === i) return;
    if (s.launched || s.log.length > 0 || s.ready) return; // en partie, ma place ne change pas
    const token = s.players[s.me]?.token;
    if (s.players[s.me]) s.players[s.me] = { ...s.players[s.me], token: undefined };
    s.me = i;
    while (s.players.length <= i) s.players.push(emptySlot());
    s.players[i] = { ...s.players[i], name: s.myName, token: token ?? s.players[i].token };
    this.changed();
  }

  /** Invité : jamais accueilli par l'hôte (pas de jeton) ; hôte : personne n'est encore venu. */
  get neverConnected(): boolean {
    const s = this.state;
    if (s.log.length > 0 || s.ready) return false;
    return s.me === 0 ? s.players.length < 2 : !s.players[s.me]?.token;
  }

  /** Mon annonce à l'hôte (voir Hello). */
  get hello(): Hello {
    const s = this.state;
    const token = s.players[s.me]?.token ?? null;
    return { me: s.gameId && token ? s.me : null, gameId: s.gameId, name: s.myName, token };
  }

  private sendSyncAll(ask: boolean): void {
    for (let i = 0; i < Math.max(this.state.players.length, 2); i++) if (i !== this.state.me) this.sendSync(i as PlayerIndex, ask);
  }

  /**
   * Synchronisation avec `to`. Pour ne pas envoyer tout le journal à chaque fois (les
   * messages WebRTC sont limités en taille), on n'envoie que les tours que `to` n'a pas
   * d'après son dernier 'sync' ; si on ne sait rien de lui, on n'envoie que la longueur et
   * on lui demande le sien (`ask`), ce qui déclenche l'envoi de ce qui lui manque.
   */
  /** Taille visée d'un paquet de journal dans un 'sync' (les canaux WebRTC n'aiment pas les gros messages). */
  static syncChunkBytes = 16_000;

  private sendSync(to: PlayerIndex, ask = false): void {
    const s = this.state;
    const known = this.peerLen[to];
    const missing = known === undefined ? [] : this.publicLogFor(to).slice(Math.min(known, s.log.length));
    // Découpage de la suite du journal en paquets de taille bornée, envoyés dans l'ordre.
    const chunks: PublicTurn[][] = [[]];
    let size = 0;
    for (const t of missing) {
      const len = JSON.stringify(t).length + 1;
      if (size + len > PlayerSession.syncChunkBytes && chunks[chunks.length - 1].length > 0) {
        chunks.push([]);
        size = 0;
      }
      chunks[chunks.length - 1].push(t);
      size += len;
    }
    chunks.forEach((log, i) => {
      const last = i === chunks.length - 1;
      const msg: SyncMessage = {
        t: 'sync',
        v: PROTOCOL_VERSION,
        fp: appFingerprint(),
        gameId: s.gameId,
        me: s.me,
        name: s.myName,
        ready: s.ready,
        firstPlayer: s.firstPlayer,
        log,
        logLen: s.log.length,
        pending: last && s.pending && s.pending.target === to ? s.pending : null, // le détail d'un sort privé ne regarde que sa cible
        set: s.me === 0 && last ? s.pieceSet : null,
        setHash: s.pieceSet ? setHash(s.pieceSet) : null,
        ask: last && (ask || known === undefined),
        cfg: s.me === 0 && last ? s.spellCfg : null,
        players: s.me === 0 ? s.players.map((p) => p.name) : null,
        launched: s.me === 0 ? s.launched : undefined,
      };
      this.send(msg, to);
    });
  }

  /** Indique aux autres ce que je fais (onglet, visée, sort en préparation). */
  setActivity(a: Activity | null): void {
    if (a === this.myActivity) return;
    this.myActivity = a;
    if (a) this.send({ t: 'activity', a }, 'all');
  }

  // ---------- journal public et confidentialité ----------

  /** Version d'un tour envoyée au joueur `to` : les sorts privés sont masqués pour les tiers. */
  static redactFor(turn: PublicTurn, to: PlayerIndex): PublicTurn {
    const { n, by, target, action, result } = turn;
    if (action.kind === 'spell' && to !== by && to !== target) {
      const def = spellDef(action.spell);
      if (action.spell === 'hidden' || def?.visibility === 'private') {
        return { n, by, target, action: { kind: 'spell', spell: 'hidden' }, result: { kind: 'spell', spell: 'hidden' } };
      }
    }
    return { n, by, target, action, result };
  }

  publicLogFor(to: PlayerIndex): PublicTurn[] {
    return this.state.log.map((e) => PlayerSession.redactFor(e, to));
  }

  private broadcastTurn(entry: TurnEntry): void {
    for (let i = 0; i < Math.max(this.state.players.length, 2); i++) {
      if (i === this.state.me) continue;
      this.send({ t: 'turn', turn: PlayerSession.redactFor(entry, i as PlayerIndex) }, i as PlayerIndex);
    }
  }

  // ---------- état dérivé ----------

  get playerCount(): number {
    return Math.max(2, this.state.players.length);
  }

  nameOf(i: PlayerIndex): string {
    return this.state.players[i]?.name || `Joueur ${i + 1}`;
  }

  /** Les autres joueurs (éliminés compris). */
  get opponents(): PlayerIndex[] {
    const out: PlayerIndex[] = [];
    for (let i = 0; i < this.state.players.length; i++) if (i !== this.state.me) out.push(i as PlayerIndex);
    return out;
  }

  /** Dans une partie à deux : l'adversaire. Sinon le premier adversaire vivant (pour les textes). */
  get opp(): PlayerIndex {
    return this.aliveOpponents[0] ?? this.opponents[0] ?? ((1 - this.state.me) as PlayerIndex);
  }

  get alivePlayers(): PlayerIndex[] {
    return alivePlayersAt(this.state.log, this.state.log.length, this.playerCount);
  }

  isAlive(i: PlayerIndex): boolean {
    return i < this.playerCount && eliminatedAt(this.state.log, i) === null;
  }

  get aliveOpponents(): PlayerIndex[] {
    return this.opponents.filter((i) => this.isAlive(i));
  }

  get amEliminated(): boolean {
    return !this.isAlive(this.state.me);
  }

  /** Tour où le joueur a été éliminé (null = en jeu). */
  eliminatedTurn(i: PlayerIndex): number | null {
    return eliminatedAt(this.state.log, i);
  }

  /** Classement final ou provisoire : survivants d'abord, puis éliminés du dernier au premier. */
  get ranking(): PlayerIndex[] {
    const all = Array.from({ length: this.state.players.length }, (_, i) => i as PlayerIndex);
    const key = (i: PlayerIndex) => this.eliminatedTurn(i) ?? Infinity;
    return all.sort((a, b) => key(b) - key(a) || a - b);
  }

  /** Pièces ajoutées en cours de partie par le sort Renfort (à la grille du joueur `owner`). */
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
      out.push({ owner: e.by, def: { id: p.id, shape: p.shape, color: p.color } });
    }
    return out;
  }

  /** Catalogue du jeu de la partie, pièces ajoutées comprises (null tant que le jeu n'est pas accepté). */
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

  /** Mes pièces (jeu de base + pièces que j'ai ajoutées). */
  get myPieces(): PieceDef[] {
    return this.piecesOf(this.state.me);
  }

  /** Pièces d'un joueur (jeu de base + pièces qu'il a ajoutées par Renfort). */
  piecesOf(owner: PlayerIndex): PieceDef[] {
    const set = this.state.pieceSet;
    if (!set) return [];
    return [...catalogOf(set).pieces, ...this.extras.filter((x) => x.owner === owner).map((x) => x.def)];
  }

  get mySetHash(): string | null {
    return this.state.pieceSet ? setHash(this.state.pieceSet) : null;
  }

  attackerOf(n: number): PlayerIndex | null {
    const f = this.state.firstPlayer;
    return f === null ? null : attackerAt(f, this.state.log, n, RULES, this.playerCount);
  }

  /** Diversion : joueur que l'attaquant du tour n doit viser (null = libre). */
  forcedTargetOf(n: number): PlayerIndex | null {
    const f = this.state.firstPlayer;
    return f === null ? null : forcedTargetAt(f, this.state.log, n, this.playerCount);
  }

  get forcedTarget(): PlayerIndex | null {
    return this.forcedTargetOf(this.state.log.length);
  }

  get winner(): PlayerIndex | null {
    const s = this.state;
    if (!s.launched || s.firstPlayer === null || s.players.length < 2) return null;
    const alive = this.alivePlayers;
    return alive.length === 1 ? alive[0] : null;
  }

  get phase(): Phase {
    const s = this.state;
    if (this.winner !== null) return 'over';
    if (!s.launched) return 'lobby';
    if (!s.pieceSet) return 'review';
    if (!s.ready) return 'setup';
    if (s.firstPlayer === null) return 'waiting';
    return 'playing';
  }

  get isMyTurn(): boolean {
    return this.phase === 'playing' && this.attackerOf(this.state.log.length) === this.state.me;
  }

  /** Tous les autres joueurs sont-ils prêts (et, pour l'hôte, d'accord sur le jeu) ? */
  get othersReady(): boolean {
    const s = this.state;
    return this.opponents.every((i) => s.players[i].ready && (s.me !== 0 || s.players[i].setHash === this.mySetHash));
  }

  /** Mes pièces coulées par les adversaires. */
  get mySunk(): Set<string> {
    const out = new Set<string>();
    const revives = this.state.revives;
    for (const e of this.state.log) {
      if (e.target === this.state.me && e.by !== this.state.me && e.secret?.sunkId) out.add(e.secret.sunkId);
      for (const r of revives) if (r.n === e.n) out.delete(r.id);
    }
    for (const r of revives) if (r.n >= this.state.log.length) out.delete(r.id); // sort lancé, pas encore dans le journal
    return out;
  }

  /** Numéro du dernier tour où `owner` a mélangé sa grille (-1 = jamais) : les anciennes infos sont périmées. */
  notesResetAt(owner: PlayerIndex): number {
    let n = -1;
    for (const e of this.state.log) if (e.by === owner && e.action.kind === 'spell' && e.action.spell === 'shuffle') n = e.n;
    return n;
  }

  /** Pièces de `owner` coulées (déclarations justes de n'importe qui), moins celles qu'il a ressuscitées. */
  sunkClaimsOf(owner: PlayerIndex): Claim[] {
    const out: Claim[] = [];
    const key = (cells: { r: number; c: number }[]) => cells.map(cellKey).sort().join('|');
    for (const e of this.state.log) {
      if (e.target === owner && e.by !== owner && e.action.kind === 'claim' && e.result.kind === 'claim' && e.result.ok) out.push(e.action.claim);
      else if (e.by === owner && e.action.kind === 'spell' && e.action.spell === 'shuffle') out.length = 0; // grille mélangée : tout est à refaire
      else if (e.by === owner && e.action.kind === 'spell' && e.action.spell === 'revive' && e.action.cells && e.action.color && e.action.shape) {
        const { color, shape } = e.action;
        const k = key(e.action.cells);
        for (let i = out.length - 1; i >= 0; i--) {
          if (out[i].color === color && out[i].shape === shape && key(out[i].cells) === k) {
            out.splice(i, 1);
            break;
          }
        }
      }
    }
    return out;
  }

  /** Pièces adverses que j'ai coulées (partie à deux : compatibilité). */
  get oppSunk(): Claim[] {
    return this.sunkClaimsOf(this.opp);
  }

  notesFor(owner: PlayerIndex): Notes {
    return this.state.notes[String(owner)] ?? EMPTY_NOTES;
  }

  // ---------- salon (hôte) ----------

  /** Hôte : lance la partie avec les joueurs présents (au moins 2, tous connectés). */
  launch(): boolean {
    const s = this.state;
    if (s.me !== 0 || s.launched || s.players.length < 2) return false;
    if (!this.opponents.every((i) => this.isOnline(i))) return false;
    s.launched = true;
    this.sendRoster();
    this.sendSyncAll(false);
    this.changed();
    return true;
  }

  /** Hôte, dans le salon : retire un invité (déconnecté) ; les suivants avancent d'une place. */
  removeSlot(i: PlayerIndex): void {
    const s = this.state;
    if (s.me !== 0 || s.launched || i === 0 || i >= s.players.length || this.isOnline(i)) return;
    this.transport?.drop?.(i);
    s.players.splice(i, 1);
    for (let j = i; j < s.players.length; j++) {
      const from = (j + 1) as PlayerIndex;
      this.transport?.reassign?.(from, j as PlayerIndex);
      this.send({ t: 'assign', you: j as PlayerIndex }, j as PlayerIndex);
    }
    this.peerLen = {};
    this.sendRoster();
    this.send({ t: 'presence', online: s.players.map((_, k) => this.isOnline(k as PlayerIndex)) }, 'all');
    this.emit({ type: 'roster' });
    this.changed();
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
    this.send({ t: 'set-accept', hash: setHash(s.pieceSet) }, 0);
    this.emit({ type: 'set-accepted' });
    this.changed();
  }

  /** Invité : refuse le jeu proposé. */
  refuseProposedSet(): void {
    const s = this.state;
    if (!s.proposedSet) return;
    s.refusedHash = setHash(s.proposedSet);
    this.send({ t: 'set-refuse', hash: s.refusedHash }, 0);
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
    this.state.players[this.state.me].ready = true;
    this.send({ t: 'ready' }, 'all');
    this.maybeStart();
    this.changed();
    return true;
  }

  /** Pourquoi je ne peux pas viser ce joueur maintenant (null = possible). */
  targetBlocked(target: PlayerIndex): string | null {
    if (target === this.state.me || target >= this.playerCount) return 'Tu ne peux pas te viser toi-même.';
    if (!this.isAlive(target)) return `${this.nameOf(target)} est déjà éliminé.`;
    const forced = this.forcedTarget;
    if (forced !== null && forced !== target) return `Diversion : tu dois viser ${this.nameOf(forced)}.`;
    return null;
  }

  shoot(edge: Edge, target: PlayerIndex = this.opp): boolean {
    return this.act({ kind: 'shot', edge }, target);
  }

  claim(claim: Claim, target: PlayerIndex = this.opp): boolean {
    return this.act({ kind: 'claim', claim }, target);
  }

  private act(action: Action, target: PlayerIndex): boolean {
    const s = this.state;
    if (!this.isMyTurn || s.pending) return false;
    const own = isOwnAction(action);
    if (own) target = s.me;
    else if (this.targetBlocked(target)) return false;
    const n = s.log.length;
    s.silenced = false;
    if (own) {
      const entry = this.resolveOwn(n, action);
      s.log.push(entry);
      this.afterMine(entry);
      this.broadcastTurn(entry);
      this.emit({ type: 'outcome', entry });
      this.changed();
      return true;
    }
    s.pending = { n, target, action };
    this.send({ t: 'action', n, target, action }, target);
    this.changed();
    return true;
  }

  /** Renvoie l'action en attente (bouton "Renvoyer" si la réponse tarde). */
  resendPending(): void {
    const p = this.state.pending;
    if (p) this.send({ t: 'action', n: p.n, target: p.target, action: p.action }, p.target);
    else this.sendSyncAll(true);
  }

  /**
   * Nouvelle partie (revanche) avec les mêmes joueurs, lancée par l'hôte, qui peut changer
   * de jeu de pièces (`set`) : les invités devront alors l'accepter. `lobby` : rouvre le
   * salon (pour ajouter ou retirer des joueurs) au lieu de relancer tout de suite.
   */
  startNewGame(set?: PieceSet, cfg?: SpellConfig, lobby = false): boolean {
    const s = this.state;
    if (s.me !== 0) return false;
    const gameId = newGameId();
    this.resetFor(gameId, set ?? null, cfg, lobby);
    this.state.myNewGameId = gameId;
    this.send({ t: 'newgame', gameId, set: this.state.pieceSet, cfg: this.state.spellCfg, lobby }, 'all');
    this.emit({ type: 'newgame' });
    this.changed();
    return true;
  }

  setNotes(owner: PlayerIndex, notes: Notes): void {
    this.state.notes = { ...this.state.notes, [String(owner)]: notes };
    this.changed();
  }

  /** Repart de zéro pour une nouvelle partie, en gardant les joueurs et le jeu (sauf changement). */
  private resetFor(gameId: string, newSet: PieceSet | null, cfg?: SpellConfig | null, lobby = false): void {
    const s = this.state;
    const next = freshState(s.mode, s.me, s.myName, gameId, s.pieceSet, cfg ?? s.spellCfg, s.players.map((p) => p.name));
    next.launched = s.mode !== 'online' || !lobby;
    for (let i = 0; i < next.players.length; i++) {
      next.players[i].setHash = s.players[i].setHash;
      next.players[i].token = s.players[i].token; // les jetons de reconnexion survivent aux revanches
    }
    if (newSet && (!s.pieceSet || setHash(newSet) !== setHash(s.pieceSet))) {
      if (s.me === 0) {
        next.pieceSet = newSet;
        for (const p of next.players) p.setHash = null;
        next.players[0].setHash = setHash(newSet);
      } else {
        next.pieceSet = null;
        next.proposedSet = newSet;
      }
    }
    this.state = next;
  }

  // ---------- réception ----------

  receive(raw: unknown, from: PlayerIndex): void {
    const msg = parseMessage(raw);
    if (!msg || !isPlayer(from) || from === this.state.me) return;
    const s = this.state;
    switch (msg.t) {
      case 'sync':
        this.onSync(msg, from);
        return;
      case 'activity':
        this.activities[from] = msg.a;
        this.refresh();
        return;
      case 'ready':
        if (s.players[from]) {
          s.players[from].ready = true;
          this.maybeStart();
          this.changed();
        }
        return;
      case 'start':
        if (from === 0 && s.me !== 0 && s.firstPlayer === null && s.pieceSet && s.launched && msg.firstPlayer < this.playerCount) {
          s.firstPlayer = msg.firstPlayer;
          this.emit({ type: 'started', firstPlayer: msg.firstPlayer });
          this.changed();
        }
        return;
      case 'action':
        if (msg.target === s.me) this.onAction(msg.n, from, msg.action);
        return;
      case 'turn':
        this.onTurn(msg.turn, from);
        return;
      case 'newgame':
        if (from === 0) this.onNewGame(msg.gameId, msg.set, msg.cfg ?? null, msg.lobby === true);
        return;
      case 'set-accept':
        if (s.me === 0 && msg.hash === this.mySetHash && s.players[from]) {
          s.players[from].setHash = msg.hash;
          s.players[from].refused = false;
          this.maybeStart();
          this.changed();
        }
        return;
      case 'set-refuse':
        if (s.me === 0 && msg.hash === this.mySetHash && s.players[from]) {
          s.players[from].refused = true;
          this.emit({ type: 'set-refused', by: from });
          this.changed();
        }
        return;
      case 'roster':
        if (from === 0 && s.me !== 0) this.adoptRoster(msg.players, msg.launched);
        return;
      case 'presence':
        if (from === 0 && s.me !== 0) {
          this.presence = msg.online;
          this.refresh();
        }
        return;
      case 'assign':
        if (from === 0) this.setIndex(msg.you);
        return;
    }
  }

  /** Invité : liste des joueurs annoncée par l'hôte. */
  private adoptRoster(names: string[], launched: boolean): void {
    const s = this.state;
    if (s.launched && s.log.length > 0) return; // en partie, la liste ne bouge plus
    const next: PlayerSlot[] = names.map((n, i) => (i === s.me ? { ...(s.players[i] ?? emptySlot()), name: s.myName } : { ...(s.players[i] ?? emptySlot()), name: n || s.players[i]?.name || '' }));
    while (next.length <= s.me) next.push(emptySlot(next.length === s.me ? s.myName : ''));
    s.players = next;
    if (launched && !s.launched) s.launched = true;
    this.emit({ type: 'roster' });
    this.changed();
  }

  private onNewGame(gameId: string, set: PieceSet | null, cfg: SpellConfig | null, lobby: boolean): void {
    const s = this.state;
    if (gameId === s.gameId) return;
    this.resetFor(gameId, s.me !== 0 ? set : null, s.me !== 0 ? cfg : null, lobby);
    if (this.state.proposedSet) this.emit({ type: 'set-proposed' });
    this.emit({ type: 'newgame' });
    this.sendSyncAll(false);
    this.changed();
  }

  private onSync(msg: SyncMessage, from: PlayerIndex): void {
    const s = this.state;
    if (msg.v !== PROTOCOL_VERSION || msg.fp !== appFingerprint()) {
      this.emit({ type: 'error', message: 'Les téléphones n’ont pas la même version de l’app (règles ou couleurs différentes). Rechargez l’app sur chacun.' });
      return;
    }
    if (msg.me !== from) return; // l'expéditeur est identifié par le hub, pas par ce qu'il déclare
    const theirLen = msg.logLen ?? msg.log.length;
    if (msg.gameId !== s.gameId) {
      if (!s.gameId && from === 0) {
        s.gameId = msg.gameId; // l'invité rejoint la partie de l'hôte
      } else if (!msg.gameId && s.me === 0) {
        if (s.launched && (s.log.length > 0 || s.firstPlayer !== null)) {
          this.emit({ type: 'error', message: 'Cette partie est déjà en cours : un nouveau téléphone ne peut pas la rejoindre.' });
          return;
        }
      } else if (from === 0 && theirLen === 0 && (this.phase === 'over' || !s.launched || s.log.length === 0)) {
        // l'hôte a lancé une nouvelle partie pendant que nous étions déconnectés
        this.resetFor(msg.gameId, msg.set, msg.cfg, msg.launched === false);
        this.emit({ type: 'newgame' });
        this.onSync(msg, from);
        return;
      } else if (s.me === 0 && s.myNewGameId === s.gameId && s.log.length === 0) {
        // j'ai lancé une nouvelle partie que cet invité n'a pas reçue : je la renvoie
        this.send({ t: 'newgame', gameId: s.gameId, set: s.pieceSet, cfg: s.spellCfg, lobby: !s.launched }, from);
        return;
      } else {
        this.emit({ type: 'error', message: 'Ce téléphone joue une autre partie. Lancez une nouvelle partie de chaque côté.' });
        return;
      }
    }
    this.peerLen[from] = theirLen;
    // Liste des joueurs (l'hôte fait autorité) et mon propre nom chez l'autre
    if (from === 0 && s.me !== 0 && msg.players) {
      if (s.launched && s.log.length > 0 && msg.players.length !== s.players.length) {
        this.emit({ type: 'error', message: 'Le nombre de joueurs annoncé par l’hôte ne correspond pas à cette partie.' });
        return;
      }
      this.adoptRoster(msg.players, msg.launched === true);
    }
    if (s.me === 0 && !s.launched) while (s.players.length <= from && s.players.length < MAX_PLAYERS) s.players.push(emptySlot());
    if (!s.players[from]) return; // place inconnue
    if (msg.name) s.players[from].name = msg.name;
    s.players[from].ready = msg.ready;
    if (from === 0 && s.me !== 0 && msg.cfg && s.log.length === 0 && !s.ready) s.spellCfg = cloneSpellConfig(msg.cfg);

    // Jeu de pièces
    if (from === 0 && s.me !== 0 && msg.set) {
      const h = setHash(msg.set);
      if (!s.pieceSet || setHash(s.pieceSet) !== h) {
        if (s.log.length > 0 || s.ready) {
          this.emit({ type: 'error', message: 'Le jeu de pièces de l’hôte a changé en cours de partie.' });
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
      s.players[from].setHash = msg.setHash;
      if (msg.setHash === this.mySetHash) s.players[from].refused = false;
    }
    if (from === 0 && s.firstPlayer === null && msg.firstPlayer !== null && s.me !== 0 && s.pieceSet && s.launched && msg.firstPlayer < this.playerCount) s.firstPlayer = msg.firstPlayer;

    const stalled = this.mergeLog(msg.log, from);
    if (s.pending && s.pending.n < s.log.length) s.pending = null;
    // Mon action en attente n'est plus jouable d'après le journal (ordre, cible) : on l'abandonne.
    if (s.pending && (this.attackerOf(s.pending.n) !== s.me || this.targetBlocked(s.pending.target))) {
      s.pending = null;
      this.emit({ type: 'error', message: 'Ton coup en attente n’était plus valable après la resynchronisation : il est annulé.' });
    }

    this.maybeStart();
    this.changed();

    // Il me manque des tours que l'autre n'a pas inclus : je redemande (il connaît maintenant ma longueur).
    const minN = msg.log.length ? Math.min(...msg.log.map((t) => t.n)) : theirLen;
    const needMore = theirLen > s.log.length && minN > s.log.length;
    // Action visant ma grille jamais reçue : on la traite maintenant.
    if (msg.pending && msg.pending.target === s.me && msg.pending.n === s.log.length) this.onAction(msg.pending.n, from, msg.pending.action);
    // Mon action jamais reçue par sa cible : je la renvoie.
    if (s.pending && s.pending.n === s.log.length && s.pending.target === from && theirLen <= s.pending.n) {
      this.send({ t: 'action', n: s.pending.n, target: s.pending.target, action: s.pending.action }, from);
    }
    // Celui qui me parle a du retard : je lui envoie la suite sans qu'il la demande.
    const theyLag = theirLen < s.log.length && !msg.ask;
    if (msg.ask || needMore || theyLag) this.sendSync(from, needMore && !msg.ask);
    // Un tour que seul un autre joueur peut me donner : je le lui demande.
    if (stalled) {
      const who = stalled.target === s.me ? stalled.by : this.authorityOf(stalled);
      if (who !== from && who !== s.me && this.isOnline(who)) this.sendSync(who, true);
    }
  }

  /**
   * Complète le journal avec les tours manqués, sans faire confiance à l'autre. Retourne
   * le premier tour qu'on ne peut pas prendre de cet expéditeur (il faut le demander à
   * celui qui l'a calculé), ou null.
   */
  private mergeLog(theirs: PublicTurn[], from: PlayerIndex): PublicTurn | null {
    const s = this.state;
    if (s.firstPlayer === null || !this.catalog) return null;
    for (const turn of [...theirs].sort((a, b) => a.n - b.n)) {
      if (turn.n < s.log.length) continue;
      if (turn.n > s.log.length) break;
      if (this.winner !== null) break;
      const v = this.acceptTurn(turn, from);
      if (v === 'wait') return turn;
      if (v === 'invalid') break;
    }
    return null;
  }

  /** Qui peut me donner le tour `turn` : la cible (qui l'a calculé), ou le lanceur pour un sort sur lui-même. */
  private authorityOf(turn: PublicTurn): PlayerIndex {
    return turn.target;
  }

  /** Vérifie un tour reçu (hors ma grille) : bon joueur, bonne cible, bon sort. */
  private turnError(turn: PublicTurn): string | null {
    const s = this.state;
    const n = turn.n;
    if (turn.by !== this.attackerOf(n)) return 'mauvais joueur';
    if (turn.by >= this.playerCount || turn.target >= this.playerCount) return 'joueur inconnu';
    const alive = alivePlayersAt(s.log, n, this.playerCount);
    if (!alive.includes(turn.by)) return 'joueur éliminé';
    const own = isOwnAction(turn.action);
    if (own !== (turn.target === turn.by)) return 'cible incohérente';
    if (!own) {
      if (!alive.includes(turn.target)) return 'cible éliminée';
      const forced = this.forcedTargetOf(n);
      if (forced !== null && forced !== turn.target) return 'cible imposée par Diversion non respectée';
    }
    if (turn.action.kind === 'spell' && turn.action.spell !== 'self' && turn.action.spell !== 'hidden') {
      const def = spellDef(turn.action.spell);
      if (!def) return 'sort inconnu';
      if (!s.spellCfg.enabled) return 'sorts désactivés dans cette partie';
      if (!this.spellPool.includes(def.id)) return 'sort non autorisé dans cette partie';
      if ((def.minPlayers ?? 2) > this.playerCount) return 'sort réservé aux parties à plus de joueurs';
      if (minAliveFor(def.id) > alive.length) return 'sort sans effet avec si peu de joueurs en jeu';
      if (def.id === 'freeze' && this.frozenAt(n).includes(turn.target)) return 'joueur déjà gelé';
      if (def.param === 'player') {
        const who = turn.action.who;
        if (who === undefined || who === turn.by || who >= this.playerCount || !alive.includes(who)) return 'joueur désigné invalide';
      }
    }
    return null;
  }

  /** Joueurs gelés (qui sauteront leur prochain tour) au moment du tour n. */
  frozenAt(n: number): PlayerIndex[] {
    const f = this.state.firstPlayer;
    return f === null ? [] : orderAt(f, this.state.log, n, this.playerCount).frozen;
  }

  isFrozen(i: PlayerIndex): boolean {
    return this.frozenAt(this.state.log.length).includes(i);
  }

  /** Qui jouerait juste après moi si je jouais un coup ordinaire maintenant (null hors de mon tour). */
  get nextAfterMe(): PlayerIndex | null {
    const s = this.state;
    const f = s.firstPlayer;
    if (f === null || !this.isMyTurn) return null;
    const probe: PublicTurn = { n: s.log.length, by: s.me, target: s.me, action: { kind: 'spell', spell: 'self' }, result: { kind: 'spell', spell: 'self' } };
    return attackerAt(f, [...s.log, probe], s.log.length + 1, RULES, this.playerCount);
  }

  /** Adversaires que ce sort peut viser maintenant (vivants, Diversion, pas déjà gelé pour Gel). */
  targetChoices(spellId: string): PlayerIndex[] {
    return this.aliveOpponents.filter((i) => !this.targetBlocked(i) && !(spellId === 'freeze' && this.isFrozen(i)));
  }

  /** Joueurs que Relais / Diversion peuvent désigner utilement (vivants, pas moi, pas celui qui jouerait de toute façon ensuite). */
  whoChoices(spellId: string): PlayerIndex[] {
    const next = this.nextAfterMe;
    return this.aliveOpponents.filter((i) => (spellId === 'relay' || spellId === 'divert' ? i !== next : true));
  }

  /**
   * Ajoute le tour n (= longueur du journal) reçu de `from`.
   *  - 'ok' : ajouté ;
   *  - 'invalid' : incohérent (mauvais joueur, cible, sort…), signalé et ignoré ;
   *  - 'wait' : `from` n'est pas habilité à me le donner (seul celui qui a calculé le tour,
   *    la cible, fait foi ; un tour visant ma grille doit venir de son auteur), ou il est
   *    masqué : il faudra le demander à la bonne personne.
   */
  private acceptTurn(turn: PublicTurn, from: PlayerIndex): 'ok' | 'invalid' | 'wait' {
    const s = this.state;
    const err = this.turnError(turn);
    if (err) {
      this.emit({ type: 'error', message: `Journal incohérent reçu de ${this.nameOf(from)} (${err}) : ignoré.` });
      return 'invalid';
    }
    const hidden = turn.action.kind === 'spell' && turn.action.spell === 'hidden';
    if (turn.by === s.me) {
      // J'étais l'attaquant : je reprends le résultat calculé par la cible, à condition
      // qu'il vienne bien d'ELLE et qu'il réponde à MON action (et qu'il ne soit pas masqué).
      if (hidden || from !== turn.target) return 'wait';
      if (s.pending && s.pending.n !== turn.n) return 'wait';
      if (s.pending && (!sameJson(s.pending.action, turn.action) || s.pending.target !== turn.target)) {
        this.emit({ type: 'error', message: `Journal incohérent reçu de ${this.nameOf(from)} (action différente) : ignoré.` });
        return 'invalid';
      }
      const entry: TurnEntry = { n: turn.n, by: turn.by, target: turn.target, action: turn.action, result: turn.result };
      s.log.push(entry);
      this.afterMine(entry);
      if (s.pending?.n === turn.n) {
        s.pending = null;
        this.emit({ type: 'outcome', entry });
      }
      return 'ok';
    }
    if (turn.target === s.me) {
      // Ma grille est visée : je recalcule moi-même (il me faut l'action complète, venant de l'attaquant).
      if (hidden || from !== turn.by) return 'wait';
      const entry = this.resolve(turn.n, turn.by, turn.action);
      s.log.push(entry);
      this.broadcastTurn(entry);
      this.emit({ type: 'incoming', entry });
      this.afterEliminations(entry);
      return 'ok';
    }
    // Tour entre deux autres joueurs : je ne l'accepte que de celui qui l'a calculé (la cible) ;
    // sort d'un autre joueur sur lui-même : de lui seul (cible = lanceur).
    if (from !== this.authorityOf(turn)) return 'wait';
    const entry: TurnEntry = { n: turn.n, by: turn.by, target: turn.target, action: turn.action, result: turn.result };
    if (turn.target === turn.by) entry.result = this.ownResult(turn.n, turn.action); // jamais de confiance : je recalcule
    s.log.push(entry);
    this.afterOthers(entry);
    this.emit({ type: 'turn', entry });
    this.afterEliminations(entry);
    return 'ok';
  }

  private afterEliminations(entry: TurnEntry): void {
    if (entry.result.kind === 'claim' && entry.result.ok && entry.result.eliminated) this.emit({ type: 'eliminated', player: entry.target });
  }

  private maybeStart(): void {
    const s = this.state;
    if (s.me === 0 && s.launched && s.ready && s.firstPlayer === null && s.pieceSet && s.players.length >= 2 && this.othersReady) {
      s.firstPlayer = Math.min(this.playerCount - 1, Math.floor(this.random() * this.playerCount)) as PlayerIndex;
      this.send({ t: 'start', firstPlayer: s.firstPlayer }, 'all');
      this.emit({ type: 'started', firstPlayer: s.firstPlayer });
    }
  }

  private onTurn(turn: PublicTurn, from: PlayerIndex): void {
    const s = this.state;
    if (turn.n < s.log.length) return; // déjà connu
    if (turn.n > s.log.length) {
      this.sendSync(from, true); // il me manque des tours
      return;
    }
    if (this.phase !== 'playing' || !this.catalog) return;
    const v = this.acceptTurn(turn, from);
    if (v === 'ok') {
      if (s.pending && s.pending.n < s.log.length) s.pending = null;
      this.changed();
    } else if (v === 'wait') {
      // seul celui qui a calculé ce tour peut me le donner : je le lui demande
      const who = turn.target === s.me ? turn.by : this.authorityOf(turn);
      if (who !== from && who !== s.me) this.sendSync(who, true);
    }
  }

  private onAction(n: number, from: PlayerIndex, action: Action): void {
    const s = this.state;
    if (n < s.log.length) {
      const prev = s.log[n];
      if (prev.by === from && prev.target === s.me) this.send({ t: 'turn', turn: PlayerSession.redactFor(prev, from) }, from);
      return;
    }
    if (n > s.log.length) {
      // l'autre est en avance : il me manque des tours, je demande une resynchronisation
      this.sendSync(from, true);
      return;
    }
    if (this.phase !== 'playing') return;
    if (action.kind === 'spell' && (action.spell === 'hidden' || action.spell === 'self')) return; // jamais une action à résoudre
    const probe: PublicTurn = { n, by: from, target: s.me, action, result: action.kind === 'shot' ? { kind: 'shot', exit: { side: 'top', index: 0 }, colors: [] } : action.kind === 'claim' ? { kind: 'claim', ok: false } : { kind: 'spell', spell: action.spell } };
    const err = this.turnError(probe);
    if (err) {
      this.emit({ type: 'error', message: `Action refusée de ${this.nameOf(from)} (${err}).` });
      this.sendSync(from, true); // qu'il se resynchronise et abandonne ce coup s'il n'est plus valable
      return;
    }
    const entry = this.resolve(n, from, action);
    s.log.push(entry);
    this.broadcastTurn(entry);
    this.emit({ type: 'incoming', entry });
    this.afterEliminations(entry);
    this.changed();
  }

  /** Calcule le résultat d'une action visant MON plateau. */
  private resolve(n: number, by: PlayerIndex, action: Action): TurnEntry {
    const s = this.state;
    const cat = this.catalog!;
    const sunk = this.mySunk;
    const target = s.me;
    if (action.kind === 'shot') {
      const shot = this.fire([action.edge], sunk);
      return { n, by, target, action, result: { kind: 'shot', exit: shot.shots[0].exit, colors: shot.shots[0].colors }, secret: { hits: shot.hits, path: shot.paths[0], paths: shot.paths } };
    }
    if (action.kind === 'spell') return this.resolveSpell(n, by, action, sunk);
    let check = checkClaim(s.placement, sunk, action.claim, cat);
    if (s.fx.camouflage) {
      s.fx.camouflage = false;
      check = { ok: false };
    }
    let eliminated = false;
    if (check.ok && check.pieceId) eliminated = this.myPieces.every((p) => p.id === check.pieceId || sunk.has(p.id));
    return {
      n,
      by,
      target,
      action,
      result: eliminated ? { kind: 'claim', ok: true, eliminated: true } : { kind: 'claim', ok: check.ok },
      secret: { hits: [], path: [], sunkId: check.ok ? check.pieceId : undefined },
    };
  }

  /** Un ou plusieurs tirs sur mon plateau, avec les effets Brume, Leurre et Mirage. */
  private fire(edges: Edge[], sunk: Set<string>) {
    const s = this.state;
    const cat = this.catalog!;
    const removed = RULES.sunkPiecesAreRemoved ? sunk : new Set<string>();
    const fx = s.fx;
    const grid = fx.mirage ? buildGrid([], cat) : buildGrid(s.placement, cat, removed);
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
    fx.mirage = false;
    return { shots, paths, hits };
  }

  private resolveSpell(n: number, by: PlayerIndex, a: SpellAction, sunk: Set<string>): TurnEntry {
    const s = this.state;
    const cat = this.catalog!;
    const target = s.me;
    const grid = buildGrid(s.placement, cat, RULES.sunkPiecesAreRemoved ? sunk : new Set<string>());
    const done = (r: Omit<SpellResult, 'kind' | 'spell'>, secret?: TurnEntry['secret']): TurnEntry => ({ n, by, target, action: a, result: { kind: 'spell', spell: a.spell, ...r }, secret });
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
      case 'salve':
      case 'rafale': {
        const shot = this.fire(a.edges ?? [], sunk);
        return done({ shots: shot.shots }, { hits: shot.hits, path: shot.paths[0] ?? [], paths: shot.paths });
      }
      case 'loupe':
        return done({ cells: blockCells(a.r ?? 0, a.c ?? 0).map((cell) => ({ ...cell, color: cellColor(grid, cat, cell) })) });
      case 'histo': {
        const counts = Array.from({ length: grid.length }, (_, i) => occupiedCells(grid, lineCells(a.opt === 'col' ? 'col' : 'row', i)).length);
        return done({ counts });
      }
      case 'ring':
        return done({ count: occupiedCells(grid, ringCells()).length });
      case 'center':
        return done({ count: occupiedCells(grid, centerCells()).length });
      case 'spy':
        return done({ count: Math.min(s.spells.length, 1000) });
      case 'sabotage':
      case 'steal': {
        if (!s.spells.length) return done({ got: null });
        const got = s.spells.splice(Math.floor(this.random() * s.spells.length), 1)[0];
        return done({ got });
      }
      case 'silence':
        s.silenced = true;
        return done({});
      default: // freeze
        return done({});
    }
  }

  /** Résultat (vérifiable par tous) d'un sort que le lanceur résout lui-même. */
  private ownResult(n: number, a: Action): Result {
    if (a.kind !== 'spell') return { kind: 'claim', ok: false };
    if (a.spell === 'addpiece') {
      const set = this.state.pieceSet;
      const ok = !!set && !!a.shape && !!a.color && catalogOf(set).pieces.some((b) => b.shape === a.shape && b.color === a.color);
      return { kind: 'spell', spell: 'addpiece', piece: ok ? { id: `x${n}.${a.shape}.${a.color}`, shape: a.shape!, color: a.color! } : null };
    }
    return { kind: 'spell', spell: a.spell };
  }

  private resolveOwn(n: number, a: Action): TurnEntry {
    return { n, by: this.state.me, target: this.state.me, action: a, result: this.ownResult(n, a) };
  }

  /** Suites d'un tour d'un AUTRE joueur qui ne vise pas ma grille. */
  private afterOthers(entry: TurnEntry): void {
    const s = this.state;
    const a = entry.action;
    if (a.kind !== 'spell') return;
    if (a.spell === 'shuffle') s.notes = { ...s.notes, [String(entry.by)]: EMPTY_NOTES }; // sa grille est mélangée : mon carnet sur lui repart à zéro
    if (a.spell === 'silenceall' && this.isAlive(s.me)) s.silenced = true;
  }

  // ---------- sorts ----------

  /** Sorts qui peuvent apparaître dans cette partie (réglages de l'hôte et nombre de joueurs). */
  get spellPool(): string[] {
    const allowed = spellsFor(this.playerCount).map((d) => d.id);
    return this.state.spellCfg.pool.filter((id) => allowed.includes(id));
  }

  /** Tire un sort au hasard dans la liste des sorts autorisés. */
  private gain(): void {
    const pool = this.spellPool;
    if (!pool.length) return;
    const id = pool[Math.floor(this.random() * pool.length)];
    this.state.spells.push(id);
    this.emit({ type: 'spell-gained', spell: id });
  }

  /** Suites d'un de MES tours une fois son résultat connu : sorts gagnés, carnet mis à jour. */
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
    const who = String(entry.target);
    const notes = this.notesFor(entry.target);
    if (r.spell === 'loupe' && r.cells) {
      const marks = { ...notes.marks };
      for (const cell of r.cells) marks[cellKey(cell)] = cell.color ? 'x' : 'o';
      s.notes = { ...s.notes, [who]: { ...notes, marks } };
    }
    if (r.spell === 'reveal' && entry.action.kind === 'spell') {
      const k = cellKey({ r: entry.action.r ?? 0, c: entry.action.c ?? 0 });
      s.notes = { ...s.notes, [who]: { ...notes, marks: { ...notes.marks, [k]: r.occ ? 'x' : 'o' } } };
    }
    if (r.spell === 'hint' && r.r !== undefined && r.c !== undefined) {
      s.notes = { ...s.notes, [who]: { ...notes, marks: { ...notes.marks, [cellKey({ r: r.r, c: r.c })]: 'x' } } };
    }
  }

  /** Pourquoi je ne peux pas lancer ce sort maintenant (null = possible). */
  spellBlocked(id: string): string | null {
    const s = this.state;
    const def = spellDef(id);
    if (!def) return 'Sort inconnu.';
    if (!s.spellCfg.enabled) return 'Les sorts sont désactivés dans cette partie.';
    if (!this.isMyTurn || s.pending) return 'Seulement à ton tour.';
    if (s.silenced) return 'Tu es réduit au silence pour ce tour.';
    if (!s.spells.includes(id)) return 'Tu n’as pas ce sort.';
    if ((def.minPlayers ?? 2) > this.playerCount) return `Ce sort demande au moins ${def.minPlayers} joueurs.`;
    if (minAliveFor(id) > this.alivePlayers.length) return `Ce sort n’a plus d’effet : il faut au moins ${minAliveFor(id)} joueurs encore en jeu.`;
    if (id === 'revive' && this.mySunk.size === 0) return 'Aucune de tes pièces n’est coulée.';
    if (def.target === 'opp' && this.aliveOpponents.length === 0) return 'Plus personne à viser.';
    if (id === 'freeze' && this.targetChoices('freeze').length === 0) return 'Le joueur que tu pourrais viser est déjà gelé.';
    if (def.param === 'player' && this.whoChoices(id).length === 0) return 'Aucun joueur à désigner utilement.';
    return null;
  }

  /**
   * Lance un sort (remplace le tir du tour, sauf Gel). `target` : joueur visé pour un sort
   * qui vise un adversaire ; `params.who` : joueur désigné (Relais, Diversion).
   * Retourne false si impossible.
   */
  cast(id: string, params: Partial<SpellAction> = {}, spot?: { r: number; c: number; rot: 0 | 1 | 2 | 3 }, target?: PlayerIndex): boolean {
    const def = spellDef(id);
    if (!def || this.spellBlocked(id)) return false;
    const s = this.state;
    const n = s.log.length;
    let action: SpellAction;
    let reviveId: string | null = null;
    let newSpot: Placement | null = null;
    let shuffled: Placement[] | null = null;
    const to: PlayerIndex = def.target === 'opp' ? (target ?? this.targetChoices(id)[0] ?? this.opp) : s.me;
    if (def.target === 'opp' && (this.targetBlocked(to) || (id === 'freeze' && this.isFrozen(to)))) return false;
    if (def.target === 'self') {
      action = { kind: 'spell', spell: 'self' };
    } else if (id === 'shuffle') {
      // Tempête publique : TOUTES mes pièces sont replacées au hasard, les coulées reviennent en jeu.
      const next = tryRandomPlacement({ ...this.catalog!, pieces: this.myPieces }, { random: () => this.random() });
      if (!next) return false;
      shuffled = next;
      action = { kind: 'spell', spell: 'shuffle' };
    } else if (id === 'revive') {
      // Résurrection publique : tout le monde voit quelle pièce revient en jeu.
      const ids = [...this.mySunk];
      if (!ids.length) return false;
      reviveId = ids[Math.floor(this.random() * ids.length)];
      const placed = s.placement.find((p) => p.pieceId === reviveId);
      const rdef = pieceDef(reviveId, this.catalog!);
      if (!placed || !rdef) return false;
      // Les autres voient les cases où la pièce avait été coulée (ils la retirent de leur carnet).
      action = { kind: 'spell', spell: 'revive', shape: rdef.shape, color: rdef.color, cells: placementParts(placed, this.catalog!) };
      if (!isValidSpellAction(action as unknown as Record<string, unknown>)) return false;
      // Elle revient TOUJOURS à un emplacement libre tiré au hasard (rotation comprise), que personne ne connaît.
      const spot = randomSpot(this.alivePlacement(), this.catalog!, reviveId, () => this.random());
      if (!spot) return false;
      newSpot = spot;
    } else {
      action = { ...params, kind: 'spell', spell: id } as SpellAction;
      if (!isValidSpellAction(action as unknown as Record<string, unknown>)) return false;
      if (def.param === 'player') {
        const who = action.who;
        if (who === undefined || !this.whoChoices(id).includes(who)) return false;
      }
    }
    let added: Placement | null = null;
    if (id === 'addpiece') {
      added = this.addedPlacement(n, action, spot);
      if (!added) return false;
    }
    s.spells.splice(s.spells.indexOf(id), 1);
    if (added) s.placement = [...s.placement, added];
    if (shuffled) {
      for (const sunkId of this.mySunk) s.revives.push({ n, id: sunkId });
      s.placement = shuffled;
    }
    if (reviveId) {
      s.revives.push({ n, id: reviveId });
      if (newSpot) {
        const moved = newSpot;
        s.placement = s.placement.map((p) => (p.pieceId === moved.pieceId ? moved : p));
      }
    }
    if (def.target === 'self') {
      if (!this.applySelf(id)) {
        s.spells.push(id);
        return false;
      }
      s.selfLog[String(n)] = id;
    }
    return this.act(action, to);
  }

  /** Mes pièces à flot (les pièces coulées ne bloquent plus leur emplacement). */
  alivePlacement(): Placement[] {
    const sunk = this.mySunk;
    return this.state.placement.filter((p) => !sunk.has(p.pieceId));
  }

  /** Placement du Renfort lancé au tour n, ou null s'il est invalide (pièce inconnue, hors grille, chevauchement). */
  private addedPlacement(n: number, action: SpellAction, spot?: { r: number; c: number; rot: 0 | 1 | 2 | 3 }): Placement | null {
    const set = this.state.pieceSet;
    if (!set || !spot || !action.shape || !action.color) return null;
    if (!catalogOf(set).pieces.some((b) => b.shape === action.shape && b.color === action.color)) return null;
    const def: PieceDef = { id: `x${n}.${action.shape}.${action.color}`, shape: action.shape, color: action.color };
    const cat = this.catalog!;
    const cand: Placement = { pieceId: def.id, r: spot.r, c: spot.c, rot: spot.rot };
    // une pièce coulée n'occupe plus sa place : on peut poser dessus
    const errors = validatePlacement([...this.alivePlacement(), cand], { ...cat, pieces: [...cat.pieces, def] });
    return errors.length === 0 ? cand : null;
  }

  /** Effet d'un sort secret sur mon propre plateau. */
  private applySelf(id: string): boolean {
    const s = this.state;
    const rnd = () => this.random();
    switch (id) {
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
          const others = alive.filter((p) => p.pieceId !== chosen.pieceId);
          const spot = randomSpot(others, cat, chosen.pieceId, rnd);
          if (spot) {
            s.placement = s.placement.map((p) => (p.pieceId === chosen.pieceId ? spot : p));
            return true;
          }
        }
        return false;
      }
      case 'mirage':
        s.fx.mirage = true;
        return true;
      case 'camouflage':
        s.fx.camouflage = true;
        return true;
      case 'pivot': {
        const sunk = this.mySunk;
        const alive = s.placement.filter((p) => !sunk.has(p.pieceId));
        const cat = this.catalog!;
        for (const chosen of [...alive].sort(() => rnd() - 0.5)) {
          const spot = pivotSpot(alive.filter((p) => p.pieceId !== chosen.pieceId), cat, chosen, rnd);
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
}

/** Cases occupées par une forme supposée du carnet. */
export function guessParts(g: GuessShape, catalog: Catalog) {
  return placementParts(g, catalog);
}
