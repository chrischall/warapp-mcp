// #133: a seeded property test for order legality. Every plan the planner makes on a few thousand
// random synthetic boards — all goals and adapting, several kill rates, No-Split, Local Deployment,
// commanders, guard off, luck, fog, Multi-Attack — is checked three ways:
//   1. legal: `validateTurn` (what warapp_submit_turn refuses) accepts it, and an independent
//      checker written from the game rules below (not from the planner's code) finds nothing wrong;
//   2. honest: every capture the plan claims as certain (its last attack on the target has a win
//      chance of 1) is captured when the turn simulator (src/analysis/turn-sim.ts) runs my orders
//      alone at 0% luck, no enemy reply;
//   3. deterministic: shuffling the input's order (territories, adjacency lists, bonuses, bonus
//      members, the board's entries) changes nothing in the plan.
// The seed is fixed, so a failure names a reproducible case (its index and the board's description).
// Synthetic boards only: every id here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph, type MapGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanGoal, type PlannerSettings, type PlanInput, type TurnPlan } from '../../src/analysis/planner.js';
import { type SimOrder, simulateTurn } from '../../src/analysis/turn-sim.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import type { GameMap } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';

const SEED = 0x133a;
const CASES = 5000;
const ME = 10;
const ENEMIES = [20, 30, 40];
const BASE_INCOME = 5;

/** mulberry32: a small seeded generator, so every run plans the same boards. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Case {
  index: number;
  map: GameMap;
  board: BoardState;
  live: LiveTerritory[];
  income: number;
  settings: PlannerSettings;
  goal: PlanGoal | undefined;
  adapt: boolean;
  fog: boolean;
  commanders: boolean;
  /** Bonus id → member ids (a partition of the map). */
  bonuses: Map<number, number[]>;
  describe: string;
}

const RATES: [number, number][] = [
  [60, 70],
  [50, 70],
  [20, 80],
  [75, 50],
  [100, 100],
];
const GOALS: (PlanGoal | undefined)[] = [undefined, 'balanced', 'expand', 'complete-bonus', 'defend'];

function makeCase(index: number, r: () => number): Case {
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const chance = (p: number) => r() < p;

  // A connected graph: a random spanning tree plus a few extra edges.
  const n = int(5, 14);
  const ids = Array.from({ length: n }, (_, i) => 100 + i * 3 + int(0, 2));
  const edges = new Set<string>();
  const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  for (let i = 1; i < n; i++) edges.add(key(ids[i]!, ids[int(0, i - 1)]!));
  const extra = int(0, n);
  for (let k = 0; k < extra; k++) {
    const a = pick(ids);
    const b = pick(ids);
    if (a !== b) edges.add(key(a, b));
  }
  const adj = new Map<number, number[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    const [a, b] = e.split('-').map(Number) as [number, number];
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }

  // Bonuses: a partition into runs of 1–4 territories, worth 0–5.
  const bonuses = new Map<number, number[]>();
  const values = new Map<number, number>();
  for (let i = 0, b = 900; i < n; b++) {
    const size = Math.min(int(1, 4), n - i);
    bonuses.set(b, ids.slice(i, i + size));
    values.set(b, int(0, 5));
    i += size;
  }

  const enemies = ENEMIES.slice(0, int(1, 3));
  const owners = new Map<number, number | 'neutral'>();
  for (const id of ids) owners.set(id, chance(0.35) ? ME : chance(0.45) ? pick(enemies) : 'neutral');
  if (![...owners.values()].includes(ME)) owners.set(ids[0]!, ME);

  const [off, def] = pick(RATES);
  const settings: PlannerSettings = {
    offensiveKillRate: off,
    defensiveKillRate: def,
    roundingMode: 'StraightRound',
    luckModifier: chance(0.15) ? 0.16 : 0,
    oneArmyStandsGuard: !chance(0.15),
    baseIncome: BASE_INCOME,
    ...(chance(0.25) ? { localDeployments: true } : {}),
    ...(chance(0.2) ? { noSplit: true } : {}),
    ...(chance(0.2) ? { multiAttack: true } : {}),
  };
  const guardOn = settings.oneArmyStandsGuard !== false;

  const fog = chance(0.3);
  const commanders = chance(0.25);
  const nextToMine = (id: number) => adj.get(id)!.some((x) => owners.get(x) === ME);
  const territories: TerritoryState[] = [];
  const live: LiveTerritory[] = [];
  const commanderOn = new Map<number, number>();
  if (commanders) {
    for (const p of [ME, ...enemies]) {
      const held = ids.filter((id) => owners.get(id) === p);
      if (held.length) commanderOn.set(pick(held), p);
    }
  }
  for (const id of ids) {
    const o = owners.get(id)!;
    const armies = o === 'neutral' ? int(guardOn ? 1 : 0, 6) : int(1, 12);
    // Fog hides only what is not mine and not next to mine: the planner's own view.
    const hidden = fog && o !== ME && !nextToMine(id) && chance(0.6);
    const cmdr = commanderOn.get(id);
    if (hidden) {
      territories.push({ territoryId: id, owner: { kind: 'unknown' }, armies: null, fogLevel: 'Fogged' });
      live.push({ territoryId: id, fogLevel: 4, fogged: true, owner: -1, armies: null });
      continue;
    }
    const units = cmdr !== undefined ? [{ kind: 'commander' as const, id: `c${cmdr}`.padStart(32, '0'), playerId: cmdr }] : undefined;
    territories.push({
      territoryId: id,
      owner: o === 'neutral' ? { kind: 'neutral' } : { kind: 'player', playerId: o },
      armies,
      ...(units ? { specialUnits: units } : {}),
    });
    live.push({
      territoryId: id,
      fogLevel: o === ME ? 1 : 2,
      fogged: false,
      owner: o === 'neutral' ? OWNER_NEUTRAL : o,
      armies,
      ...(cmdr !== undefined ? { specialUnits: [{ kind: 'commander', id: `c${cmdr}`.padStart(32, '0'), owner: cmdr }] as never } : {}),
    });
  }

  const income =
    BASE_INCOME +
    [...bonuses].filter(([, m]) => m.every((id) => owners.get(id) === ME)).reduce((s, [b]) => s + values.get(b)!, 0);
  const map: GameMap = {
    id: 1,
    name: `Prop${index}`,
    territories: ids.map((id) => ({ id, name: `P${id}`, connectedTo: [...adj.get(id)!] })),
    bonuses: [...bonuses].map(([b, m]) => ({ id: b, name: `B${b}`, value: values.get(b)!, territoryIds: [...m], bonusIds: [] })),
    distributionModes: [],
  };
  const goal = pick(GOALS);
  const adapt = goal === undefined && chance(0.7);
  const describe =
    `case ${index}: ${n} territories, ${enemies.length} enemies, ${off}/${def}` +
    `${settings.luckModifier ? ' luck' : ''}${guardOn ? '' : ' guard-off'}${settings.localDeployments ? ' LD' : ''}` +
    `${settings.noSplit ? ' no-split' : ''}${settings.multiAttack ? ' multi-attack' : ''}${fog ? ' fog' : ''}` +
    `${commanders ? ' commanders' : ''} goal=${goal ?? (adapt ? 'adapt' : 'default')}`;
  return { index, map, board: { source: 'gamefeed', verified: false, territories }, live, income, settings, goal, adapt, fog, commanders, bonuses, describe };
}

function inputOf(c: Case, map: GameMap, board: BoardState): PlanInput {
  return {
    graph: buildGraph(map),
    board,
    me: ME,
    income: c.income,
    turn: 5,
    settings: c.settings,
    options: { ...(c.goal ? { goal: c.goal } : {}), ...(c.adapt ? { adapt: true } : {}) },
    game: { fog: c.fog ? 'Foggy' : 'NoFog', commanders: c.commanders, turn: 5 },
  };
}

/**
 * The independent checker: the game's rules for one player's orders, from the wiki, written here
 * without the planner's helpers. Returns every rule the plan breaks (empty when legal).
 */
function ruleBreaks(c: Case, g: MapGraph, plan: TurnPlan): string[] {
  const out: string[] = [];
  const at = new Map(c.board.territories.map((t) => [t.territoryId, t]));
  const isMine = (id: number) => {
    const t = at.get(id);
    return t !== undefined && t.armies !== null && t.owner.kind === 'player' && t.owner.playerId === ME;
  };
  const near = (a: number, b: number) => (g.map.territories.find((t) => t.id === a)?.connectedTo ?? []).includes(b) ||
    (g.map.territories.find((t) => t.id === b)?.connectedTo ?? []).includes(a);
  const guard = c.settings.oneArmyStandsGuard === false ? 0 : 1;

  // Deploys: on my own territories, positive whole armies, exactly the income.
  const deployed = new Map<number, number>();
  for (const d of plan.deploys) {
    if (!isMine(d.territoryId)) out.push(`deploy on T${d.territoryId}, not mine`);
    if (!Number.isInteger(d.armies) || d.armies < 1) out.push(`deploy of ${d.armies} on T${d.territoryId}`);
    deployed.set(d.territoryId, (deployed.get(d.territoryId) ?? 0) + d.armies);
  }
  const total = [...deployed.values()].reduce((s, a) => s + a, 0);
  if (total !== c.income) out.push(`deploys ${total}, income ${c.income}`);

  // Local Deployment: a fully held bonus's value is deployed inside it; only the rest goes anywhere.
  if (c.settings.localDeployments) {
    let poolTotal = 0;
    let beyondPools = 0;
    const inBonus = new Map<number, number>();
    for (const [b, members] of c.bonuses) {
      const value = c.map.bonuses.find((x) => x.id === b)!.value;
      if (value <= 0 || !members.every(isMine)) continue;
      poolTotal += value;
      const inside = members.reduce((s, id) => s + (deployed.get(id) ?? 0), 0);
      beyondPools += Math.max(0, inside - value);
      for (const id of members) inBonus.set(id, b);
    }
    for (const [id, a] of deployed) if (!inBonus.has(id)) beyondPools += a;
    if (beyondPools > c.income - poolTotal) out.push(`Local Deployment: ${beyondPools} deployed beyond the pools, only ${c.income - poolTotal} may go anywhere`);
  }

  // Moves: from my territory (or, under Multi-Attack, one an earlier move entered), to a neighbour,
  // whole positive armies, each source/target pair once, one order per source under No-Split, and
  // never more than the source can send (armies + deploys − guard; a commander is never the guard
  // and never sent by these orders; under Multi-Attack, plus what moved in earlier — an upper bound).
  const entered = new Set<number>();
  const pairs = new Set<string>();
  const sources = new Map<number, number>();
  const sent = new Map<number, number>();
  const inflow = new Map<number, number>();
  for (const m of plan.moves) {
    const chained = !isMine(m.from) && c.settings.multiAttack === true && entered.has(m.from);
    if (!isMine(m.from) && !chained) out.push(`move from T${m.from}, not mine`);
    if (!near(m.from, m.to)) out.push(`T${m.from} → T${m.to}: not adjacent`);
    if (m.from === m.to) out.push(`T${m.from} → itself`);
    if (!Number.isInteger(m.armies) || m.armies < 1) out.push(`T${m.from} → T${m.to}: ${m.armies} armies`);
    const pair = `${m.from}>${m.to}`;
    if (pairs.has(pair)) out.push(`T${m.from} → T${m.to} twice`);
    pairs.add(pair);
    sources.set(m.from, (sources.get(m.from) ?? 0) + 1);
    if (m.kind === 'transfer' && !isMine(m.to) && !entered.has(m.to)) out.push(`transfer T${m.from} → T${m.to}, not mine`);
    if (m.kind === 'attack' && isMine(m.to)) out.push(`attack T${m.from} → T${m.to}, my own`);
    const start = chained ? 0 : (at.get(m.from)?.armies ?? 0) + (deployed.get(m.from) ?? 0);
    const can = start + (c.settings.multiAttack ? (inflow.get(m.from) ?? 0) : 0) - guard;
    const now = (sent.get(m.from) ?? 0) + m.armies;
    sent.set(m.from, now);
    if (now > can) out.push(`T${m.from} sends ${now}, can send ${can}`);
    inflow.set(m.to, (inflow.get(m.to) ?? 0) + m.armies);
    entered.add(m.to);
  }
  if (c.settings.noSplit) for (const [id, k] of sources) if (k > 1) out.push(`No-Split: T${id} issues ${k} orders`);
  return out;
}

/** Captures the plan claims as certain: listed captures whose last attack has a win chance of 1. */
function certainCaptures(plan: TurnPlan): number[] {
  return plan.expected.captures.filter((id) => {
    const last = plan.moves.filter((m) => m.kind === 'attack' && m.to === id).at(-1);
    return last?.winChance === 1;
  });
}

function shuffled(c: Case, r: () => number): { map: GameMap; board: BoardState } {
  const sh = <T>(xs: readonly T[]): T[] => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  };
  return {
    map: {
      ...c.map,
      territories: sh(c.map.territories).map((t) => ({ ...t, connectedTo: sh(t.connectedTo) })),
      bonuses: sh(c.map.bonuses).map((b) => ({ ...b, territoryIds: sh(b.territoryIds) })),
    },
    board: { ...c.board, territories: sh(c.board.territories) },
  };
}

/**
 * Known planner defects this test found, by case index: each is skipped for the check named, with
 * the issue that tracks it. Empty when the planner passes everything.
 */
const KNOWN: Record<number, { check: 'legal' | 'captures' | 'order'; why: string }> = {};

describe('order legality on seeded random boards (#133)', () => {
  const r = rng(SEED);
  const cases = Array.from({ length: CASES }, (_, i) => makeCase(i, r));

  it(`plans ${CASES} boards: every order legal, every certain capture captures, shuffled input changes nothing`, () => {
    const problems: string[] = [];
    let attacks = 0;
    let certain = 0;
    for (const c of cases) {
      const known = KNOWN[c.index];
      const input = inputOf(c, c.map, c.board);
      const plan = planTurn(input);
      const named = (id: number) => ({ id, name: `P${id}` });

      if (known?.check !== 'legal') {
        try {
          validateTurn({
            map: c.map,
            board: c.live,
            myInGameId: ME,
            income: c.income,
            guard: c.settings.oneArmyStandsGuard !== false,
            deploys: plan.deploys.map((d) => ({ territory: named(d.territoryId), armies: d.armies })),
            moves: plan.moves.map((m) => ({ from: named(m.from), to: named(m.to), armies: m.armies })),
            localDeployments: c.settings.localDeployments === true,
            noSplit: c.settings.noSplit === true,
            multiAttack: c.settings.multiAttack === true,
          });
        } catch (e) {
          problems.push(`${c.describe}: validateTurn refused: ${(e as Error).message}`);
        }
        for (const b of ruleBreaks(c, input.graph, plan)) problems.push(`${c.describe}: ${b}`);
      }

      if (known?.check !== 'captures') {
        const claimed = certainCaptures(plan);
        attacks += plan.moves.filter((m) => m.kind === 'attack').length;
        certain += claimed.length;
        if (claimed.length) {
          const sim = simulateTurn({
            graph: input.graph,
            board: c.board,
            deploys: plan.deploys.map((d) => ({ player: ME, territoryId: d.territoryId, armies: d.armies })),
            orders: [{ player: ME, orders: plan.moves.map((m): SimOrder => ({ from: m.from, to: m.to, armies: m.armies })) }],
            moveOrder: [ME],
            settings: { ...c.settings, luckModifier: 0, roundingMode: 'StraightRound' },
          });
          for (const id of claimed) {
            const owner = sim.territories.get(id)?.owner;
            if (owner !== ME) problems.push(`${c.describe}: claimed certain capture of T${id} ends ${String(owner)}`);
          }
        }
      }

      if (known?.check !== 'order') {
        const s = shuffled(c, r);
        const again = planTurn(inputOf(c, s.map, s.board));
        if (JSON.stringify(again) !== JSON.stringify(plan)) {
          try {
            expect(again).toEqual(plan);
          } catch (e) {
            problems.push(`${c.describe}: shuffled input changed the plan: ${(e as Error).message.slice(0, 600)}`);
          }
        }
      }
    }
    // The generator must actually exercise attacks and certain captures, or the test proves nothing.
    expect(attacks).toBeGreaterThan(CASES);
    expect(certain).toBeGreaterThan(CASES / 4);
    expect(problems.slice(0, 20)).toEqual([]);
  }, 240_000); // ~7 s alone, past 60 s beside the full suite on a CI runner (#221 timed out at 63.6 s)

  // B2: the same boards with a truce with the first enemy (every territory on both sides covered;
  // trust, notice and a border cap varied): every order still legal, and no covered territory attacked.
  it(`plans the boards with two or more enemies under a truce: every order legal, no covered territory attacked`, () => {
    const problems: string[] = [];
    let truced = 0;
    for (const c of cases) {
      const owners = new Map<number, number>();
      for (const t of c.board.territories) if (t.owner.kind === 'player') owners.set(t.territoryId, t.owner.playerId);
      const enemies = [...new Set([...owners.values()].filter((p) => p !== ME))].sort((a, b) => a - b);
      if (enemies.length < 2) continue;
      truced++;
      const partner = enemies[0]!;
      const theirs = [...owners].filter(([, p]) => p === partner).map(([t]) => t);
      const mineIds = [...owners].filter(([, p]) => p === ME).map(([t]) => t);
      const input: PlanInput = {
        ...inputOf(c, c.map, c.board),
        game: { fog: c.fog ? 'Foggy' : 'NoFog', commanders: c.commanders, turn: 5, players: [ME, ...enemies].map((id) => ({ id })) },
        relations: [
          {
            player: partner,
            coveredMine: mineIds,
            coveredTheirs: theirs,
            state: c.index % 5 === 0 ? 'notice' : 'active',
            ...(c.index % 5 === 0 ? { endsTurn: 7 } : {}),
            ...(c.index % 3 === 0 ? { borderCap: c.index % 7 } : {}),
            trust: c.index % 4 === 0 ? 'watch' : 'clear',
          },
        ],
      };
      const plan = planTurn(input);
      const named = (id: number) => ({ id, name: `P${id}` });
      for (const m of plan.moves) if (m.kind === 'attack' && theirs.includes(m.to)) problems.push(`${c.describe}: attacks covered T${m.to}`);
      if (KNOWN[c.index]?.check === 'legal') continue;
      try {
        validateTurn({
          map: c.map,
          board: c.live,
          myInGameId: ME,
          income: c.income,
          guard: c.settings.oneArmyStandsGuard !== false,
          deploys: plan.deploys.map((d) => ({ territory: named(d.territoryId), armies: d.armies })),
          moves: plan.moves.map((m) => ({ from: named(m.from), to: named(m.to), armies: m.armies })),
          localDeployments: c.settings.localDeployments === true,
          noSplit: c.settings.noSplit === true,
          multiAttack: c.settings.multiAttack === true,
        });
      } catch (e) {
        problems.push(`${c.describe}: validateTurn refused: ${(e as Error).message}`);
      }
      for (const b of ruleBreaks(c, input.graph, plan)) problems.push(`${c.describe}: ${b}`);
    }
    expect(truced).toBeGreaterThan(CASES / 4);
    expect(problems.slice(0, 20)).toEqual([]);
  }, 240_000);
});
