/**
 * Parties à 3 et 4 joueurs : ordre des tours, éliminations, cibles, confidentialité des
 * sorts, sorts réservés au multi, reprise après coupure, hub en étoile.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLASSIC_SET } from '../config/pieces';
import { DEFAULT_SPELL_CONFIG, attackerAt, catalogOf, forcedTargetAt, placementParts, randomPlacement, seededRandom, validatePlacement, type Placement } from '../engine';
import { HubGuest, HubHost, type RawLink } from '../net/hub';
import { PROTOCOL_VERSION, appFingerprint, type PlayerIndex } from './protocol';
import { PlayerSession, freshState, newGameId, type SessionEvent, type TurnEntry } from './session';
import { createLocalHub, type LocalHub, type Transport } from './transport';

const flush = async (rounds = 40) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};
const cat = catalogOf(CLASSIC_SET);
const cfg = { ...DEFAULT_SPELL_CONFIG, enabled: true, everyTurns: 0, onSink: false };

function events(s: PlayerSession): SessionEvent[] {
  const out: SessionEvent[] = [];
  s.onEvent((e) => out.push(e));
  return out;
}

/** Hôte + (n-1) invités reliés par un hub en mémoire ; la partie est lancée, tout le monde est prêt ; le joueur 0 commence. */
async function game(n: number, opts: { transports?: Transport[]; hub?: LocalHub; first?: number } = {}) {
  const hub = opts.hub ?? createLocalHub(n);
  const ports = opts.transports ?? hub.ports;
  const first = opts.first ?? 0;
  const sessions: PlayerSession[] = [];
  const names = ['Ana', 'Bo', 'Cy', 'Dee'];
  const hostRandom = (() => {
    let used = false;
    const rng = seededRandom(5);
    return () => (used ? rng() : ((used = true), (first + 0.5) / n));
  })();
  sessions.push(new PlayerSession(freshState('online', 0, names[0], newGameId(), CLASSIC_SET, cfg), null, '', hostRandom));
  for (let i = 1; i < n; i++) sessions.push(new PlayerSession(freshState('online', i as PlayerIndex, names[i], '', null), null, '', seededRandom(100 + i)));
  const evs = sessions.map(events);
  sessions.forEach((s, i) => s.attach(ports[i]));
  await flush();
  expect(sessions[0].launch()).toBe(true);
  await flush();
  for (let i = 1; i < n; i++) sessions[i].acceptProposedSet();
  await flush();
  sessions.forEach((s, i) => {
    s.setPlacement(randomPlacement(cat, { random: seededRandom(10 + i) }));
    expect(s.markReady()).toBe(true);
  });
  await flush();
  for (const s of sessions) expect(s.phase).toBe('playing');
  return { sessions, hub, ports, evs };
}

/** Déclare la première pièce à flot de `target`, en trichant (le test connaît toutes les grilles). */
function claimOne(by: PlayerSession, target: PlayerSession): boolean {
  const sunk = target.mySunk;
  const p: Placement = target.state.placement.find((x) => !sunk.has(x.pieceId))!;
  const def = cat.pieces.find((d) => d.id === p.pieceId)!;
  return by.claim({ color: def.color, shape: def.shape, cells: placementParts(p, cat) }, target.state.me);
}

const kinds = (s: PlayerSession) => s.state.log.map((e) => `${e.by}>${e.target}:${e.action.kind === 'spell' ? e.action.spell : e.action.kind}`);

describe('multijoueur : salon, rotation et visibilité', () => {
  it('à trois : liste des joueurs partagée, rotation 0 → 1 → 2 → 0, tirs visibles de tous', async () => {
    const { sessions: [a, b, c] } = await game(3);
    for (const s of [a, b, c]) expect(s.state.players.map((p) => p.name)).toEqual(['Ana', 'Bo', 'Cy']);
    expect(a.isMyTurn).toBe(true);
    expect(a.shoot({ side: 'top', index: 2 }, 1)).toBe(true);
    await flush();
    expect(b.isMyTurn).toBe(true);
    expect(b.shoot({ side: 'left', index: 3 }, 2)).toBe(true);
    await flush();
    expect(c.isMyTurn).toBe(true);
    expect(c.shoot({ side: 'right', index: 8 }, 0)).toBe(true);
    await flush();
    expect(a.isMyTurn).toBe(true);
    // le même journal public partout, résultats compris
    const pub = (s: PlayerSession) => JSON.stringify(s.publicLogFor(3));
    expect(pub(a)).toBe(pub(b));
    expect(pub(b)).toBe(pub(c));
    expect(a.state.log[1].result).toEqual(b.state.log[1].result);
    expect(c.state.log[1].secret).toBeDefined();
    expect(a.state.log[1].secret).toBeUndefined();
  });

  it('on ne peut pas se viser soi-même ni viser un joueur éliminé ; cible obligatoire', async () => {
    const { sessions: [a] } = await game(3);
    expect(a.shoot({ side: 'top', index: 0 }, 0)).toBe(false);
    expect(a.targetBlocked(0)).toBeTruthy();
    expect(a.targetBlocked(3 as PlayerIndex)).toBeTruthy();
    expect(a.targetBlocked(2)).toBeNull();
  });

  it('un sort privé n’est détaillé qu’au lanceur et à la cible ; le troisième voit un sort masqué', async () => {
    const { sessions: [a, b, c], hub } = await game(3);
    const seenByC: string[] = [];
    const orig = hub.deliver.bind(hub);
    hub.deliver = (from, to, json) => {
      if (to === 2 || to === 'all') seenByC.push(json);
      orig(from, to, json);
    };
    a.state.spells.push('radar');
    expect(a.cast('radar', { axis: 'row', index: 4 }, undefined, 1)).toBe(true);
    await flush();
    expect(a.state.log[0].action).toMatchObject({ kind: 'spell', spell: 'radar', axis: 'row', index: 4 });
    expect(b.state.log[0].action).toMatchObject({ kind: 'spell', spell: 'radar' });
    expect(c.state.log[0]).toMatchObject({ n: 0, by: 0, target: 1, action: { kind: 'spell', spell: 'hidden' }, result: { kind: 'spell', spell: 'hidden' } });
    expect(seenByC.join('\n')).not.toContain('radar');
    // la rotation continue normalement et le journal reste aligné
    expect(b.isMyTurn).toBe(true);
    expect(c.state.log.length).toBe(1);
    // même après une resynchronisation, le tiers ne reçoit que la version masquée
    expect(a.publicLogFor(2)[0].action).toEqual({ kind: 'spell', spell: 'hidden' });
    expect(b.publicLogFor(2)[0].action).toEqual({ kind: 'spell', spell: 'hidden' });
    expect(a.publicLogFor(1)[0].action).toMatchObject({ spell: 'radar' });
  });

  it('un sort secret ne dit rien à personne ; un sort public sur sa grille (Tempête) est vu de tous et remet les carnets à zéro', async () => {
    const { sessions: [a, b, c] } = await game(3);
    a.state.spells.push('fog');
    expect(a.cast('fog')).toBe(true);
    await flush();
    expect(b.state.log[0].action).toEqual({ kind: 'spell', spell: 'self' });
    expect(c.state.log[0].action).toEqual({ kind: 'spell', spell: 'self' });
    expect(b.isMyTurn).toBe(true);
    a.setNotes(1, { marks: { '0,0': 'x' }, guesses: [] });
    c.setNotes(1, { marks: { '1,1': '?' }, guesses: [] });
    a.setNotes(2, { marks: { '2,2': 'x' }, guesses: [] });
    b.state.spells.push('shuffle');
    expect(b.cast('shuffle')).toBe(true);
    await flush();
    expect(a.state.log[1].action).toEqual({ kind: 'spell', spell: 'shuffle' });
    expect(c.state.log[1].action).toEqual({ kind: 'spell', spell: 'shuffle' });
    expect(a.notesFor(1).marks).toEqual({});
    expect(c.notesFor(1).marks).toEqual({});
    expect(a.notesFor(2).marks).toEqual({ '2,2': 'x' }); // le carnet sur Cy n'est pas touché
    expect(c.isMyTurn).toBe(true);
  });

  it('Renfort à trois : la pièce ajoutée apparaît chez tous les adversaires, sur la bonne grille', async () => {
    const { sessions: [a, b, c] } = await game(3);
    const pick = cat.pieces[0];
    a.state.spells.push('addpiece');
    let spot: { r: number; c: number } | null = null;
    for (let r = 0; r < 10 && !spot; r++) for (let col = 0; col < 10 && !spot; col++) if (validateSpot(a, 'x0.' + pick.shape + '.' + pick.color, pick.shape, pick.color, r, col)) spot = { r, c: col };
    expect(a.cast('addpiece', { shape: pick.shape, color: pick.color }, { ...spot!, rot: 0 })).toBe(true);
    await flush();
    expect(b.piecesOf(0).length).toBe(cat.pieces.length + 1);
    expect(c.piecesOf(0).length).toBe(cat.pieces.length + 1);
    expect(c.piecesOf(1).length).toBe(cat.pieces.length);
    expect(b.state.log[0].result).toEqual(a.state.log[0].result);
  });
});

function validateSpot(s: PlayerSession, id: string, shape: string, color: string, r: number, c: number): boolean {
  const base = s.catalog!;
  const catX = { ...base, pieces: [...base.pieces, { id, shape, color }] };
  return validatePlacement([...s.alivePlacement(), { pieceId: id, r, c, rot: 0 }], catX).length === 0;
}

describe('multijoueur : éliminations et fin de partie', () => {
  it('à trois : un joueur dont toutes les pièces sont coulées est éliminé, garde la vue, ne joue plus et n’est plus ciblable ; le dernier gagne', async () => {
    const { sessions: [a, b, c], evs } = await game(3);
    // Ana coule toutes les pièces de Cy ; Bo et Cy tirent dans le vide entre-temps.
    for (let i = 0; i < 12; i++) {
      expect(claimOne(a, c)).toBe(true);
      await flush();
      if (i < 11) {
        expect(b.shoot({ side: 'top', index: i % 10 }, 2)).toBe(true);
        await flush();
        expect(c.shoot({ side: 'top', index: i % 10 }, 0)).toBe(true);
        await flush();
      }
    }
    const lastClaim = a.state.log[a.state.log.length - 1];
    expect(lastClaim.result).toEqual({ kind: 'claim', ok: true, eliminated: true });
    for (const s of [a, b, c]) {
      expect(s.isAlive(2)).toBe(false);
      expect(s.alivePlayers).toEqual([0, 1]);
      expect(s.phase).toBe('playing');
    }
    expect(evs[1].some((e) => e.type === 'eliminated' && e.player === 2)).toBe(true);
    expect(c.amEliminated).toBe(true);
    // la rotation saute Cy : Bo joue, puis Ana
    expect(b.isMyTurn).toBe(true);
    expect(b.targetBlocked(2)).toMatch(/éliminé/);
    expect(b.shoot({ side: 'left', index: 0 }, 2)).toBe(false);
    expect(b.shoot({ side: 'left', index: 0 }, 0)).toBe(true);
    await flush();
    expect(a.isMyTurn).toBe(true);
    expect(c.isMyTurn).toBe(false);
    // Ana élimine Bo : victoire
    for (let i = 0; i < 12; i++) {
      expect(claimOne(a, b)).toBe(true);
      await flush();
      if (i < 11) {
        expect(b.shoot({ side: 'bottom', index: i % 10 }, 0)).toBe(true);
        await flush();
      }
    }
    for (const s of [a, b, c]) {
      expect(s.winner).toBe(0);
      expect(s.phase).toBe('over');
      expect(s.ranking).toEqual([0, 1, 2]);
    }
    expect(c.state.log.length).toBe(a.state.log.length);
  });

  it('à quatre : partie complète jusqu’à un vainqueur, journaux alignés partout', async () => {
    const { sessions } = await game(4, { first: 2 });
    expect(sessions[2].isMyTurn).toBe(true);
    let guard = 0;
    while (sessions[0].winner === null && guard++ < 400) {
      const cur = sessions.find((s) => s.isMyTurn)!;
      const alive = cur.aliveOpponents;
      const target = sessions[alive[(guard * 7) % alive.length]];
      if (guard % 3 === 0) expect(cur.shoot({ side: 'top', index: guard % 10 }, target.state.me)).toBe(true);
      else expect(claimOne(cur, target)).toBe(true);
      await flush(8);
    }
    const w = sessions[0].winner!;
    expect(w).not.toBeNull();
    for (const s of sessions) {
      expect(s.winner).toBe(w);
      expect(s.phase).toBe('over');
      expect(kinds(s)).toEqual(kinds(sessions[0]));
      expect(s.ranking[0]).toBe(w);
      expect(new Set(s.ranking).size).toBe(4);
    }
  });
});

describe('multijoueur : sorts d’ordre des tours', () => {
  type Loose = { by?: PlayerIndex; target?: PlayerIndex; action?: Record<string, unknown>; result?: Record<string, unknown> };
  const log = (entries: Loose[]) =>
    entries.map((e, i) => ({ n: i, by: e.by ?? 0, target: e.target ?? e.by ?? 0, action: e.action ?? { kind: 'shot' }, result: e.result ?? { kind: 'shot' } })) as unknown as TurnEntry[];
  const spell = (by: PlayerIndex, spell: string, extra: Record<string, unknown> = {}, target: PlayerIndex = by): Loose => ({ by, target, action: { kind: 'spell', spell, ...extra }, result: { kind: 'spell', spell } });

  it('moteur : Saut, Double saut, Inversion, Relais, Gel et éliminations (3 et 4 joueurs)', () => {
    expect(attackerAt(0, log([spell(0, 'skip')]), 1, undefined, 3)).toBe(2);
    expect(attackerAt(0, log([spell(0, 'doubleskip')]), 1, undefined, 3)).toBe(0);
    expect(attackerAt(0, log([spell(0, 'doubleskip')]), 1, undefined, 4)).toBe(3);
    expect(attackerAt(0, log([spell(0, 'reverse')]), 1, undefined, 3)).toBe(2);
    expect(attackerAt(0, log([spell(0, 'reverse'), { by: 2 }]), 2, undefined, 3)).toBe(1);
    expect(attackerAt(0, log([spell(0, 'relay', { who: 2 })]), 1, undefined, 4)).toBe(2);
    expect(attackerAt(0, log([spell(0, 'relay', { who: 2 }), { by: 2, target: 0 }]), 2, undefined, 4)).toBe(3);
    // Gel à trois : le lanceur rejoue, la cible saute son tour
    const freeze = log([spell(0, 'freeze', {}, 2), { by: 0, target: 1 }, { by: 1, target: 0 }]);
    expect(attackerAt(0, freeze, 1, undefined, 3)).toBe(0);
    expect(attackerAt(0, freeze, 2, undefined, 3)).toBe(1);
    expect(attackerAt(0, freeze, 3, undefined, 3)).toBe(0);
    // Gel à deux : deux tours de suite (comme avant)
    const freeze2 = log([spell(0, 'freeze', {}, 1), { by: 0, target: 1 }, { by: 0, target: 1 }]);
    expect([1, 2, 3].map((n) => attackerAt(0, freeze2, n, undefined, 2))).toEqual([0, 0, 1]);
    // Élimination : le joueur 1 sort de la rotation
    const elim = log([{ by: 0, target: 1, action: { kind: 'claim' }, result: { kind: 'claim', ok: true, eliminated: true } }, { by: 2, target: 0 }]);
    expect(attackerAt(0, elim, 1, undefined, 3)).toBe(2);
    expect(attackerAt(0, elim, 2, undefined, 3)).toBe(0);
    // Saut quand il ne reste que deux joueurs : le lanceur rejoue
    const skip2 = log([{ by: 0, target: 1, action: { kind: 'claim' }, result: { kind: 'claim', ok: true, eliminated: true } }, spell(2, 'skip')]);
    expect(attackerAt(0, skip2, 2, undefined, 3)).toBe(2);
    // Diversion : le suivant doit viser le désigné (sauf si c'est lui-même ou s'il est éliminé)
    expect(forcedTargetAt(0, log([spell(0, 'divert', { who: 2 })]), 1, 3)).toBe(2);
    expect(forcedTargetAt(0, log([spell(0, 'divert', { who: 1 })]), 1, 3)).toBeNull();
    expect(forcedTargetAt(0, log([spell(0, 'divert', { who: 2 }), { by: 1, target: 2 }]), 2, 3)).toBeNull();
  });

  it('Saut, Double saut, Inversion, Relais : effets en partie réelle à trois', async () => {
    const { sessions: [a, b, c] } = await game(3);
    a.state.spells.push('skip', 'doubleskip', 'reverse', 'relay');
    expect(a.cast('skip')).toBe(true);
    await flush();
    expect(c.isMyTurn).toBe(true); // Bo a sauté
    expect(b.state.log[0].action).toEqual({ kind: 'spell', spell: 'skip' }); // visible de tous
    c.shoot({ side: 'top', index: 0 }, 0);
    await flush();
    expect(a.isMyTurn).toBe(true);
    expect(a.cast('doubleskip')).toBe(true);
    await flush();
    expect(a.isMyTurn).toBe(true); // Bo et Cy ont sauté
    expect(a.cast('reverse')).toBe(true);
    await flush();
    expect(c.isMyTurn).toBe(true);
    c.shoot({ side: 'top', index: 1 }, 1);
    await flush();
    expect(b.isMyTurn).toBe(true);
    b.shoot({ side: 'top', index: 1 }, 0);
    await flush();
    expect(a.isMyTurn).toBe(true);
    expect(a.cast('relay', { who: 1 })).toBe(true);
    await flush();
    expect(b.isMyTurn).toBe(true); // Bo joue juste après Ana malgré le sens inversé
    expect(a.cast('relay', { who: 0 })).toBe(false); // pas soi-même
  });

  it('Gel à trois : le lanceur rejoue, la cible saute son tour', async () => {
    const { sessions: [a, b, c] } = await game(3);
    a.state.spells.push('freeze');
    expect(a.cast('freeze', {}, undefined, 2)).toBe(true);
    await flush();
    expect(a.isMyTurn).toBe(true);
    a.shoot({ side: 'top', index: 0 }, 1);
    await flush();
    expect(b.isMyTurn).toBe(true);
    b.shoot({ side: 'top', index: 0 }, 0);
    await flush();
    expect(c.isMyTurn).toBe(false);
    expect(a.isMyTurn).toBe(true);
    expect(c.state.log.length).toBe(3);
  });

  it('Diversion : le joueur suivant doit viser le joueur désigné', async () => {
    const { sessions: [a, b, c] } = await game(3);
    a.state.spells.push('divert');
    expect(a.cast('divert', { who: 2 })).toBe(true);
    await flush();
    expect(b.isMyTurn).toBe(true);
    expect(b.forcedTarget).toBe(2);
    expect(b.targetBlocked(0)).toMatch(/Diversion/);
    expect(b.shoot({ side: 'top', index: 0 }, 0)).toBe(false);
    // un tiers qui recevrait un tour violant la Diversion le refuse
    const errs = events(c);
    c.receive(JSON.stringify({ t: 'turn', turn: { n: 1, by: 1, target: 0, action: { kind: 'shot', edge: { side: 'top', index: 0 } }, result: { kind: 'shot', exit: { side: 'top', index: 0 }, colors: [] } } }), 0);
    expect(c.state.log.length).toBe(1);
    expect(errs.some((e) => e.type === 'error' && /Diversion/.test(e.message))).toBe(true);
    expect(b.shoot({ side: 'top', index: 0 }, 2)).toBe(true);
    await flush();
    expect(c.isMyTurn).toBe(true);
    expect(c.forcedTarget).toBeNull();
    expect(c.state.log.length).toBe(2);
  });

  it('Silence général : tous les adversaires sont réduits au silence pour leur prochain tour', async () => {
    const { sessions: [a, b, c] } = await game(3);
    b.state.spells.push('fog');
    c.state.spells.push('fog');
    a.state.spells.push('silenceall');
    expect(a.cast('silenceall')).toBe(true);
    await flush();
    expect(b.state.silenced).toBe(true);
    expect(c.state.silenced).toBe(true);
    expect(a.state.silenced).toBe(false);
    expect(b.spellBlocked('fog')).toMatch(/silence/);
    b.shoot({ side: 'top', index: 0 }, 0);
    await flush();
    expect(b.state.silenced).toBe(false);
    expect(c.spellBlocked('fog')).toMatch(/silence/);
  });

  it('les sorts multi n’existent pas dans une partie à deux : pas dans le tirage, refusés à la réception', async () => {
    const { sessions: [a, b] } = await game(2);
    expect(a.spellPool).not.toContain('skip');
    expect(a.spellPool).toContain('radar');
    a.state.spells.push('skip');
    expect(a.spellBlocked('skip')).toMatch(/au moins 3/);
    expect(a.cast('skip')).toBe(false);
    const errs = events(b);
    b.receive(JSON.stringify({ t: 'turn', turn: { n: 0, by: 0, target: 0, action: { kind: 'spell', spell: 'skip' }, result: { kind: 'spell', spell: 'skip' } } }), 0);
    expect(b.state.log.length).toBe(0);
    expect(errs.some((e) => e.type === 'error')).toBe(true);
    const { sessions: [h3] } = await game(3);
    expect(h3.spellPool).toContain('skip');
  });

  it('Espion, Vol et Sabotage visent la réserve du joueur choisi', async () => {
    const { sessions: [a, b, c] } = await game(3);
    c.state.spells.push('fog');
    a.state.spells.push('steal', 'spy');
    expect(a.cast('spy', {}, undefined, 2)).toBe(true);
    await flush();
    const r = a.state.log[0].result;
    expect(r.kind === 'spell' && r.count).toBe(1);
    expect(b.state.log[0].action).toEqual({ kind: 'spell', spell: 'hidden' });
    b.shoot({ side: 'top', index: 0 }, 0);
    await flush();
    c.shoot({ side: 'top', index: 0 }, 0);
    await flush();
    expect(a.cast('steal', {}, undefined, 2)).toBe(true);
    await flush();
    expect(c.state.spells).toEqual([]);
    expect(a.state.spells).toContain('fog');
    expect(b.state.spells).toEqual([]);
  });
});

describe('multijoueur : coupures et reprise d’un journal partiel', () => {
  it('un joueur déconnecté rattrape les tours manqués, avec les sorts privés masqués, sans rien accepter aveuglément', async () => {
    const { sessions: [a, b, c], hub } = await game(3);
    hub.setConnected(2, false);
    a.shoot({ side: 'top', index: 3 }, 1);
    await flush();
    b.state.spells.push('radar');
    expect(b.cast('radar', { axis: 'col', index: 2 }, undefined, 0)).toBe(true);
    await flush();
    expect(a.state.log.length).toBe(2);
    expect(c.state.log.length).toBe(0);
    expect(c.isMyTurn).toBe(false); // pas à jour : il attend
    hub.setConnected(2, true);
    await flush();
    expect(c.state.log.length).toBe(2);
    expect(c.state.log[0].action.kind).toBe('shot');
    expect(c.state.log[0].result).toEqual(a.state.log[0].result);
    expect(c.state.log[1].action).toEqual({ kind: 'spell', spell: 'hidden' });
    expect(c.isMyTurn).toBe(true);
    // un journal reçu d'un tiers avec un mauvais joueur est refusé
    const errs = events(c);
    c.receive(JSON.stringify({ t: 'turn', turn: { n: 2, by: 1, target: 0, action: { kind: 'shot', edge: { side: 'top', index: 0 } }, result: { kind: 'shot', exit: { side: 'top', index: 0 }, colors: [] } } }), 1);
    expect(c.state.log.length).toBe(2);
    expect(errs.some((e) => e.type === 'error' && /mauvais joueur/.test(e.message))).toBe(true);
  });

  it('une action vers un joueur hors ligne attend son retour ; le résultat arrive alors à tout le monde', async () => {
    const { sessions: [a, b, c], hub } = await game(3);
    hub.setConnected(2, false);
    expect(a.shoot({ side: 'left', index: 5 }, 2)).toBe(true);
    await flush();
    expect(a.state.pending).not.toBeNull();
    expect(b.state.log.length).toBe(0);
    hub.setConnected(2, true);
    await flush();
    expect(a.state.pending).toBeNull();
    expect(a.state.log.length).toBe(1);
    expect(b.state.log.length).toBe(1);
    expect(c.state.log[0].secret).toBeDefined();
    expect(b.state.log[0].result).toEqual(c.state.log[0].result);
    expect(b.isMyTurn).toBe(true);
  });

  it('un tour masqué qui ME concerne n’est jamais accepté tel quel : j’attends la version complète', async () => {
    const { sessions: [a, b, c], hub } = await game(3);
    hub.setConnected(2, false);
    hub.setConnected(1, false);
    a.state.spells.push('radar');
    expect(a.cast('radar', { axis: 'row', index: 0 }, undefined, 2)).toBe(true);
    await flush();
    expect(a.state.pending).not.toBeNull();
    // Bo revient : il ne voit qu'un sort masqué ; il n'avance pas le journal sans Cy
    hub.setConnected(1, true);
    await flush();
    expect(b.state.log.length).toBe(0);
    // Cy revient : il recalcule le sort sur sa grille, et tout le monde se retrouve aligné
    hub.setConnected(2, true);
    await flush();
    expect(a.state.pending).toBeNull();
    expect(c.state.log.length).toBe(1);
    expect(b.state.log.length).toBe(1);
    expect(b.state.log[0].action).toEqual({ kind: 'spell', spell: 'hidden' });
    expect(c.state.log[0].action).toMatchObject({ spell: 'radar' });
    void c;
  });

  it('élimination simultanée impossible, mais un journal falsifié sur une cible éliminée est refusé', async () => {
    const { sessions: [a, b, c] } = await game(3);
    for (let i = 0; i < 12; i++) {
      claimOne(a, c);
      await flush();
      if (i < 11) {
        b.shoot({ side: 'top', index: 0 }, 0);
        await flush();
        c.shoot({ side: 'top', index: 0 }, 0);
        await flush();
      }
    }
    expect(b.isAlive(2)).toBe(false);
    const errs = events(a);
    const n = a.state.log.length;
    a.receive(JSON.stringify({ t: 'turn', turn: { n, by: 1, target: 2, action: { kind: 'shot', edge: { side: 'top', index: 0 } }, result: { kind: 'shot', exit: { side: 'top', index: 0 }, colors: [] } } }), 1);
    expect(a.state.log.length).toBe(n);
    expect(errs.some((e) => e.type === 'error' && /cible éliminée/.test(e.message))).toBe(true);
  });
});

describe('multijoueur : provenance des tours (seul celui qui a calculé un tour fait foi)', () => {
  const shot = { kind: 'shot', edge: { side: 'top', index: 0 } };
  const shotResult = { kind: 'shot', exit: { side: 'top', index: 0 }, colors: [] };

  it('un tiers ne peut pas faire accepter un tour entre deux autres joueurs à leur place', async () => {
    const { sessions: [a, b, c] } = await game(3);
    // Cy forge « Ana a éliminé Bo » et l'envoie à Ana… et à Bo : personne ne l'accepte
    const forged = { n: 0, by: 0, target: 1, action: { kind: 'claim', claim: { color: 'rouge', shape: 'carre', cells: [{ r: 0, c: 0 }] } }, result: { kind: 'claim', ok: true, eliminated: true } };
    a.receive(JSON.stringify({ t: 'turn', turn: forged }), 2);
    b.receive(JSON.stringify({ t: 'turn', turn: forged }), 2);
    await flush();
    expect(a.state.log.length).toBe(0);
    expect(b.state.log.length).toBe(0);
    expect(b.isAlive(1)).toBe(true);
    // Ana forge un résultat sur la grille de Bo et l'envoie à Cy : refusé aussi (seul Bo fait foi)
    c.receive(JSON.stringify({ t: 'turn', turn: { n: 0, by: 0, target: 1, action: shot, result: shotResult } }), 0);
    await flush();
    expect(c.state.log.length).toBe(0);
    // le vrai coup suit son cours normalement
    expect(a.shoot({ side: 'left', index: 2 }, 1)).toBe(true);
    await flush();
    expect(c.state.log.length).toBe(1);
    expect(c.state.log[0].result).toEqual(b.state.log[0].result);
  });

  it('le résultat de MON coup n’est accepté que de ma cible', async () => {
    const { sessions: [a, b, c], hub } = await game(3);
    hub.setConnected(1, false);
    expect(a.shoot({ side: 'top', index: 3 }, 1)).toBe(true);
    await flush();
    expect(a.state.pending).not.toBeNull();
    // Cy prétend connaître le résultat : ignoré
    a.receive(JSON.stringify({ t: 'turn', turn: { n: 0, by: 0, target: 1, action: { kind: 'shot', edge: { side: 'top', index: 3 } }, result: shotResult } }), 2);
    await flush();
    expect(a.state.pending).not.toBeNull();
    expect(a.state.log.length).toBe(0);
    // Bo revient : le vrai résultat arrive
    hub.setConnected(1, true);
    await flush();
    expect(a.state.pending).toBeNull();
    expect(a.state.log[0].result).toEqual(b.state.log[0].result);
    expect(c.state.log.length).toBe(1);
  });

  it('le détail d’un sort privé en attente ne part pas chez un tiers dans la resynchronisation', async () => {
    const { sessions: [a, b, c], hub } = await game(3);
    const seenByC: string[] = [];
    const orig = hub.deliver.bind(hub);
    hub.deliver = (from, to, json) => {
      if (to === 2 || to === 'all') seenByC.push(json);
      orig(from, to, json);
    };
    hub.setConnected(1, false);
    hub.setConnected(2, false);
    a.state.spells.push('colorscan');
    expect(a.cast('colorscan', { color: 'rouge' }, undefined, 1)).toBe(true);
    await flush();
    hub.setConnected(2, true);
    await flush();
    expect(seenByC.join('\n')).not.toContain('"spell":"colorscan"');
    const syncs = seenByC.map((j) => JSON.parse(j) as { t: string; pending?: unknown }).filter((m) => m.t === 'sync');
    expect(syncs.length).toBeGreaterThan(0);
    for (const m of syncs) expect(m.pending).toBeNull();
    hub.setConnected(1, true);
    await flush();
    expect(a.state.pending).toBeNull();
    expect(c.state.log[0].action).toEqual({ kind: 'spell', spell: 'hidden' });
    expect(b.state.log[0].action).toMatchObject({ spell: 'colorscan' });
  });

  it('rattrapage d’un long journal par morceaux : chaque tour vient de celui qui l’a calculé', async () => {
    const { sessions: [a, b, c], hub } = await game(3);
    hub.setConnected(2, false);
    // Ana tire sur Bo, Bo fait sauter le tour de Cy (hors ligne) avec Saut : 8 tours sans Cy
    b.state.spells.push('skip', 'skip', 'skip', 'skip');
    for (let i = 0; i < 4; i++) {
      expect(a.shoot({ side: 'top', index: i }, 1)).toBe(true);
      await flush();
      expect(b.cast('skip')).toBe(true);
      await flush();
    }
    expect(a.state.log.length).toBe(8);
    expect(c.state.log.length).toBe(0);
    hub.setConnected(2, true);
    await flush(80);
    expect(c.state.log.length).toBe(8);
    expect(kinds(c)).toEqual(kinds(a));
    for (let n = 0; n < 8; n++) expect(c.state.log[n].result).toEqual(a.state.log[n].result);
    expect(a.isMyTurn).toBe(true); // Cy a encore sauté son tour (dernier Saut)
    expect(c.isMyTurn).toBe(false);
  });
});

// ---------- hub en étoile (hôte relais) sur des liens bruts simulés ----------

class FakeLink implements RawLink {
  peer: FakeLink | null = null;
  connected = false;
  onMessage: ((text: string) => void) | null = null;
  onStatus: ((connected: boolean) => void) | null = null;
  sendRaw(text: string): boolean {
    const p = this.peer;
    if (!this.connected || !p) return false;
    setTimeout(() => p.connected && p.onMessage?.(text), 0);
    return true;
  }
  close(): void {
    if (!this.connected) return;
    this.connected = false;
    this.onStatus?.(false);
    const p = this.peer;
    if (p?.connected) {
      p.connected = false;
      p.onStatus?.(false);
    }
  }
  static pair(): [FakeLink, FakeLink] {
    const a = new FakeLink();
    const b = new FakeLink();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }
  open(): void {
    this.connected = true;
    this.peer!.connected = true;
    this.onStatus?.(true);
    this.peer!.onStatus?.(true);
  }
}

/** Reconnecte un invité au hub de l'hôte avec un nouveau lien ; retourne la raison d'un refus éventuel. */
async function reconnectGuest(hub: HubHost, g: PlayerSession): Promise<string> {
  const [lh, lg] = FakeLink.pair();
  hub.addLink(lh);
  let reason = '';
  const gh = new HubGuest(lg, g.hello);
  gh.onWelcome = (you, token) => {
    g.setIndex(you);
    g.setToken(token);
  };
  gh.onReject = (r) => (reason = r);
  g.attach(gh);
  lg.open();
  await flush(60);
  return reason;
}

async function starGame(n: number) {
  const host = new PlayerSession(freshState('online', 0, 'Hôte', newGameId(), CLASSIC_SET, cfg), null, '', seededRandom(3));
  const hub = new HubHost((hello) => host.admit(hello));
  host.attach(hub);
  const guests: PlayerSession[] = [];
  const guestHubs: HubGuest[] = [];
  const hostLinks: FakeLink[] = [];
  for (let i = 1; i < n; i++) {
    const g = new PlayerSession(freshState('online', 1, `Invité ${i}`, '', null), null, '', seededRandom(50 + i));
    const [lh, lg] = FakeLink.pair();
    hub.addLink(lh);
    const gh = new HubGuest(lg, g.hello);
    gh.onWelcome = (you, token) => {
      g.setIndex(you);
      g.setToken(token);
    };
    g.attach(gh);
    lg.open();
    await flush();
    guests.push(g);
    guestHubs.push(gh);
    hostLinks.push(lh);
  }
  return { host, hub, guests, guestHubs, hostLinks };
}

describe('hub en étoile : l’hôte accueille, attribue les places et relaie', () => {
  it('trois invités reçoivent leur place, les messages entre invités passent par l’hôte avec le bon expéditeur', async () => {
    const { host, guests, hub } = await starGame(4);
    expect(guests.map((g) => g.state.me)).toEqual([1, 2, 3]);
    expect(host.state.players.map((p) => p.name)).toEqual(['Hôte', 'Invité 1', 'Invité 2', 'Invité 3']);
    expect(guests[2].state.players.map((p) => p.name)).toEqual(['Hôte', 'Invité 1', 'Invité 2', 'Invité 3']);
    expect(host.isOnline(2)).toBe(true);
    expect(guests[0].isOnline(3)).toBe(true);
    // un cinquième téléphone est refusé
    expect(host.admit({ me: null, gameId: '', name: 'Trop' })).toEqual({ ok: false, reason: expect.stringContaining('complète') });
    // la partie se joue : un invité tire sur un autre, l'hôte relaie, tout le monde voit
    host.launch();
    await flush();
    for (const g of guests) g.acceptProposedSet();
    await flush();
    const all = [host, ...guests];
    all.forEach((s, i) => {
      s.setPlacement(randomPlacement(cat, { random: seededRandom(20 + i) }));
      s.markReady();
    });
    await flush();
    for (const s of all) expect(s.phase).toBe('playing');
    const first = host.state.firstPlayer!;
    const cur = all[first];
    const target = cur.aliveOpponents.find((t) => t !== 0) ?? cur.aliveOpponents[0];
    expect(cur.shoot({ side: 'top', index: 4 }, target)).toBe(true);
    await flush();
    for (const s of all) {
      expect(s.state.log.length).toBe(1);
      expect(s.state.log[0]).toMatchObject({ by: first, target });
    }
    expect(all[target].state.log[0].secret).toBeDefined();
    // l'expéditeur est fixé par le hub : un invité ne peut pas se faire passer pour un autre
    const errsHost = events(host);
    const before = host.state.players[2].name;
    guests[0]['transport']!.send({ t: 'sync', v: PROTOCOL_VERSION, fp: appFingerprint(), gameId: host.state.gameId, me: 2, name: 'Usurpé', ready: true, firstPlayer: null, log: [], pending: null, set: null, setHash: null }, 0);
    await flush();
    expect(host.state.players[2].name).toBe(before);
    expect(errsHost.filter((e) => e.type === 'error')).toEqual([]);
    expect(hub.peerConnected(3)).toBe(true);
  });

  it('coupure et retour d’un invité : réadmis à sa place, les autres sont prévenus ; un inconnu est refusé après le lancement', async () => {
    const { host, hub, guests, hostLinks } = await starGame(3);
    host.launch();
    await flush();
    expect(guests[1].state.launched).toBe(true);
    hostLinks[1].close();
    await flush();
    expect(host.isOnline(2)).toBe(false);
    expect(guests[0].isOnline(2)).toBe(false);
    // retour
    const [lh, lg] = FakeLink.pair();
    hub.addLink(lh);
    const gh = new HubGuest(lg, guests[1].hello);
    gh.onWelcome = (you, token) => {
      guests[1].setIndex(you);
      guests[1].setToken(token);
    };
    guests[1].attach(gh);
    lg.open();
    await flush();
    expect(guests[1].state.me).toBe(2);
    expect(host.isOnline(2)).toBe(true);
    expect(guests[0].isOnline(2)).toBe(true);
    // un inconnu qui prétend être le joueur 2 sans son jeton est refusé
    const fake = new PlayerSession(freshState('online', 2, 'Eve', host.state.gameId, null));
    const [lh3, lg3] = FakeLink.pair();
    hub.addLink(lh3);
    let fakeReason = '';
    const fh = new HubGuest(lg3, { me: 2, gameId: host.state.gameId, name: 'Eve', token: 'mauvais' });
    fh.onReject = (r) => (fakeReason = r);
    fake.attach(fh);
    lg3.open();
    await flush();
    expect(fakeReason).toMatch(/jeton/);
    expect(host.isOnline(2)).toBe(true); // le vrai joueur 2 n'a pas été débranché
    // un nouveau venu après le lancement
    const stranger = new PlayerSession(freshState('online', 1, 'Eve', '', null));
    const [lh2, lg2] = FakeLink.pair();
    hub.addLink(lh2);
    let reason = '';
    const sh = new HubGuest(lg2, stranger.hello);
    sh.onReject = (r) => (reason = r);
    stranger.attach(sh);
    lg2.open();
    await flush();
    expect(reason).toMatch(/déjà lancée/);
    expect(sh.connected).toBe(false);
  });

  it('salon : retirer un invité déconnecté fait avancer les suivants d’une place', async () => {
    const { host, hub, guests, hostLinks } = await starGame(4);
    hostLinks[0].close();
    await flush();
    expect(host.isOnline(1)).toBe(false);
    expect(host.launch()).toBe(false); // un joueur hors ligne : impossible de lancer
    host.removeSlot(1);
    await flush();
    expect(host.state.players.map((p) => p.name)).toEqual(['Hôte', 'Invité 2', 'Invité 3']);
    expect(guests[1].state.me).toBe(1);
    expect(guests[2].state.me).toBe(2);
    expect(hub.peerConnected(1)).toBe(true);
    expect(hub.peerConnected(3)).toBe(false);
    expect(guests[2].state.players.map((p) => p.name)).toEqual(['Hôte', 'Invité 2', 'Invité 3']);
    expect(host.launch()).toBe(true);
    await flush();
    expect(guests[1].phase).toBe('review');
  });
});

describe('corrections de relecture : jetons, revanche, règles à peu de joueurs', () => {
  afterEach(() => {
    PlayerSession.syncChunkBytes = 16_000;
    vi.useRealTimers();
  });

  it('B1 : après une revanche, un invité (à 2 comme à 4) se reconnecte encore, même s’il a raté le message « nouvelle partie »', async () => {
    for (const n of [2, 4]) {
      const { host, hub, guests, hostLinks } = await starGame(n);
      host.launch();
      await flush();
      const lastIdx = guests.length - 1;
      // le dernier invité est coupé AVANT la revanche : il garde l'ancien identifiant de partie
      hostLinks[lastIdx].close();
      await flush();
      host.startNewGame();
      await flush();
      if (n === 4) expect(guests[0].state.gameId).toBe(host.state.gameId); // invité resté connecté
      expect(host.state.players.every((p, i) => i === 0 || !!p.token)).toBe(true);
      // reconnexion d'un invité qui a reçu la revanche
      if (n === 4) {
        hostLinks[0].close();
        await flush();
        expect(await reconnectGuest(hub, guests[0])).toBe('');
        expect(host.isOnline(1)).toBe(true);
      }
      // reconnexion de l'invité qui l'a ratée : admis grâce au jeton, puis remis à niveau
      expect(guests[lastIdx].state.gameId).not.toBe(host.state.gameId);
      expect(await reconnectGuest(hub, guests[lastIdx])).toBe('');
      await flush(40);
      expect(guests[lastIdx].state.gameId).toBe(host.state.gameId);
      expect(guests[lastIdx].state.launched).toBe(true);
      expect(guests[lastIdx].phase).toBe('review'); // il doit (encore) accepter le jeu de la nouvelle partie
      expect(host.isOnline((n - 1) as PlayerIndex)).toBe(true);
    }
  });

  it('B2 : retrait d’un joueur au salon : le joueur décalé garde un jeton valide et se reconnecte après le lancement', async () => {
    const { host, hub, guests, hostLinks } = await starGame(4);
    hostLinks[0].close();
    await flush();
    host.removeSlot(1);
    await flush();
    const moved = guests[1]; // était 2, devient 1
    expect(moved.state.me).toBe(1);
    expect(moved.state.players[1].token).toBe(host.state.players[1].token);
    expect(moved.state.players[2]?.token).toBeUndefined();
    expect(host.launch()).toBe(true);
    await flush();
    // coupure puis reconnexion à sa nouvelle place
    hostLinks[1].close();
    await flush();
    expect(host.isOnline(1)).toBe(false);
    expect(await reconnectGuest(hub, moved)).toBe('');
    expect(moved.state.me).toBe(1);
    expect(host.isOnline(1)).toBe(true);
  });

  it('I5 : la suite du journal est envoyée par paquets de taille bornée, dans l’ordre', async () => {
    PlayerSession.syncChunkBytes = 600; // ~3 tours par paquet
    const { sessions: [a, b, c], hub } = await game(3);
    hub.setConnected(2, false);
    b.state.spells.push('skip', 'skip', 'skip', 'skip', 'skip');
    for (let i = 0; i < 5; i++) {
      expect(a.shoot({ side: 'top', index: i }, 1)).toBe(true);
      await flush();
      expect(b.cast('skip')).toBe(true);
      await flush();
    }
    const syncsToC: { log: { n: number }[]; logLen: number }[] = [];
    const orig = hub.deliver.bind(hub);
    hub.deliver = (from, to, json) => {
      const m = JSON.parse(json) as { t: string; log: { n: number }[]; logLen: number };
      if (to === 2 && m.t === 'sync' && m.log.length) syncsToC.push(m);
      orig(from, to, json);
    };
    hub.setConnected(2, true);
    await flush(80);
    expect(c.state.log.length).toBe(10);
    expect(syncsToC.length).toBeGreaterThan(2);
    for (const m of syncsToC) expect(JSON.stringify(m.log).length).toBeLessThan(900);
    expect(kinds(c)).toEqual(kinds(a));
  });

  it('mineur : Double saut, Inversion, Relais et Diversion sont refusés (et conservés) quand il ne reste que 2 joueurs en jeu ; Saut reste permis', async () => {
    const { sessions: [a, b, c] } = await game(3);
    for (let i = 0; i < 12; i++) {
      claimOne(a, c);
      await flush();
      if (i < 11) {
        b.shoot({ side: 'top', index: 0 }, 0);
        await flush();
        c.shoot({ side: 'top', index: 0 }, 0);
        await flush();
      }
    }
    expect(a.alivePlayers).toEqual([0, 1]);
    b.state.spells.push('doubleskip', 'reverse', 'relay', 'divert', 'skip');
    expect(b.isMyTurn).toBe(true);
    for (const id of ['doubleskip', 'reverse', 'relay', 'divert']) {
      expect(b.spellBlocked(id)).toMatch(/en jeu/);
      expect(b.cast(id, { who: 0 })).toBe(false);
      expect(b.state.spells).toContain(id);
    }
    expect(b.whoChoices('relay')).toEqual([]);
    // un tiers refuse aussi un tel tour venu d'une app modifiée
    const errs = events(a);
    a.receive(JSON.stringify({ t: 'turn', turn: { n: a.state.log.length, by: 1, target: 1, action: { kind: 'spell', spell: 'reverse' }, result: { kind: 'spell', spell: 'reverse' } } }), 1);
    expect(errs.some((e) => e.type === 'error' && /peu de joueurs/.test(e.message))).toBe(true);
    expect(b.cast('skip')).toBe(true);
    await flush();
    expect(b.isMyTurn).toBe(true); // à deux : le lanceur rejoue
  });

  it('mineur : l’obligation de Diversion survit à un Gel', async () => {
    const { sessions: [a, b, c] } = await game(3);
    a.state.spells.push('divert');
    b.state.spells.push('freeze');
    expect(a.cast('divert', { who: 2 })).toBe(true);
    await flush();
    expect(b.forcedTarget).toBe(2);
    expect(b.cast('freeze', {}, undefined, 0)).toBe(false); // Gel aussi doit viser le joueur désigné
    expect(b.cast('freeze', {}, undefined, 2)).toBe(true); // Gel ne prend pas le tour
    await flush();
    expect(b.isMyTurn).toBe(true);
    expect(b.forcedTarget).toBe(2); // toujours obligé de viser Cy après le rejeu
    expect(b.shoot({ side: 'top', index: 0 }, 0)).toBe(false);
    expect(b.shoot({ side: 'top', index: 0 }, 2)).toBe(true);
    await flush();
    expect(c.isMyTurn).toBe(false); // Cy est gelé : il saute son tour
    expect(a.isMyTurn).toBe(true);
    expect(a.forcedTarget).toBeNull();
  });

  it('mineur : un joueur déjà gelé ne peut pas être gelé une seconde fois (sort conservé, refusé aussi à la réception)', async () => {
    const { sessions: [a, b, c] } = await game(3);
    a.state.spells.push('freeze', 'freeze');
    expect(a.cast('freeze', {}, undefined, 2)).toBe(true);
    await flush();
    expect(a.isFrozen(2)).toBe(true);
    expect(a.targetChoices('freeze')).toEqual([1]);
    expect(a.cast('freeze', {}, undefined, 2)).toBe(false);
    expect(a.state.spells).toEqual(['freeze']);
    const errs = events(b);
    b.receive(JSON.stringify({ t: 'turn', turn: { n: 1, by: 0, target: 2, action: { kind: 'spell', spell: 'freeze' }, result: { kind: 'spell', spell: 'freeze' } } }), 2);
    expect(errs.some((e) => e.type === 'error' && /déjà gelé/.test(e.message))).toBe(true);
    expect(b.state.log.length).toBe(1);
    void c;
  });

  it('mineur : la cible refuse un sort hors de la liste autorisée ou quand les sorts sont désactivés', async () => {
    const { sessions: [a, b] } = await game(3);
    for (const s of [a, b]) s.state.spellCfg.pool = s.state.spellCfg.pool.filter((x) => x !== 'radar');
    const errs = events(b);
    b.receive(JSON.stringify({ t: 'action', n: 0, target: 1, action: { kind: 'spell', spell: 'radar', axis: 'row', index: 0 } }), 0);
    await flush();
    expect(b.state.log.length).toBe(0);
    expect(errs.some((e) => e.type === 'error' && /non autorisé/.test(e.message))).toBe(true);
    for (const s of [a, b]) s.state.spellCfg.enabled = false;
    b.receive(JSON.stringify({ t: 'action', n: 0, target: 1, action: { kind: 'spell', spell: 'sonar', r: 1, c: 1 } }), 0);
    await flush();
    expect(b.state.log.length).toBe(0);
    expect(errs.some((e) => e.type === 'error' && /désactivés/.test(e.message))).toBe(true);
  });

  it('mineur : un lien qui n’envoie pas de hello valide est fermé après le délai ; un refus détache le lien', async () => {
    vi.useFakeTimers();
    const host = new PlayerSession(freshState('online', 0, 'Hôte', newGameId(), CLASSIC_SET, cfg));
    const hub = new HubHost((hello) => host.admit(hello));
    host.attach(hub);
    const [lh, lg] = FakeLink.pair();
    hub.addLink(lh);
    lg.open();
    lg.sendRaw('{"t":"hello","me":"pas un indice","gameId":""}'); // hello invalide : le délai continue
    await vi.advanceTimersByTimeAsync(10);
    expect(lh.connected).toBe(true);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(lh.connected).toBe(false);
    // refus : le lien est fermé peu après et plus écouté
    host.state.launched = true;
    const [lh2, lg2] = FakeLink.pair();
    hub.addLink(lh2);
    lg2.open();
    lg2.sendRaw(JSON.stringify({ t: 'hello', me: null, gameId: '', name: 'Eve' }));
    await vi.advanceTimersByTimeAsync(10);
    expect(lh2.onMessage).toBeNull();
    await vi.advanceTimersByTimeAsync(400);
    expect(lh2.connected).toBe(false);
  });

  it('mineur : « jamais connecté » distingue un invité sans jeton d’un invité accueilli', async () => {
    const fresh = new PlayerSession(freshState('online', 1, 'Bob', '', null));
    expect(fresh.neverConnected).toBe(true);
    const { host, guests } = await starGame(2);
    expect(guests[0].neverConnected).toBe(false);
    expect(host.neverConnected).toBe(false);
    expect(new PlayerSession(freshState('online', 0, 'H', newGameId(), CLASSIC_SET)).neverConnected).toBe(true);
  });
});
