#!/usr/bin/env node
// LOCAL research script (never in CI): plays arena tournaments between bots on synthetic maps.
// Usage: npm run build && node scripts/arena.mjs [--games N] [--turns T] [--fog] [--variant name]...
// Each pairing plays every seed twice, the seats swapped, and prints wins per bot.
import { playArena, plannerBot, spreaderBot } from '../dist/analysis/arena.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const games = Number(opt('--games', '20'));
const turns = Number(opt('--turns', '40'));
const fog = args.includes('--fog');
const seed0 = Number(opt('--seed', '1'));

/** Bots by name: the planner as it is, variants with options, and the spreader. */
const VARIANTS = {
  planner: () => plannerBot('planner'),
  spreader: () => spreaderBot('spreader'),
  'no-strike-share': () => plannerBot('no-strike-share', { strikeShare: false }),
  'no-hold-cap': () => plannerBot('no-hold-cap', { holdCap: false }),
  'no-siege': () => plannerBot('no-siege', { siegeAuto: false }),
  balanced: () => plannerBot('balanced', { goal: 'balanced' }),
  expand: () => plannerBot('expand', { goal: 'expand' }),
};
const extra = (process.env.ARENA_VARIANTS ?? '').split(',').filter(Boolean);
for (const v of extra) {
  const [name, json] = v.split('=');
  VARIANTS[name] = () => plannerBot(name, JSON.parse(json));
}
const pairs = (opt('--pairs', 'planner:spreader') ?? '').split(',').map((p) => p.split(':'));

for (const [a, b] of pairs) {
  const tally = { [a]: 0, [b]: 0, draw: 0, elim: 0 };
  const incs = { [a]: [], [b]: [] };
  for (let s = seed0; s < seed0 + games; s++)
    for (const swap of [false, true]) {
      const bots = swap ? [VARIANTS[b](), VARIANTS[a]()] : [VARIANTS[a](), VARIANTS[b]()];
      const r = playArena({ seed: s, bots, maxTurns: turns, fog });
      const names = swap ? [b, a] : [a, b];
      if (r.winner === null) tally.draw++;
      else tally[names[r.winner]]++;
      if (r.by === 'eliminated') tally.elim++;
      const at = Math.min(r.incomes[0].length, 15) - 1;
      incs[names[0]].push(r.incomes[0][at]);
      incs[names[1]].push(r.incomes[1][at]);
    }
  const mean = (xs) => (xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(1);
  console.log(
    `${a} vs ${b} (${games * 2} games, ${turns} turns${fog ? ', fog' : ''}): ${a} ${tally[a]}, ${b} ${tally[b]}, draws ${tally.draw}, eliminations ${tally.elim}; mean income at turn 15: ${a} ${mean(incs[a])}, ${b} ${mean(incs[b])}`,
  );
}
