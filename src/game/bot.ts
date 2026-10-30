/**
 * Adversaire robot pour s'entraîner seul ou tester l'app sans second téléphone.
 * Il accepte le jeu proposé, place ses pièces au hasard et tire au hasard
 * (sans jamais déclarer de pièce).
 */

import { GRID_SIZE, randomPlacement, sameEdge, type Edge, type Side } from '../engine';
import type { PlayerSession } from './session';

export function driveBot(bot: PlayerSession, delayMs = 900): () => void {
  let timer: number | undefined;
  const needsAction = () => bot.phase === 'review' || bot.phase === 'setup' || (bot.isMyTurn && !bot.state.pending);
  const step = () => {
    timer = undefined;
    if (bot.phase === 'review') {
      bot.acceptProposedSet();
      return;
    }
    if (bot.phase === 'setup' && bot.catalog) {
      bot.setPlacement(randomPlacement(bot.catalog));
      bot.markReady();
      return;
    }
    if (bot.isMyTurn && !bot.state.pending) {
      const done = bot.state.log.filter((e) => e.by === bot.state.me && e.action.kind === 'shot').map((e) => (e.action as { edge: Edge }).edge);
      const all: Edge[] = [];
      for (const side of ['top', 'bottom', 'left', 'right'] as Side[]) for (let i = 0; i < GRID_SIZE; i++) all.push({ side, index: i });
      const fresh = all.filter((e) => !done.some((d) => sameEdge(d, e)));
      const pool = fresh.length ? fresh : all;
      bot.shoot(pool[Math.floor(Math.random() * pool.length)]);
    }
  };
  const schedule = () => {
    if (timer === undefined && needsAction()) timer = window.setTimeout(step, bot.phase === 'playing' ? delayMs : 50);
  };
  const off = bot.onChange(schedule);
  schedule();
  return () => {
    off();
    if (timer !== undefined) window.clearTimeout(timer);
  };
}
