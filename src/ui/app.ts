/**
 * Contrôleur de l'application : navigation entre écrans, sauvegarde, modes de jeu,
 * connexion en étoile (l'hôte accueille jusqu'à 3 invités et relaie).
 */

import { edgeLabel, sameEdge, type Edge } from '../engine';
import { driveBot } from '../game/bot';
import type { PlayerIndex } from '../game/protocol';
import { COLORS } from '../config/pieces';
import { RULES } from '../config/rules';
import type { Activity } from '../game/protocol';
import { PlayerSession, freshState, newGameId, type Mode, type SessionEvent, type TurnEntry } from '../game/session';
import { createLocalPair } from '../game/transport';
import { HubGuest, HubHost } from '../net/hub';
import type { PeerLink } from '../net/peer';
import { decodeDesc, extractCode } from '../net/sdpCodec';
import { buzz, confirmBox, h, modal, toast } from './dom';
import { renderConnect, type ConnectOptions } from './screens/connect';
import { renderHandoff, renderLobby, renderOver, renderPlacement, renderPlaying, renderReview, renderWaiting } from './screens/game';
import { renderHome, rulesContent } from './screens/home';
import { renderSettings } from './screens/settings';
import { activeSet, spellConfig } from './library';
import { describeSpell, spellName } from './spellText';
import { store } from './storage';

export type Tab = 'shoot' | 'notes' | 'spells' | 'board';
export type Tool = 'x' | 'o' | '?' | 'erase' | 'shapes';

export interface UiState {
  tab: Tab;
  selectedEdge: Edge | null;
  tool: Tool;
  selectedPiece: string | null;
  viewTurn: number | null;
  unseenIncoming: boolean;
  /** Une fenêtre de choix de sort est ouverte. */
  picking?: boolean;
  /** À 3 ou 4 joueurs : grille adverse agrandie (cible) dans Tirer et Carnet ; null = vue d'ensemble. */
  target: PlayerIndex | null;
}

export interface GameCtx {
  kind: 'game';
  mode: Mode;
  sessions: Partial<Record<PlayerIndex, PlayerSession>>;
  viewer: PlayerIndex;
  handoff: PlayerIndex | null;
  handoffInfo: string | null;
  cleanup: (() => void)[];
}

type Ctx = { kind: 'home' } | { kind: 'settings'; el: HTMLElement } | { kind: 'connect'; dispose: () => void; el: HTMLElement; session: PlayerSession } | GameCtx;

interface WakeLockLike {
  release(): Promise<void>;
  addEventListener?(type: 'release', fn: () => void): void;
}

const KEY_NAME = 'bb.name';
const KEY_CURRENT = 'bb.current';
const keyFor = (mode: Mode, i: PlayerIndex) => (mode === 'online' ? 'bb.online' : `bb.${mode}.${i}`);

export { store };

/** Couleur et initiale de chaque joueur (place 0 à 3), pour les distinguer partout. */
export const PLAYER_COLORS = ['#3F6FAE', '#C4473A', '#5E9A5B', '#9A6DAF'];
export const playerColor = (i: PlayerIndex) => PLAYER_COLORS[i] ?? '#8C8A85';

const defaultUi = (): UiState => ({ tab: 'shoot', selectedEdge: null, tool: 'x', selectedPiece: null, viewTurn: null, unseenIncoming: false, target: null });

export class App {
  ctx: Ctx = { kind: 'home' };
  ui: UiState = defaultUi();
  private dragging = false;
  private renderQueued = false;
  private pendingRender = false;
  private lastKey = '';
  /** Hub réseau courant (gardé même si on revient à l'accueil). */
  private hub: HubHost | HubGuest | null = null;
  private wakeLock: WakeLockLike | null = null;

  constructor(private root: HTMLElement) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.updateWakeLock();
    });
    // Lien d'invitation ouvert alors que l'app est déjà affichée dans cet onglet.
    window.addEventListener('hashchange', () => void this.handleHash());
    void this.handleHash();
    if (this.ctx.kind === 'home') this.render();
  }

  // ---------- rendu ----------

  render(): void {
    if (this.dragging) {
      this.pendingRender = true;
      return;
    }
    if (this.ctx.kind === 'connect' || this.ctx.kind === 'settings') {
      if (this.root.firstChild !== this.ctx.el) this.root.replaceChildren(this.ctx.el);
      this.lastKey = this.ctx.kind;
      return;
    }
    let el: HTMLElement;
    let key: string;
    if (this.ctx.kind === 'home') {
      el = renderHome(this);
      key = 'home';
    } else {
      const ctx = this.ctx;
      const session = ctx.sessions[ctx.viewer]!;
      if (ctx.handoff !== null) {
        const name = ctx.sessions[ctx.handoff]?.state.myName ?? `Joueur ${ctx.handoff + 1}`;
        el = renderHandoff(this, name, ctx.handoffInfo);
        key = `handoff${ctx.handoff}`;
      } else {
        const phase = session.phase;
        key = `game-${ctx.viewer}-${phase}-${this.ui.tab}-${this.ui.target ?? 'all'}`;
        if (phase === 'lobby') el = renderLobby(this, ctx, session);
        else if (phase === 'review') el = renderReview(this, ctx, session);
        else if (phase === 'setup') el = renderPlacement(this, ctx, session);
        else if (phase === 'waiting') el = renderWaiting(this, ctx, session);
        else if (phase === 'over') el = renderOver(this, ctx, session);
        else el = renderPlaying(this, ctx, session);
        session.setActivity(phase === 'playing' ? this.currentActivity() : null);
      }
    }
    // conserver la position de défilement si on reste sur le même écran
    const oldScroll = this.root.querySelector('.scroll')?.scrollTop ?? 0;
    this.root.replaceChildren(el);
    if (key === this.lastKey) {
      const sc = this.root.querySelector('.scroll');
      if (sc) sc.scrollTop = oldScroll;
    }
    this.lastKey = key;
  }

  /** Rendu groupé (plusieurs changements dans la même image). */
  scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  setUi(patch: Partial<UiState>): void {
    Object.assign(this.ui, patch);
    if (patch.tab === 'board') this.ui.unseenIncoming = false;
    if (patch.tab && patch.tab !== 'board' && patch.viewTurn === undefined) this.ui.viewTurn = null;
    if (patch.target !== undefined && patch.selectedEdge === undefined) this.ui.selectedEdge = null;
    this.render();
  }

  /** Ce que je fais en ce moment, pour l'afficher chez les autres. */
  private currentActivity(): Activity {
    if (this.ui.picking) return 'spell-pick';
    switch (this.ui.tab) {
      case 'notes':
        return 'notes';
      case 'spells':
        return 'spells';
      case 'board':
        return 'board';
      default:
        return this.ui.selectedEdge ? 'aim' : 'shoot';
    }
  }

  setDragging(active: boolean): void {
    this.dragging = active;
    if (!active && this.pendingRender) {
      this.pendingRender = false;
      this.scheduleRender();
    }
  }

  // ---------- nom ----------

  myName(): string {
    return store.getItem(KEY_NAME) ?? '';
  }

  setMyName(name: string): void {
    store.setItem(KEY_NAME, name.trim().slice(0, 20));
  }

  // ---------- sauvegardes ----------

  private loadSaved(): { mode: Mode; sessions: Partial<Record<PlayerIndex, PlayerSession>> } | null {
    const mode = store.getItem(KEY_CURRENT) as Mode | null;
    if (mode !== 'online' && mode !== 'local' && mode !== 'bot') return null;
    if (mode === 'online') {
      const s = PlayerSession.load(store, keyFor('online', 0));
      return s ? { mode, sessions: { [s.state.me]: s } } : null;
    }
    const a = PlayerSession.load(store, keyFor(mode, 0));
    const b = PlayerSession.load(store, keyFor(mode, 1));
    return a && b ? { mode, sessions: { 0: a, 1: b } } : null;
  }

  savedGameSummary(): string | null {
    const saved = this.loadSaved();
    if (!saved) return null;
    const s = Object.values(saved.sessions)[0]!;
    let label: string;
    if (saved.mode === 'online') {
      const others = s.opponents.map((i) => s.state.players[i].name).filter(Boolean);
      label = others.length ? `En ligne avec ${others.join(', ')}` : 'En ligne';
    } else if (saved.mode === 'bot') label = 'Contre le robot';
    else label = `${saved.sessions[0]!.state.myName} contre ${saved.sessions[1]!.state.myName}`;
    const phase = s.phase === 'over' ? 'terminée' : s.phase === 'lobby' ? 'salon' : s.phase === 'setup' || s.phase === 'waiting' || s.phase === 'review' ? 'placement' : `${s.state.log.length} coups joués`;
    return `${label} · ${phase}`;
  }

  // ---------- démarrage des modes ----------

  private requireName(): string | null {
    const name = this.myName();
    if (!name) {
      toast('Entre d’abord ton prénom.', 'warn');
      (document.getElementById('name') as HTMLInputElement | null)?.focus();
      return null;
    }
    return name;
  }

  private async confirmReplace(): Promise<boolean> {
    if (!this.loadSaved()) return true;
    return confirmBox('Nouvelle partie ?', 'La partie sauvegardée sera remplacée.', 'Continuer', true);
  }

  async startOnline(role: 'host' | 'guest', prefill?: string): Promise<void> {
    const name = this.requireName();
    if (!name) return;
    if (!(await this.confirmReplace())) return;
    this.clearSaved();
    this.closeHub();
    const session = new PlayerSession(
      freshState('online', role === 'host' ? 0 : 1, name, role === 'host' ? newGameId() : '', role === 'host' ? activeSet() : null, spellConfig()),
      store,
      keyFor('online', 0),
    );
    session.persist();
    store.setItem(KEY_CURRENT, 'online');
    this.ui = defaultUi();
    if (role === 'host') this.hostHub(session);
    this.openConnect({ session, role, reconnect: false, prefill });
  }

  /** Crée le hub de l'hôte et y branche la session. */
  private hostHub(session: PlayerSession): HubHost {
    const hub = new HubHost((hello) => session.admit(hello));
    hub.onSendFailed = (to) => toast(`Un message n’a pas pu être envoyé à ${to === 'all' ? 'tout le monde' : session.nameOf(to)} (connexion instable ou message trop gros). Touche « Renvoyer » ou reconnecte-toi.`, 'warn', 5000);
    hub.onAdmitted = (peer) => {
      if (this.hub !== hub) return;
      buzz(30);
      toast(`${session.nameOf(peer) || 'Un joueur'} est connecté.`, 'ok');
      if (this.ctx.kind === 'connect') this.enterOnlineGame(session);
      else this.scheduleRender();
    };
    this.hub = hub;
    session.attach(hub);
    return hub;
  }

  /**
   * Appelé par l'écran de connexion dès qu'un lien est créé (avant même qu'il s'ouvre) :
   * l'hôte l'ajoute à son hub, l'invité s'en sert pour rejoindre le hub de l'hôte.
   */
  prepareLink(session: PlayerSession, link: PeerLink): void {
    if (session.state.me === 0) {
      const hub = this.hub instanceof HubHost ? this.hub : this.hostHub(session);
      hub.addLink(link);
      return;
    }
    if (this.hub) this.hub.close();
    const guest = new HubGuest(link, session.hello);
    guest.onSendFailed = () => toast('Un message n’a pas pu être envoyé à l’hôte (connexion instable ou message trop gros). Touche « Renvoyer » ou reconnecte-toi.', 'warn', 5000);
    guest.onWelcome = (you, token) => {
      session.setIndex(you);
      session.setToken(token);
    };
    guest.onReject = (reason) => toast(`Connexion refusée : ${reason}`, 'error', 6000);
    this.hub = guest;
    session.attach(guest);
    const prevStatus = guest.onStatus;
    guest.onStatus = (up) => {
      prevStatus?.(up);
      if (up && this.hub === guest) {
        buzz(30);
        toast('Connecté à l’hôte !', 'ok');
        if (this.ctx.kind === 'connect') this.enterOnlineGame(session);
      } else this.scheduleRender();
    };
  }

  async startLocal(): Promise<void> {
    if (!(await this.confirmReplace())) return;
    const n1 = h('input', { class: 'input', value: this.myName() || 'Joueur 1', maxlength: 20, 'aria-label': 'Joueur 1' });
    const n2 = h('input', { class: 'input', value: 'Joueur 2', maxlength: 20, 'aria-label': 'Joueur 2' });
    const v = await modal(
      'Deux joueurs, un téléphone',
      [
        h('label', { class: 'field' }, h('span', null, 'Joueur 1'), n1),
        h('label', { class: 'field' }, h('span', null, 'Joueur 2'), n2),
        h('p', { class: 'muted small' }, 'Chacun place ses pièces sans regarder, puis on se passe le téléphone à chaque tour.'),
      ],
      [
        { label: 'Annuler', value: 'no' },
        { label: 'Commencer', value: 'go', kind: 'primary' },
      ],
    );
    if (v !== 'go') return;
    this.newPairGame('local', n1.value.trim() || 'Joueur 1', n2.value.trim() || 'Joueur 2');
  }

  async startBot(): Promise<void> {
    if (!(await this.confirmReplace())) return;
    this.newPairGame('bot', this.myName() || 'Moi', 'Robot');
  }

  private newPairGame(mode: 'local' | 'bot', name0: string, name1: string): void {
    this.clearSaved();
    const gameId = newGameId();
    const set = activeSet(); // même jeu pour les deux joueurs, accepté d'office
    const cfg = spellConfig();
    const names = [name0, name1];
    const a = new PlayerSession(freshState(mode, 0, name0, gameId, set, cfg, names), store, keyFor(mode, 0));
    const b = new PlayerSession(freshState(mode, 1, name1, gameId, set, cfg, names), store, keyFor(mode, 1));
    a.persist();
    b.persist();
    store.setItem(KEY_CURRENT, mode);
    this.ui = defaultUi();
    this.enterPairGame(mode, a, b);
  }

  private enterPairGame(mode: 'local' | 'bot', a: PlayerSession, b: PlayerSession): void {
    this.disposeCtx();
    const [ta, tb] = createLocalPair();
    a.attach(ta);
    b.attach(tb);
    const ctx: GameCtx = { kind: 'game', mode, sessions: { 0: a, 1: b }, viewer: 0, handoff: null, handoffInfo: null, cleanup: [] };
    if (mode === 'bot') ctx.cleanup.push(driveBot(b));
    // Mode un seul téléphone : reprendre sur le bon joueur.
    if (mode === 'local') {
      const turnOf = a.attackerOf(a.state.log.length);
      if (!a.state.ready) ctx.viewer = 0;
      else if (!b.state.ready) ctx.viewer = 1;
      else if (a.phase === 'playing' && turnOf !== null) ctx.viewer = turnOf;
      if (a.state.log.length > 0 || a.state.ready) ctx.handoff = ctx.viewer;
    }
    this.ctx = ctx;
    this.wireSessions(ctx);
    this.render();
  }

  private wireSessions(ctx: GameCtx): void {
    for (const idx of [0, 1, 2, 3] as PlayerIndex[]) {
      const s = ctx.sessions[idx];
      if (!s) continue;
      ctx.cleanup.push(s.onChange(() => this.scheduleRender()));
      ctx.cleanup.push(s.onEvent((e) => this.onSessionEvent(ctx, idx, e)));
    }
    void this.updateWakeLock();
  }

  private onSessionEvent(ctx: GameCtx, idx: PlayerIndex, e: SessionEvent): void {
    if (this.ctx !== ctx) return;
    const s = ctx.sessions[idx]!;
    const isViewer = idx === ctx.viewer && ctx.handoff === null;
    if (ctx.mode === 'bot' && idx === 1) return;
    switch (e.type) {
      case 'incoming':
        if (ctx.mode === 'local') return; // affiché au passage du téléphone
        buzz(40);
        toast(`${s.nameOf(e.entry.by)} : ${describeTurn(e.entry, s)}`, 'info', 4500);
        if (this.ui.tab !== 'board') this.ui.unseenIncoming = true;
        break;
      case 'turn':
        if (!isViewer || s.playerCount < 3) return;
        toast(`${s.nameOf(e.entry.by)}${e.entry.target !== e.entry.by ? ` → ${s.nameOf(e.entry.target)}` : ''} : ${describeTurn(e.entry, s)}`, 'info', 3500);
        break;
      case 'outcome':
        if (!isViewer) return;
        buzz(25);
        // Le résultat d'un tir s'affiche déjà dans la carte « Ton dernier coup ».
        if (e.entry.result.kind === 'claim') toast(describeTurn(e.entry, s), e.entry.result.ok ? 'ok' : 'warn', 4500);
        break;
      case 'eliminated':
        if (!isViewer) return;
        buzz(60);
        toast(e.player === s.state.me ? 'Toutes tes pièces sont coulées : tu es éliminé. Tu peux suivre la fin de la partie.' : `${s.nameOf(e.player)} est éliminé !`, e.player === s.state.me ? 'warn' : 'ok', 5000);
        break;
      case 'spell-gained':
        if (isViewer) toast(`Nouveau sort : ${spellName(e.spell)}`, 'ok', 3500);
        break;
      case 'started': {
        if (ctx.mode === 'local') {
          if (idx !== 0) return; // un seul message suffit
          const first = e.firstPlayer;
          if (first !== ctx.viewer) {
            ctx.viewer = first;
            ctx.handoff = first;
            ctx.handoffInfo = `Tirage au sort : ${ctx.sessions[first]!.state.myName} commence.`;
          } else {
            toast(`Tirage au sort : ${s.state.myName} commence !`, 'ok');
          }
        } else if (isViewer) {
          toast(e.firstPlayer === s.state.me ? 'Tirage au sort : tu commences !' : `Tirage au sort : ${s.nameOf(e.firstPlayer)} commence.`, 'ok');
        }
        this.ui.selectedEdge = null;
        this.scheduleRender();
        break;
      }
      case 'newgame':
        if (isViewer) toast(s.phase === 'lobby' ? 'Nouvelle partie : retour au salon.' : 'Nouvelle partie : place tes pièces.', 'info');
        this.ui = defaultUi();
        break;
      case 'set-proposed':
        if (isViewer && ctx.mode === 'online') toast(`${s.nameOf(0)} propose un jeu de pièces : à toi de l’accepter.`, 'info', 4500);
        break;
      case 'set-refused':
        if (isViewer) toast(`${s.nameOf(e.by)} a refusé le jeu de pièces.`, 'warn', 4500);
        break;
      case 'set-accepted':
      case 'roster':
        break;
      case 'error':
        if (isViewer || ctx.mode === 'online') toast(e.message, 'error', 6000);
        break;
    }
  }

  // ---------- connexion réseau ----------

  private openConnect(opts: ConnectOptions): void {
    this.disposeCtx();
    const { el, dispose } = renderConnect(this, opts);
    this.ctx = { kind: 'connect', el, dispose, session: opts.session };
    this.render();
  }

  private enterOnlineGame(session: PlayerSession): void {
    if (this.ctx.kind === 'connect') {
      // ne pas fermer le lien qui vient de s'ouvrir
      const c = this.ctx;
      this.ctx = { kind: 'home' };
      c.dispose();
    } else {
      this.disposeCtx();
    }
    if (session.state.me === 0 && !(this.hub instanceof HubHost)) this.hostHub(session);
    const ctx: GameCtx = { kind: 'game', mode: 'online', sessions: { [session.state.me]: session }, viewer: session.state.me, handoff: null, handoffInfo: null, cleanup: [] };
    this.ctx = ctx;
    this.wireSessions(ctx);
    this.render();
  }

  leaveConnect(): void {
    if (this.ctx.kind !== 'connect') return;
    const session = this.ctx.session;
    const st = session.state;
    const inProgress = st.gameId && (st.ready || st.log.length > 0 || st.placement.length > 0 || st.players.length > 1);
    if (inProgress) this.enterOnlineGame(session);
    else this.goHome();
  }

  /** Reconnexion (ou invitation d'un autre joueur pour l'hôte). */
  reconnect(): void {
    if (this.ctx.kind !== 'game' || this.ctx.mode !== 'online') return;
    const session = this.ctx.sessions[this.ctx.viewer]!;
    this.openConnect({ session, role: session.state.me === 0 ? 'host' : 'guest', reconnect: true });
  }

  /** Hôte, dans le salon : invite un joueur de plus. */
  invite(): void {
    if (this.ctx.kind !== 'game' || this.ctx.mode !== 'online') return;
    const session = this.ctx.sessions[this.ctx.viewer]!;
    if (session.state.me !== 0) return;
    this.openConnect({ session, role: 'host', reconnect: false });
  }

  private closeHub(): void {
    this.hub?.close();
    this.hub = null;
  }

  // ---------- reprise ----------

  resume(): void {
    const saved = this.loadSaved();
    if (!saved) {
      toast('Aucune partie sauvegardée.', 'warn');
      return;
    }
    this.ui = defaultUi();
    if (saved.mode === 'online') {
      const s = Object.values(saved.sessions)[0]!;
      this.closeHub();
      if (s.state.me === 0) this.hostHub(s);
      if (s.neverConnected) {
        // jamais connecté (hôte sans invité, invité jamais accueilli) : on reprend la connexion
        this.openConnect({ session: s, role: s.state.me === 0 ? 'host' : 'guest', reconnect: false });
        return;
      }
      this.enterOnlineGame(s);
      toast('Partie reprise hors ligne : touche « Reconnecter ».', 'info', 4000);
      return;
    }
    this.enterPairGame(saved.mode, saved.sessions[0]!, saved.sessions[1]!);
  }

  private clearSaved(): void {
    for (const k of ['bb.online', 'bb.local.0', 'bb.local.1', 'bb.bot.0', 'bb.bot.1', KEY_CURRENT]) store.removeItem(k);
  }

  // ---------- navigation en jeu ----------

  private disposeCtx(): void {
    const c = this.ctx;
    if (c.kind === 'game') {
      c.cleanup.forEach((f) => f());
      for (const s of Object.values(c.sessions)) if (s && c.mode !== 'online') s.detach();
    } else if (c.kind === 'connect') {
      c.dispose();
    }
    this.ctx = { kind: 'home' };
  }

  openSettings(): void {
    this.disposeCtx();
    this.ctx = { kind: 'settings', el: renderSettings(() => this.goHome()) };
    this.render();
  }

  goHome(): void {
    this.disposeCtx();
    this.ui = defaultUi();
    void this.updateWakeLock();
    this.render();
  }

  async openMenu(): Promise<void> {
    const v = await modal('Menu', h('p', { class: 'muted' }, 'La partie est sauvegardée automatiquement sur ce téléphone.'), [
      { label: 'Règles', value: 'rules' },
      { label: 'Abandonner', value: 'quit', kind: 'danger' },
      { label: 'Accueil', value: 'home', kind: 'primary' },
    ]);
    if (v === 'home') this.goHome();
    else if (v === 'rules') await modal('Règles du jeu', rulesContent(), [{ label: 'Compris', value: 'ok', kind: 'primary' }]);
    else if (v === 'quit') {
      if (await confirmBox('Abandonner la partie ?', 'La sauvegarde de cette partie sera effacée de ce téléphone.', 'Abandonner', true)) {
        this.disposeCtx();
        this.closeHub();
        this.clearSaved();
        this.goHome();
      }
    }
  }

  afterReady(session: PlayerSession): void {
    const ctx = this.ctx;
    if (ctx.kind !== 'game' || ctx.mode !== 'local') return;
    const other = ctx.sessions[(1 - session.state.me) as PlayerIndex]!;
    if (!other.state.ready) {
      ctx.viewer = other.state.me;
      ctx.handoff = other.state.me;
      ctx.handoffInfo = `${session.state.myName} a placé ses pièces. À toi !`;
      this.render();
    }
  }

  handoff(to: PlayerIndex): void {
    const ctx = this.ctx;
    if (ctx.kind !== 'game' || ctx.mode !== 'local') return;
    const target = ctx.sessions[to]!;
    const last = [...target.state.log].reverse().find((e) => e.by !== to);
    ctx.viewer = to;
    ctx.handoff = to;
    ctx.handoffInfo = last ? `${ctx.sessions[last.by]!.state.myName} : ${describeTurn(last, target)}` : null;
    this.ui = { ...defaultUi(), tab: 'shoot' };
    this.render();
  }

  endHandoff(): void {
    if (this.ctx.kind !== 'game') return;
    this.ctx.handoff = null;
    this.ctx.handoffInfo = null;
    this.render();
  }

  /** Revanche (hôte / joueur 0). `lobby` : revenir au salon pour changer les joueurs. */
  rematch(lobby = false): void {
    const ctx = this.ctx;
    if (ctx.kind !== 'game') return;
    const host = ctx.sessions[0];
    if (!host) {
      toast('Seul l’hôte peut lancer la revanche.', 'warn');
      return;
    }
    // L'hôte (joueur 0) impose les réglages des sorts.
    host.startNewGame(undefined, spellConfig(), lobby && ctx.mode === 'online');
    this.ui = defaultUi();
    if (ctx.mode === 'local') {
      ctx.viewer = 0;
      ctx.handoff = 0;
      ctx.handoffInfo = 'Revanche ! Chacun replace ses pièces.';
    }
    this.render();
  }

  // ---------- lien d'invitation (#c=...) ----------

  private async handleHash(): Promise<void> {
    const m = location.hash.match(/[#&]c=([^&]+)/);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    const text = decodeURIComponent(m[1]);
    const code = extractCode(text);
    if (!code) return;
    let type: 'offer' | 'answer';
    try {
      type = decodeDesc(code).type;
    } catch {
      toast('Lien d’invitation abîmé.', 'error');
      return;
    }
    if (type !== 'offer') {
      toast('Ce code de réponse doit être collé sur le téléphone qui a créé la partie.', 'warn', 5000);
      return;
    }
    const saved = this.loadSaved();
    if (saved?.mode === 'online') {
      const s = Object.values(saved.sessions)[0]!;
      if (s.state.me !== 0 && s.phase !== 'over' && !s.neverConnected) {
        // Invitation de reconnexion pour la partie en cours (ce téléphone y a déjà sa place).
        this.openConnect({ session: s, role: 'guest', reconnect: true, prefill: code });
        return;
      }
    }
    if (saved && Object.values(saved.sessions)[0]!.phase !== 'over') {
      const ok = await confirmBox('Rejoindre cette partie ?', 'Une partie est déjà sauvegardée sur ce téléphone : elle sera remplacée.', 'Rejoindre', true);
      if (!ok) {
        this.render();
        return;
      }
    }
    if (!this.myName()) this.setMyName('Invité');
    this.clearSaved();
    this.closeHub();
    const session = new PlayerSession(freshState('online', 1, this.myName(), '', null), store, keyFor('online', 0));
    session.persist();
    store.setItem(KEY_CURRENT, 'online');
    this.openConnect({ session, role: 'guest', reconnect: false, prefill: code });
  }

  // ---------- écran allumé pendant la partie ----------

  private async updateWakeLock(): Promise<void> {
    const want = this.ctx.kind === 'game' && document.visibilityState === 'visible';
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockLike> } };
    try {
      if (want && !this.wakeLock && nav.wakeLock) {
        const lock = await nav.wakeLock.request('screen');
        this.wakeLock = lock;
        // le système relâche le verrou quand l'app passe en arrière-plan
        lock.addEventListener?.('release', () => {
          if (this.wakeLock === lock) this.wakeLock = null;
        });
      } else if (!want && this.wakeLock) {
        await this.wakeLock.release();
        this.wakeLock = null;
      }
    } catch {
      this.wakeLock = null;
    }
  }
}

/** Texte court décrivant un coup (du point de vue de `session`, pour les noms). */
export function describeTurn(e: TurnEntry, session?: PlayerSession): string {
  if (e.action.kind === 'shot' && e.result.kind === 'shot') {
    const where = sameEdge(e.action.edge, e.result.exit) ? 'revient au départ' : `ressort en ${edgeLabel(e.result.exit)}`;
    const hit = e.result.colors.length ? `touché ${e.result.colors.map((c) => COLORS[c]?.name ?? c).join(', ')}` : 'rien touché';
    return `tir ${edgeLabel(e.action.edge)}, ${where}, ${hit}.`;
  }
  if (e.result.kind === 'claim') {
    if (!e.result.ok) return 'déclaration fausse, tour perdu.';
    if (e.result.eliminated) return 'déclaration juste, dernière pièce coulée : éliminé !';
    return RULES.correctClaimPassesTurn ? 'déclaration juste, pièce coulée ; le tour passe.' : 'déclaration juste, pièce coulée ; il rejoue.';
  }
  if (e.result.kind === 'spell') return `sort : ${describeSpell(e, session?.catalog ?? null, undefined, session ? (i) => session.nameOf(i) : undefined)}.`;
  return '';
}
