// LOCAL research script for #476 (never a tool, never in CI): how far is the very-large-map path of the pick advisor
// from the exact planner? It forces large mode (`largeAbove: 0`) on synthetic maps the exact planner still finishes,
// and scores the large primary on the exact model (`evaluate`). Prints aggregates only; every id is made up.
// Run: npm run build && node scripts/picks-scale-research.mjs [--sizes 150,300,600] [--seeds 3]
import { buildGraph } from '../dist/analysis/graph.js';
import { planPicks } from '../dist/analysis/picks.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const SIZES = arg('sizes', '150,300,600').split(',').map(Number);
const SEEDS = Number(arg('seeds', '3'));
const PLAYERS = arg('players', '2,3,6,12').split(',').map(Number);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An irregular map: a W×H grid (with a few random shortcut links) cut into bonuses by region growing from random seeds. */
function makeMap(n, seed, shuffleIds) {
  const r = rng(seed);
  const cols = Math.round(Math.sqrt(n * 1.4));
  const rows = Math.ceil(n / cols);
  const count = cols * rows;
  const at = (c, rr) => rr * cols + c;
  const edges = new Set();
  const add = (a, b) => edges.add(a < b ? `${a},${b}` : `${b},${a}`);
  for (let rr = 0; rr < rows; rr++)
    for (let c = 0; c < cols; c++) {
      if (c + 1 < cols) add(at(c, rr), at(c + 1, rr));
      if (rr + 1 < rows) add(at(c, rr), at(c, rr + 1));
    }
  for (let i = 0; i < count / 25; i++) add(Math.floor(r() * count), Math.floor(r() * count));
  const adj = Array.from({ length: count }, () => []);
  for (const e of edges) {
    const [a, b] = e.split(',').map(Number);
    if (a !== b) {
      adj[a].push(b);
      adj[b].push(a);
    }
  }
  // Bonuses: grow regions from seeds to a random target size 2..9 (most 3-5).
  const owner = new Array(count).fill(-1);
  const bonuses = [];
  const order = Array.from({ length: count }, (_, i) => i).sort(() => r() - 0.5);
  for (const s0 of order) {
    if (owner[s0] >= 0) continue;
    const target = 2 + Math.floor(r() * r() * 8);
    const id = bonuses.length;
    const members = [s0];
    owner[s0] = id;
    for (let k = 0; k < members.length && members.length < target; k++)
      for (const nb of adj[members[k]]) if (owner[nb] < 0 && members.length < target) (owner[nb] = id), members.push(nb);
    bonuses.push(members);
  }
  // Ids: sequential in grid order, or shuffled (the sampled centrality reads ids, so order matters).
  const perm = Array.from({ length: count }, (_, i) => i + 1);
  if (shuffleIds) perm.sort(() => r() - 0.5);
  const tid = (i) => perm[i];
  const territories = adj.map((ns, i) => ({ id: tid(i), name: `T${tid(i)}`, connectedTo: ns.filter((m) => m > i).map(tid) }));
  const map = {
    id: 1,
    name: 'Synthetic',
    territories,
    bonuses: bonuses.map((m, i) => ({
      id: i + 1,
      name: `B${i + 1}`,
      value: Math.max(1, Math.round(m.length * (0.6 + r() * 1.4) + (r() < 0.1 ? 3 : 0))),
      territoryIds: m.map(tid),
      bonusIds: [],
    })),
    distributionModes: [],
  };
  const neutral = new Map();
  for (let i = 0; i < count; i++) if (r() < 0.04) neutral.set(tid(i), 10);
  return { graph: buildGraph(map), pickable: territories.map((t) => t.id), neutral, count };
}

const SETTINGS = { offensiveKillRate: 60, defensiveKillRate: 70, initialPlayerArmiesPerTerritory: 8, minimumArmyBonus: 5, initialNonDistributionArmies: 2, initialNeutralsInDistribution: 1, oneArmyStandsGuard: true };
const jaccard = (a, b) => {
  const A = new Set(a);
  const inter = b.filter((x) => A.has(x)).length;
  return inter / (A.size + b.length - inter || 1);
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');

// Variants: the shipped large path, and each approximation switched off in turn (what is left is what costs).
const VARIANTS = {
  shipped: {},
  'no-pruning': { candidateBonuses: Infinity, candidateTerritories: Infinity },
  'no-sampling': { centralitySamples: Infinity },
  'no-hop-bound': { hopDepth: Infinity },
};
const VARIANT_NAMES = arg('variants', 'shipped').split(',');
const EXACT = new Map();
const rows = [];
for (const variant of VARIANT_NAMES)
for (const n of SIZES)
  for (const players of PLAYERS)
    for (const shuffle of [false, true])
      for (let seed = 1; seed <= SEEDS; seed++) {
        const m = makeMap(n, seed * 7919 + n, shuffle);
        const base = { graph: m.graph, pickable: m.pickable, settings: SETTINGS, players, territoryLimit: 3, maxPicks: players * 3, neutralArmies: m.neutral };
        const t0 = Date.now();
        const memoKey = `${n}|${players}|${shuffle}|${seed}`;
        if (!EXACT.has(memoKey)) EXACT.set(memoKey, { plan: planPicks({ ...base, largeAbove: Infinity }), ms: Date.now() - t0 });
        const { plan: exact, ms: exactMs } = EXACT.get(memoKey);
        const t1 = Date.now();
        const large = planPicks({ ...base, largeAbove: 0, scale: VARIANTS[variant] });
        const t2 = Date.now();
        const reeval = planPicks({ ...base, largeAbove: Infinity, evaluate: large.groups.primary.territoryIds });
        const E = exact.groups.primary.score;
        const L = reeval.evaluated;
        rows.push({
          variant,
          n: m.count,
          players,
          shuffle,
          exactMs,
          largeMs: t2 - t1,
          primaryJaccard: jaccard(exact.groups.primary.territoryIds, large.groups.primary.territoryIds),
          scoreRatio: E > 0 ? L / E : NaN,
          listJaccard: jaccard(exact.picks.map((p) => p.territoryId), large.picks.map((p) => p.territoryId)),
          ranked: large.candidates?.ranked ?? 0,
        });
      }

console.log('variant       territories players ids      runs  exact ms  large ms  primary-jaccard  score(large)/score(exact)  list-jaccard  ranked');
const keys = [...new Set(rows.map((r) => `${r.variant}|${r.n}|${r.players}|${r.shuffle}`))];
for (const k of keys) {
  const g = rows.filter((r) => `${r.variant}|${r.n}|${r.players}|${r.shuffle}` === k);
  console.log(
    `${g[0].variant.padEnd(12)} ${String(g[0].n).padStart(11)} ${String(g[0].players).padStart(7)} ${(g[0].shuffle ? 'shuffled' : 'ordered ').padEnd(8)} ${String(g.length).padStart(4)} ${f(mean(g.map((r) => r.exactMs)), 0).padStart(9)} ${f(mean(g.map((r) => r.largeMs)), 0).padStart(9)} ${f(mean(g.map((r) => r.primaryJaccard))).padStart(16)} ${f(mean(g.map((r) => r.scoreRatio))).padStart(26)} ${f(mean(g.map((r) => r.listJaccard))).padStart(13)} ${f(mean(g.map((r) => r.ranked)), 0).padStart(7)}`,
  );
}
for (const v of VARIANT_NAMES) {
  const a = rows.filter((r) => r.variant === v && Number.isFinite(r.scoreRatio));
  console.log(`\n${v}: ${a.length} runs, mean ${f(mean(a.map((r) => r.scoreRatio)))}, worst ${f(Math.min(...a.map((r) => r.scoreRatio)))}, below 0.9 in ${a.filter((r) => r.scoreRatio < 0.9).length}, mean large ms ${f(mean(a.map((r) => r.largeMs)), 0)}`);
}
const all = rows.filter((r) => Number.isFinite(r.scoreRatio));
console.log(`\nAll ${rows.length} runs: mean score ratio ${f(mean(all.map((r) => r.scoreRatio)))}, worst ${f(Math.min(...all.map((r) => r.scoreRatio)))}, ratio below 0.9 in ${all.filter((r) => r.scoreRatio < 0.9).length}; ordered ids ${f(mean(all.filter((r) => !r.shuffle).map((r) => r.scoreRatio)))} vs shuffled ${f(mean(all.filter((r) => r.shuffle).map((r) => r.scoreRatio)))}`);
