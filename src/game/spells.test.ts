import { describe, expect, it } from 'vitest';
import { CLASSIC_SET } from '../config/pieces';
import { catalogOf, randomPlacement, seededRandom, validatePlacement, DEFAULT_SPELL_CONFIG } from '../engine';
import { PlayerSession, freshState, newGameId } from './session';
import { createLocalPair } from './transport';
import { isValidAction, isValidResult, parseMessage } from './protocol';

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const cat = catalogOf(CLASSIC_SET);
const cfg = { ...DEFAULT_SPELL_CONFIG, enabled: true, everyTurns: 1 };

async function game() {
  const host = new PlayerSession(freshState('online', 0, 'A', newGameId(), CLASSIC_SET, cfg), null, '', () => 0.1);
  const guest = new PlayerSession(freshState('online', 1, 'B', '', null), null, '', seededRandom(7));
  const [ta, tb] = createLocalPair();
  host.attach(ta);
  guest.attach(tb);
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

  it('Gel : le lanceur rejoue', async () => {
    const { host } = await game();
    host.state.spells.push('freeze');
    host.cast('freeze');
    await flush();
    expect(host.attackerOf(1)).toBe(0);
  });

  it('Intrus : une pièce de plus chez l’adversaire, visible des deux côtés', async () => {
    const { host, guest } = await game();
    host.state.spells.push('addpiece');
    host.cast('addpiece');
    await flush();
    const r = host.state.log[0].result;
    expect(r.kind === 'spell' && r.piece).toBeTruthy();
    expect(guest.myPieces.length).toBe(cat.pieces.length + 1);
    expect(host.oppPieces.length).toBe(cat.pieces.length + 1);
    expect(host.myPieces.length).toBe(cat.pieces.length);
    expect(guest.state.placement.length).toBe(cat.pieces.length + 1);
    expect(validatePlacement(guest.state.placement, guest.catalog!).length).toBe(0);
  });

  it('Tempête : la grille adverse change', async () => {
    const { host, guest } = await game();
    const before = JSON.stringify(guest.state.placement);
    host.state.spells.push('shuffle');
    host.cast('shuffle');
    await flush();
    expect(JSON.stringify(guest.state.placement)).not.toBe(before);
    expect(validatePlacement(guest.state.placement, guest.catalog!, { requireAll: true }).length).toBe(0);
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

  it('validation des messages de sort', () => {
    expect(isValidAction({ kind: 'spell', spell: 'radar', axis: 'row', index: 3 })).toBe(true);
    expect(isValidAction({ kind: 'spell', spell: 'radar' })).toBe(false);
    expect(isValidAction({ kind: 'spell', spell: 'inconnu' })).toBe(false);
    expect(isValidAction({ kind: 'spell', spell: 'revive' })).toBe(false); // un sort secret ne s'envoie pas sous son nom
    expect(isValidAction({ kind: 'spell', spell: 'self' })).toBe(true);
    expect(isValidResult({ kind: 'spell', spell: 'radar', count: 3 })).toBe(true);
    expect(isValidResult({ kind: 'spell', spell: 'radar', count: -1 })).toBe(false);
    expect(isValidResult({ kind: 'spell', spell: 'addpiece', piece: { id: 'ok', shape: 's', color: 'red' } })).toBe(false);
    expect(parseMessage({ t: 'newgame', gameId: 'g', set: null, cfg: { enabled: 'oui' } })).toBeNull();
  });
});
