import { afterEach, describe, expect, it } from 'vitest';
import { CLASSIC_SET, TRIANGLES_SET } from '../config/pieces';
import { RULES } from '../config/rules';
import { buildGrid, catalogOf, placementParts, randomPlacement, seededRandom, setHash, traceLaser } from '../engine';
import { PlayerSession, freshState, newGameId, type KeyValueStore, type SessionEvent } from './session';
import { createLocalPair, type LocalTransport } from './transport';
import { PROTOCOL_VERSION, appFingerprint, parseMessage, type Message } from './protocol';

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};

const classic = catalogOf(CLASSIC_SET);
const boardA = randomPlacement(classic, { random: seededRandom(1) });
const boardB = randomPlacement(classic, { random: seededRandom(2) });

function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

function spy(t: LocalTransport): Message[] {
  const sent: Message[] = [];
  const orig = t.send.bind(t);
  t.send = (m) => {
    sent.push(m);
    orig(m);
  };
  return sent;
}

function events(s: PlayerSession): SessionEvent[] {
  const out: SessionEvent[] = [];
  s.onEvent((e) => out.push(e));
  return out;
}

/** Hôte + invité connectés ; l'invité accepte le jeu ; les deux sont prêts. */
async function setupGame(opts: { hostFirst?: boolean; accept?: boolean; ready?: boolean } = {}) {
  const { hostFirst = true, accept = true, ready = true } = opts;
  const host = new PlayerSession(freshState('online', 0, 'Alice', newGameId(), CLASSIC_SET), null, '', () => (hostFirst ? 0.1 : 0.9));
  const guest = new PlayerSession(freshState('online', 1, 'Bob', '', null));
  const [ta, tb] = createLocalPair();
  const sentByHost = spy(ta);
  const sentByGuest = spy(tb);
  const hostEvents = events(host);
  const guestEvents = events(guest);
  host.attach(ta);
  guest.attach(tb);
  await flush();
  if (accept) {
    guest.acceptProposedSet();
    await flush();
  }
  if (ready) {
    host.setPlacement(boardA);
    host.markReady();
    if (accept) {
      guest.setPlacement(boardB);
      guest.markReady();
    }
    await flush();
  }
  return { host, guest, ta, tb, sentByHost, sentByGuest, hostEvents, guestEvents };
}

const original = { ...RULES };
afterEach(() => Object.assign(RULES, original));

describe('session : jeu de pièces proposé par l’hôte', () => {
  it('l’invité reçoit le jeu, doit l’accepter avant de placer', async () => {
    const { host, guest, guestEvents } = await setupGame({ accept: false, ready: false });
    expect(guest.phase).toBe('review');
    expect(guest.state.proposedSet?.name).toBe('Classique');
    expect(guestEvents.some((e) => e.type === 'set-proposed')).toBe(true);
    guest.setPlacement(boardB);
    expect(guest.markReady()).toBe(false);
    guest.acceptProposedSet();
    await flush();
    expect(guest.phase).toBe('setup');
    expect(host.state.oppSetHash).toBe(setHash(CLASSIC_SET));
  });

  it('refus, puis l’hôte propose un autre jeu, accepté : la partie démarre avec ce jeu', async () => {
    const { host, guest, hostEvents } = await setupGame({ accept: false, ready: false });
    guest.refuseProposedSet();
    await flush();
    expect(host.state.oppRefused).toBe(true);
    expect(hostEvents.some((e) => e.type === 'set-refused')).toBe(true);
    host.startNewGame(TRIANGLES_SET);
    await flush();
    expect(guest.phase).toBe('review');
    expect(guest.state.proposedSet?.name).toBe('Triangles');
    guest.acceptProposedSet();
    await flush();
    const tri = catalogOf(TRIANGLES_SET);
    host.setPlacement(randomPlacement(tri));
    guest.setPlacement(randomPlacement(tri));
    expect(host.markReady()).toBe(true);
    expect(guest.markReady()).toBe(true);
    await flush();
    expect(host.phase).toBe('playing');
    expect(guest.phase).toBe('playing');
    expect(guest.state.gameId).toBe(host.state.gameId);
  });

  it('la partie ne démarre pas tant que l’invité n’a pas accepté', async () => {
    const { host } = await setupGame({ accept: false, ready: true });
    expect(host.state.ready).toBe(true);
    expect(host.state.firstPlayer).toBeNull();
  });
});

describe('session : déroulement d’une partie', () => {
  it('connexion, prêt, l’hôte tire au sort le premier joueur', async () => {
    const { host, guest } = await setupGame();
    expect(guest.state.gameId).toBe(host.state.gameId);
    expect(guest.state.oppName).toBe('Alice');
    expect(host.phase).toBe('playing');
    expect(host.isMyTurn).toBe(true);
    expect(guest.isMyTurn).toBe(false);
  });

  it('un tir est calculé par le défenseur ; aucun secret ne circule', async () => {
    const { host, guest, sentByGuest, sentByHost } = await setupGame();
    expect(host.shoot({ side: 'left', index: 4 })).toBe(true);
    expect(host.shoot({ side: 'left', index: 5 })).toBe(false);
    await flush();
    const expected = traceLaser(buildGrid(boardB, classic), { side: 'left', index: 4 });
    expect(host.state.log[0].result).toEqual({
      kind: 'shot',
      exit: expected.exit,
      colors: expected.hits.map((id) => classic.pieces.find((p) => p.id === id)!.color),
    });
    expect(host.state.log[0].secret).toBeUndefined();
    expect(guest.state.log[0].secret?.hits).toEqual(expected.hits);

    // Aucun message ne contient d'identifiant de pièce posée, de position ou de secret.
    const all = JSON.stringify([...sentByGuest, ...sentByHost]);
    for (const p of [...boardA, ...boardB]) expect(all).not.toContain(`"${p.pieceId}"`);
    for (const word of ['placement', '"rot"', 'secret', '"hits"', 'sunkId', '"path"', '"notes"']) expect(all).not.toContain(word);

    expect(guest.isMyTurn).toBe(true);
    expect(host.shoot({ side: 'top', index: 0 })).toBe(false);
  });

  it('déclarations : fausse = tour perdu, juste = coulée et (par défaut) le tour passe, tout couler = victoire', async () => {
    const { host, guest } = await setupGame();
    host.claim({ color: 'bleu', shape: 'barre3', cells: [{ r: 9, c: 9 }, { r: 9, c: 8 }, { r: 9, c: 7 }] });
    await flush();
    expect(host.state.log[0].result).toEqual({ kind: 'claim', ok: false });
    for (const p of boardB) {
      expect(guest.shoot({ side: 'top', index: 0 })).toBe(true);
      await flush();
      const def = classic.pieces.find((d) => d.id === p.pieceId)!;
      expect(host.claim({ color: def.color, shape: def.shape, cells: placementParts(p, classic) })).toBe(true);
      await flush();
      expect(guest.mySunk.has(p.pieceId)).toBe(true);
    }
    expect(host.winner).toBe(0);
    expect(guest.winner).toBe(0);
    expect(host.oppSunk).toHaveLength(12);
  });

  it('règle « rejouer après une déclaration juste »', async () => {
    RULES.correctClaimPassesTurn = false;
    const { host, guest } = await setupGame();
    const p = boardB[0];
    const def = classic.pieces.find((d) => d.id === p.pieceId)!;
    host.claim({ color: def.color, shape: def.shape, cells: placementParts(p, classic) });
    await flush();
    expect(host.isMyTurn).toBe(true);
    expect(guest.isMyTurn).toBe(false);
    host.claim({ color: 'rouge', shape: 'carre', cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }] }); // fausse
    await flush();
    expect(guest.isMyTurn).toBe(true);
  });

  it('revanche : nouvel identifiant, même jeu, retour au placement', async () => {
    const { host, guest } = await setupGame();
    const old = host.state.gameId;
    guest.startNewGame();
    await flush();
    expect(host.state.gameId).not.toBe(old);
    expect(host.state.gameId).toBe(guest.state.gameId);
    expect(host.phase).toBe('setup');
    expect(guest.phase).toBe('setup');
    expect(host.state.oppSetHash).toBe(setHash(CLASSIC_SET));
  });

  it('revanche demandée des deux côtés en même temps : les deux convergent', async () => {
    const { host, guest } = await setupGame();
    host.startNewGame();
    guest.startNewGame();
    await flush();
    expect(host.state.gameId).toBe(guest.state.gameId);
    expect([host.state.myNewGameId, guest.state.myNewGameId].sort()[0]).toBe(host.state.gameId);
    expect(host.phase).toBe('setup');
    expect(guest.phase).toBe('setup');
  });
});

describe('session : coupures, reconnexion et journal non fiable', () => {
  it('résultat perdu : récupéré à la reconnexion', async () => {
    const { host, guest, tb } = await setupGame();
    tb.dropOutgoing = true;
    host.shoot({ side: 'bottom', index: 3 });
    await flush();
    expect(host.state.log).toHaveLength(0);
    const [ta2, tb2] = createLocalPair();
    host.attach(ta2);
    guest.attach(tb2);
    await flush();
    expect(host.state.pending).toBeNull();
    expect(host.state.log[0].result).toEqual(guest.state.log[0].result);
    expect(guest.isMyTurn).toBe(true);
  });

  it('action perdue : renvoyée à la reconnexion', async () => {
    const { host, guest, ta } = await setupGame();
    ta.dropOutgoing = true;
    host.shoot({ side: 'right', index: 7 });
    await flush();
    expect(guest.state.log).toHaveLength(0);
    const [ta2, tb2] = createLocalPair();
    guest.attach(tb2);
    host.attach(ta2);
    await flush();
    expect(guest.state.log).toHaveLength(1);
    expect(host.state.log).toHaveLength(1);
  });

  it('défenseur ayant perdu un tour : il le recalcule lui-même (et ses pièces coulées sont à jour)', async () => {
    const { host, guest } = await setupGame();
    const p = boardB[0];
    const def = classic.pieces.find((d) => d.id === p.pieceId)!;
    host.claim({ color: def.color, shape: def.shape, cells: placementParts(p, classic) });
    await flush();
    expect(guest.mySunk.has(p.pieceId)).toBe(true);
    guest.state.log.pop(); // perte locale
    expect(guest.mySunk.has(p.pieceId)).toBe(false);
    const [ta2, tb2] = createLocalPair();
    host.attach(ta2);
    guest.attach(tb2);
    await flush();
    expect(guest.state.log).toHaveLength(1);
    expect(guest.mySunk.has(p.pieceId)).toBe(true);
  });

  it('journal falsifié : un résultat inventé par l’attaquant n’est pas accepté par le défenseur', async () => {
    const { host, guest } = await setupGame();
    // L'hôte prétend avoir coulé une pièce en gagnant la partie, sans l'avoir fait.
    guest.receive(
      JSON.stringify({
        t: 'sync', v: PROTOCOL_VERSION, fp: appFingerprint(), gameId: guest.state.gameId, me: 0, name: 'Alice', ready: true, firstPlayer: 0, pending: null,
        set: CLASSIC_SET, setHash: setHash(CLASSIC_SET),
        log: [{ n: 0, by: 0, action: { kind: 'claim', claim: { color: 'rouge', shape: 'carre', cells: [{ r: 9, c: 9 }] } }, result: { kind: 'claim', ok: true, gameOver: true } }],
      }),
    );
    await flush();
    expect(guest.state.log).toHaveLength(1);
    expect(guest.state.log[0].result.gameOver).toBeUndefined();
    expect(guest.winner).toBeNull();
    // Mauvais joueur : refusé
    const before = guest.state.log.length;
    const errs = events(guest);
    guest.receive(
      JSON.stringify({
        t: 'sync', v: PROTOCOL_VERSION, fp: appFingerprint(), gameId: guest.state.gameId, me: 0, name: 'Alice', ready: true, firstPlayer: 0, pending: null,
        set: CLASSIC_SET, setHash: setHash(CLASSIC_SET),
        log: [...guest.state.log.map(({ n, by, action, result }) => ({ n, by, action, result })), { n: 1, by: 0, action: { kind: 'shot', edge: { side: 'top', index: 0 } }, result: { kind: 'shot', exit: { side: 'top', index: 0 }, colors: [] } }],
      }),
    );
    await flush();
    expect(guest.state.log).toHaveLength(before);
    expect(errs.some((e) => e.type === 'error')).toBe(true);
    void host;
  });

  it('versions différentes : la synchronisation est refusée', async () => {
    const guest = new PlayerSession(freshState('online', 1, 'Bob', '', null));
    const errs = events(guest);
    guest.receive(JSON.stringify({ t: 'sync', v: PROTOCOL_VERSION, fp: '0000000000000000', gameId: 'abc', me: 0, name: 'A', ready: false, firstPlayer: null, log: [], pending: null, set: CLASSIC_SET, setHash: setHash(CLASSIC_SET) }));
    expect(guest.state.gameId).toBe('');
    expect(guest.state.proposedSet).toBeNull();
    expect(errs[0]?.type).toBe('error');
  });

  it('un invité neuf ne peut pas reprendre une partie déjà commencée', async () => {
    const { host } = await setupGame();
    host.shoot({ side: 'top', index: 1 });
    await flush();
    const intruder = new PlayerSession(freshState('online', 1, 'Eve', '', null));
    const errs = events(host);
    const [a, b] = createLocalPair();
    host.attach(a);
    intruder.attach(b);
    await flush();
    expect(errs.some((e) => e.type === 'error')).toBe(true);
  });

  it('un message reçu en double ne rejoue pas le tour ; une action en avance demande une resynchronisation', async () => {
    const { host, guest, sentByGuest } = await setupGame();
    host.shoot({ side: 'top', index: 5 });
    await flush();
    guest.receive(JSON.stringify({ t: 'action', n: 0, action: { kind: 'shot', edge: { side: 'top', index: 5 } } }));
    await flush();
    expect(guest.state.log).toHaveLength(1);
    const count = sentByGuest.length;
    guest.receive(JSON.stringify({ t: 'action', n: 7, action: { kind: 'shot', edge: { side: 'top', index: 5 } } }));
    expect(sentByGuest.slice(count).some((m) => m.t === 'sync' && m.ask)).toBe(true);
  });

  it('état sauvegardé puis rechargé ; anciennes sauvegardes ignorées', () => {
    const store = memoryStore();
    const s = new PlayerSession(freshState('online', 1, 'Bob', 'abc', CLASSIC_SET), store, 'k');
    s.setPlacement(boardB);
    s.markReady();
    const again = PlayerSession.load(store, 'k')!;
    expect(again.state.placement).toEqual(boardB);
    expect(again.state.ready).toBe(true);
    store.setItem('old', JSON.stringify({ v: 1 }));
    expect(PlayerSession.load(store, 'old')).toBeNull();
  });
});

describe('protocole : messages malformés ou malveillants', () => {
  const bad: unknown[] = [
    'pas du json',
    { t: 'inconnu' },
    { t: 'action', n: 0, action: { kind: 'shot', edge: { side: 'top', index: 99 } } },
    { t: 'action', n: -1, action: { kind: 'shot', edge: { side: 'top', index: 0 } } },
    { t: 'action', n: 0, action: { kind: 'claim', claim: { color: '__proto__', shape: 'carre', cells: [{ r: 0, c: 0 }] } } },
    { t: 'action', n: 0, action: { kind: 'claim', claim: { color: 'constructor', shape: 'carre', cells: [{ r: 0, c: 0 }] } } },
    { t: 'action', n: 0, action: { kind: 'claim', claim: { color: 'rouge', shape: 'carre', cells: [{ r: 0, c: 0, corner: 'XX' }] } } },
    { t: 'action', n: 0, action: { kind: 'claim', claim: { color: 'rouge', shape: 'carre', cells: Array(20).fill({ r: 0, c: 0 }) } } },
    { t: 'result', n: 0, result: { kind: 'shot', exit: { side: 'top', index: 0 }, colors: ['__proto__'] } },
    { t: 'result', n: 0, result: { kind: 'claim', ok: true, gameOver: 'oui' } },
    { t: 'result', n: 0, result: { kind: 'claim', ok: 'true' } },
    { t: 'start', firstPlayer: 2 },
    { t: 'newgame', gameId: '' },
    { t: 'newgame', gameId: 'x', set: { ...CLASSIC_SET, entries: [{ shape: 'carre', color: '__proto__', count: 1 }] } },
    { t: 'newgame', gameId: 'x', set: { ...CLASSIC_SET, entries: [{ shape: 'tri4', color: 'bleu', count: 6 }], shapes: TRIANGLES_SET.shapes } },
    { t: 'set-accept', hash: '__proto__' },
  ];
  const sync = { t: 'sync', v: PROTOCOL_VERSION, fp: 'x', gameId: 'g', me: 0, name: 'A', ready: false, firstPlayer: null, log: [], pending: null, set: null, setHash: null };
  bad.push({ ...sync, ready: 'true' }, { ...sync, firstPlayer: 3 }, { ...sync, me: '0' }, { ...sync, log: [{ n: 0, by: 0, action: { kind: 'shot', edge: { side: 'top', index: 0 } }, result: { kind: 'claim', ok: true } }] }, { ...sync, setHash: 'zz' });

  it.each(bad.map((b, i) => [i, b]))('message invalide n°%i rejeté', (_i, b) => {
    expect(parseMessage(typeof b === 'string' ? b : JSON.stringify(b))).toBeNull();
  });

  it('un message valide passe', () => {
    expect(parseMessage(JSON.stringify(sync))).not.toBeNull();
    expect(parseMessage(JSON.stringify({ ...sync, set: TRIANGLES_SET, setHash: setHash(TRIANGLES_SET) }))).not.toBeNull();
  });
});
