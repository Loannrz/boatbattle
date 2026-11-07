import { describe, expect, it } from 'vitest';
import { CLASSIC_SET } from '../config/pieces';
import { catalogOf, placementParts, randomPlacement, seededRandom, validatePlacement, DEFAULT_SPELL_CONFIG } from '../engine';
import { PlayerSession, freshState, newGameId } from './session';
import { createLocalPair } from './transport';
import { isValidAction, isValidResult, parseMessage } from './protocol';

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const cat = catalogOf(CLASSIC_SET);
const cfg = { ...DEFAULT_SPELL_CONFIG, enabled: true, everyTurns: 1 };

/** Le premier tirage (qui commence) donne l'hôte, les suivants sont variés. */
function hostRandom() {
  const rng = seededRandom(11);
  let first = true;
  return () => (first ? ((first = false), 0.1) : rng());
}

async function game() {
  const host = new PlayerSession(freshState('online', 0, 'A', newGameId(), CLASSIC_SET, cfg), null, '', hostRandom());
  const guest = new PlayerSession(freshState('online', 1, 'B', '', null), null, '', seededRandom(7));
  const [ta, tb] = createLocalPair();
  host.attach(ta);
  guest.attach(tb);
  await flush();
  host.launch();
  await flush();
  guest.acceptProposedSet();
  await flush();
  host.setPlacement(randomPlacement(cat, { random: seededRandom(1) }));
  host.markReady();
  guest.setPlacement(randomPlacement(cat, { random: seededRandom(2) }));
  guest.markReady();
  await flush();
  return { host, guest };
}

describe('sorts', () => {
  it('l’invité reprend les réglages de l’hôte', async () => {
    const { guest } = await game();
    expect(guest.state.spellCfg.enabled).toBe(true);
    expect(guest.state.spellCfg.everyTurns).toBe(1);
  });

  it('un sort ciblé est calculé par le défenseur et remplace le tir', async () => {
    const { host, guest } = await game();
    host.state.spells.push('radar');
    expect(host.cast('radar', { axis: 'row', index: 0 })).toBe(true);
    await flush();
    const e = host.state.log[0];
    expect(e.result.kind === 'spell' && typeof e.result.count).toBe('number');
    expect(guest.state.log[0].action.kind).toBe('spell');
    expect(host.attackerOf(1)).toBe(1);
    // un sort gagné à chaque tour (everyTurns = 1)
    expect(host.state.spells.length).toBe(1);
  });

  it('un sort ne se lance pas sans l’avoir', async () => {
    const { host } = await game();
    expect(host.cast('radar', { axis: 'row', index: 0 })).toBe(false);
  });

  it('Gel : ne prend pas le tour, le lanceur joue deux fois de suite', async () => {
    const { host, guest } = await game();
    host.state.spells.push('freeze');
    host.cast('freeze');
    await flush();
    expect(host.attackerOf(1)).toBe(0);
    host.shoot({ side: 'top', index: 0 });
    await flush();
    expect(host.attackerOf(2)).toBe(0);
    host.shoot({ side: 'top', index: 1 });
    await flush();
    expect(host.attackerOf(3)).toBe(1);
    expect(guest.isMyTurn).toBe(true);
  });

  it('Renfort : le lanceur ajoute une pièce à SA grille, où il veut ; l’adversaire la voit dans son carnet', async () => {
    const { host, guest } = await game();
    const pick = cat.pieces[0];
    host.state.spells.push('addpiece');
    // un emplacement libre choisi par le lanceur
    const spotOk = (r: number, c: number) => validatePlacement([...host.state.placement, { pieceId: 'x0.' + pick.shape + '.' + pick.color, r, c, rot: 0 }], { ...cat, pieces: [...cat.pieces, { id: 'x0.' + pick.shape + '.' + pick.color, shape: pick.shape, color: pick.color }] }).length === 0;
    let spot: { r: number; c: number } | null = null;
    for (let r = 0; r < 10 && !spot; r++) for (let c = 0; c < 10 && !spot; c++) if (spotOk(r, c)) spot = { r, c };
    expect(spot).not.toBeNull();
    // emplacement invalide refusé (sort conservé)
    expect(host.cast('addpiece', { shape: pick.shape, color: pick.color }, { r: 50, c: 50, rot: 0 })).toBe(false);
    expect(host.state.spells).toContain('addpiece');
    expect(host.cast('addpiece', { shape: pick.shape, color: pick.color }, { ...spot!, rot: 0 })).toBe(true);
    await flush();
    expect(host.myPieces.length).toBe(cat.pieces.length + 1);
    expect(host.state.placement.length).toBe(cat.pieces.length + 1);
    expect(guest.piecesOf(0).length).toBe(cat.pieces.length + 1);
    expect(guest.myPieces.length).toBe(cat.pieces.length);
    expect(guest.state.placement.length).toBe(cat.pieces.length);
  });

  it('Tempête publique : ma grille est mélangée, pièces coulées comprises, et le carnet adverse repart à zéro', async () => {
    const { host, guest } = await game();
    // l'hôte coule une pièce et prend des notes
    const dead = guest.state.placement[0];
    const def = cat.pieces.find((d) => d.id === dead.pieceId)!;
    host.claim({ color: def.color, shape: def.shape, cells: placementParts(dead, cat) });
    await flush();
    host.setNotes(1, { marks: { '0,0': 'x' }, guesses: [] });
    guest.shoot({ side: 'top', index: 0 });
    await flush();
    expect(host.oppSunk.length).toBe(1);
    const before = JSON.stringify(guest.state.placement);
    guest.state.spells.push('shuffle');
    expect(host.isMyTurn).toBe(true);
    host.shoot({ side: 'top', index: 1 });
    await flush();
    expect(guest.cast('shuffle')).toBe(true);
    await flush();
    expect(JSON.stringify(guest.state.placement)).not.toBe(before);
    expect(guest.mySunk.size).toBe(0); // la pièce coulée est revenue en jeu
    expect(validatePlacement(guest.state.placement, guest.catalog!, { requireAll: true }).length).toBe(0);
    expect(host.state.log[host.state.log.length - 1].action).toEqual({ kind: 'spell', spell: 'shuffle' });
    expect(host.oppSunk.length).toBe(0);
    expect(host.notesFor(1)).toEqual({ marks: {}, guesses: [] });
    expect(host.notesResetAt(1)).toBe(host.state.log.length - 1);
  });

  it('Salve, Rafale et Double tir fonctionnent', async () => {
    for (const [id, edges] of [
      ['salve', [0, 1, 2].map((index) => ({ side: 'top' as const, index }))],
      ['rafale', [3, 4, 5, 6, 7].map((index) => ({ side: 'left' as const, index }))],
      ['double', [{ side: 'top' as const, index: 0 }, { side: 'bottom' as const, index: 4 }]],
    ] as const) {
      const { host, guest } = await game();
      host.state.spells.push(id);
      expect(host.cast(id, { edges: [...edges] })).toBe(true);
      await flush();
      const r = host.state.log[0].result;
      expect(r.kind === 'spell' && r.shots?.length).toBe(edges.length);
      expect(guest.state.log[0].secret?.paths?.length).toBe(edges.length);
    }
    const { host } = await game();
    host.state.spells.push('salve');
    expect(host.cast('salve', { edges: [{ side: 'top', index: 0 }, { side: 'top', index: 2 }, { side: 'top', index: 3 }] })).toBe(false);
  });

  it('nouveaux sorts d’information : Loupe, Histogramme, Périmètre, Centre, Espion', async () => {
    const { host, guest } = await game();
    guest.state.spells.push('fog', 'decoy');
    for (const [id, params] of [
      ['loupe', { r: 9, c: 9 }],
      ['histo', { opt: 'row' }],
      ['ring', {}],
      ['center', {}],
      ['spy', {}],
    ] as const) {
      host.state.spells.push(id);
      expect(host.cast(id, params)).toBe(true);
      await flush();
      guest.shoot({ side: 'top', index: 0 });
      await flush();
    }
    const results = host.state.log.filter((e) => e.by === 0).map((e) => e.result);
    const loupe = results[0];
    expect(loupe.kind === 'spell' && loupe.cells?.length).toBe(4);
    const histo = results[1];
    expect(histo.kind === 'spell' && histo.counts?.reduce((a, b) => a + b, 0)).toBe(cat.pieces.reduce((n, p) => n + catalogOf(CLASSIC_SET).shapes[p.shape].parts.length, 0));
    const spy = results[4];
    expect(spy.kind === 'spell' && spy.count).toBeGreaterThanOrEqual(2);
  });

  it('Sabotage détruit un sort adverse sans le donner', async () => {
    const { host, guest } = await game();
    guest.state.spells.push('fog');
    host.state.spells.push('sabotage');
    host.cast('sabotage');
    await flush();
    expect(guest.state.spells).not.toContain('fog');
    expect(host.state.spells).not.toContain('fog');
  });

  it('Mirage : le prochain tir traverse la grille sans rien toucher', async () => {
    const { host, guest } = await game();
    guest.state.spells.push('mirage');
    host.shoot({ side: 'top', index: 0 });
    await flush();
    guest.cast('mirage');
    await flush();
    host.shoot({ side: 'left', index: 4 });
    await flush();
    const last = host.state.log[host.state.log.length - 1].result;
    expect(last.kind === 'shot' && last.colors).toEqual([]);
    expect(last.kind === 'shot' && last.exit).toEqual({ side: 'right', index: 4 });
  });

  it('Camouflage : la prochaine déclaration, même juste, est refusée', async () => {
    const { host, guest } = await game();
    host.shoot({ side: 'top', index: 0 });
    await flush();
    guest.state.spells.push('camouflage');
    guest.cast('camouflage');
    await flush();
    const p = guest.state.placement[0];
    const def = cat.pieces.find((d) => d.id === p.pieceId)!;
    host.claim({ color: def.color, shape: def.shape, cells: placementParts(p, cat) });
    await flush();
    const r = host.state.log[host.state.log.length - 1].result;
    expect(r.kind === 'claim' && r.ok).toBe(false);
    expect(guest.mySunk.size).toBe(0);
  });

  it('Pivot garde un placement valide', async () => {
    const { host } = await game();
    const before = JSON.stringify(host.state.placement);
    host.state.spells.push('pivot');
    const ok = host.cast('pivot');
    if (ok) expect(JSON.stringify(host.state.placement)).not.toBe(before);
    expect(validatePlacement(host.state.placement, host.catalog!, { requireAll: true }).length).toBe(0);
  });

  it('un sort secret n’apprend rien à l’adversaire', async () => {
    const { host, guest } = await game();
    host.state.spells.push('relocate');
    expect(host.cast('relocate')).toBe(true);
    await flush();
    expect(guest.state.log[0].action).toEqual({ kind: 'spell', spell: 'self' });
    expect(host.state.selfLog['0']).toBe('relocate');
    expect(validatePlacement(host.state.placement, host.catalog!, { requireAll: true }).length).toBe(0);
  });

  it('Résurrection publique : la pièce revient en jeu à un emplacement aléatoire secret, et peut être recoulée', async () => {
    const { host, guest } = await game();
    const p = guest.state.placement[0];
    const def = cat.pieces.find((d) => d.id === p.pieceId)!;
    const claim = { color: def.color, shape: def.shape, cells: placementParts(p, cat) };
    host.claim(claim);
    await flush();
    expect(guest.mySunk.has(p.pieceId)).toBe(true);
    expect(host.sunkClaimsOf(1).length).toBe(1);
    guest.state.spells.push('revive');
    expect(guest.cast('revive')).toBe(true);
    await flush();
    expect(guest.mySunk.has(p.pieceId)).toBe(false);
    expect(host.sunkClaimsOf(1).length).toBe(0); // plus coulée dans le carnet de l'adversaire
    const last = host.state.log[host.state.log.length - 1];
    expect(last.action.kind === 'spell' && last.action.spell).toBe('revive');
    expect(last.action.kind === 'spell' && last.action.cells).toEqual(claim.cells); // les anciennes cases, pas les nouvelles
    expect(validatePlacement(guest.state.placement, guest.catalog!, { requireAll: true }).length).toBe(0);
    // Le nouvel emplacement n'est pas annoncé : rien d'autre que les anciennes cases ne circule.
    const moved = guest.state.placement.find((x) => x.pieceId === p.pieceId)!;
    expect(JSON.stringify(last.action)).not.toContain(JSON.stringify(placementParts(moved, cat)));
    // Elle se recoule avec ses nouvelles cases.
    host.claim({ color: def.color, shape: def.shape, cells: placementParts(moved, cat) });
    await flush();
    const r = host.state.log[host.state.log.length - 1].result;
    expect(r.kind === 'claim' && r.ok).toBe(true);
    expect(host.sunkClaimsOf(1).length).toBe(1);
  });

  it('Résurrection : l’emplacement est toujours tiré au hasard (pas forcément l’ancien)', async () => {
    const spots = new Set<string>();
    for (let seed = 1; seed <= 6; seed++) {
      const host = new PlayerSession(freshState('online', 0, 'A', newGameId(), CLASSIC_SET, cfg), null, '', hostRandom());
      const guest = new PlayerSession(freshState('online', 1, 'B', '', null), null, '', seededRandom(seed * 31));
      const [ta, tb] = createLocalPair();
      host.attach(ta);
      guest.attach(tb);
      await flush();
      host.launch();
      await flush();
      guest.acceptProposedSet();
      await flush();
      host.setPlacement(randomPlacement(cat, { random: seededRandom(1) }));
      host.markReady();
      guest.setPlacement(randomPlacement(cat, { random: seededRandom(2) }));
      guest.markReady();
      await flush();
      const p = guest.state.placement[0];
      const def = cat.pieces.find((d) => d.id === p.pieceId)!;
      host.claim({ color: def.color, shape: def.shape, cells: placementParts(p, cat) });
      await flush();
      guest.state.spells.push('revive');
      expect(guest.cast('revive')).toBe(true);
      await flush();
      const moved = guest.state.placement.find((x) => x.pieceId === p.pieceId)!;
      spots.add(JSON.stringify(moved));
    }
    expect(spots.size).toBeGreaterThan(1);
  });

  it('on peut poser sur une pièce coulée, et la ressuscitée ne chevauche jamais une pièce à flot', async () => {
    const { host, guest } = await game();
    const dead = guest.state.placement[0];
    const def = cat.pieces.find((d) => d.id === dead.pieceId)!;
    host.claim({ color: def.color, shape: def.shape, cells: placementParts(dead, cat) });
    await flush();
    expect(guest.mySunk.has(dead.pieceId)).toBe(true);
    // Déménagement : les pièces à flot peuvent maintenant occuper la place de la pièce coulée
    for (let i = 0; i < 6; i++) {
      guest.state.spells.push('relocate');
      guest.cast('relocate');
      await flush();
      host.shoot({ side: 'top', index: 0 });
      await flush();
    }
    // la pièce coulée n'a pas bougé
    expect(JSON.stringify(guest.state.placement.find((p) => p.pieceId === dead.pieceId))).toBe(JSON.stringify(dead));
    guest.state.spells.push('revive');
    expect(guest.cast('revive')).toBe(true);
    await flush();
    expect(guest.mySunk.has(dead.pieceId)).toBe(false);
    expect(validatePlacement(guest.state.placement, guest.catalog!, { requireAll: true }).length).toBe(0);
  });

  it('Résurrection impossible sans pièce coulée', async () => {
    const { host } = await game();
    host.state.spells.push('revive');
    expect(host.cast('revive')).toBe(false);
    expect(host.state.spells).toContain('revive');
  });

  it('Vol de sort : le sort change de main', async () => {
    const { host, guest } = await game();
    guest.state.spells.push('fog');
    host.state.spells.push('steal');
    host.cast('steal');
    await flush();
    expect(guest.state.spells).not.toContain('fog');
    expect(host.state.spells).toContain('fog');
  });

  it('Brume : le tir suivant ne révèle aucune couleur', async () => {
    const { host, guest } = await game();
    host.shoot({ side: 'top', index: 0 });
    await flush();
    guest.state.spells.push('fog');
    guest.cast('fog');
    await flush();
    for (let i = 0; i < 10; i++) {
      host.shoot({ side: 'left', index: i });
      await flush();
      const last = host.state.log[host.state.log.length - 1];
      if (last.result.kind === 'shot') expect(last.result.colors).toEqual([]);
      break;
    }
  });

  it('activité de l’adversaire : transmise, validée, effacée à la déconnexion', async () => {
    const { host, guest } = await game();
    guest.setActivity('notes');
    await flush();
    expect(host.activities[1]).toBe('notes');
    guest.setActivity('spell-pick');
    await flush();
    expect(host.activities[1]).toBe('spell-pick');
    expect(parseMessage({ t: 'activity', a: 'hack' })).toBeNull();
    expect(parseMessage({ t: 'activity', a: 'board' })).toEqual({ t: 'activity', a: 'board' });
    host.detach();
    host.attach(createLocalPair()[0]);
  });

  it('validation des messages de sort', () => {
    expect(isValidAction({ kind: 'spell', spell: 'radar', axis: 'row', index: 3 })).toBe(true);
    expect(isValidAction({ kind: 'spell', spell: 'radar' })).toBe(false);
    expect(isValidAction({ kind: 'spell', spell: 'inconnu' })).toBe(false);
    expect(isValidAction({ kind: 'spell', spell: 'revive' })).toBe(false); // il manque la pièce ressuscitée
    expect(isValidAction({ kind: 'spell', spell: 'fog' })).toBe(false); // un sort secret ne s'envoie pas sous son nom
    expect(isValidAction({ kind: 'spell', spell: 'self' })).toBe(true);
    expect(isValidAction({ kind: 'spell', spell: 'hidden' })).toBe(true);
    expect(isValidAction({ kind: 'spell', spell: 'relay', who: 2 })).toBe(true);
    expect(isValidAction({ kind: 'spell', spell: 'relay', who: 4 })).toBe(false);
    expect(isValidAction({ kind: 'spell', spell: 'skip' })).toBe(true);
    expect(isValidResult({ kind: 'spell', spell: 'radar', count: 3 })).toBe(true);
    expect(isValidResult({ kind: 'spell', spell: 'radar', count: -1 })).toBe(false);
    expect(isValidResult({ kind: 'spell', spell: 'addpiece', piece: { id: 'ok', shape: 's', color: 'red' } })).toBe(false);
    expect(isValidAction({ kind: 'spell', spell: 'salve', edges: [0, 1, 2].map((index) => ({ side: 'top', index })) })).toBe(true);
    expect(isValidAction({ kind: 'spell', spell: 'rafale', edges: [0, 1, 2].map((index) => ({ side: 'top', index })) })).toBe(false);
    expect(parseMessage({ t: 'newgame', gameId: 'g', set: null, cfg: { enabled: 'oui' } })).toBeNull();
  });
});
