// Issue #121: captures, transfers and the leftover deploy must not strip or walk away from
// borders that face an enemy. Each territory has one surplus — its armies plus this turn's
// deploys, less what holds it against the visible threat — and every pass draws on that.
// Synthetic maps and made-up ids only. Kill rates 60/70, no luck, one army stands guard.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import type { GameMap } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const RATES = { offensiveKillRate: 60, defensiveKillRate: 70 };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
  return {
    id: 1,
    name: 'Synthetic surplus',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const enemy = (territoryId: number, armies: number, playerId = ENEMY): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const deployedOn = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;
/** Armies on my `id` once every deploy and move of the plan is done (captures not counted). */
function endsOn(input: PlanInput, p: TurnPlan, id: number): number {
  const st = input.board.territories.find((t) => t.territoryId === id)!;
  let a = (st.armies ?? 0) + deployedOn(p, id);
  for (const m of p.moves) {
    if (m.from === id) a -= m.armies;
    if (m.to === id && m.kind === 'transfer') a += m.armies;
  }
  return a;
}
const takes = (armies: number) => armiesToTake(armies, RATES)!;

/** The plan, after warapp_submit_turn's validator accepts it (it throws on a refusal). */
function plan(input: PlanInput): TurnPlan {
  const p = planTurn(input);
  const map = input.graph.map;
  const names = new Map(map.territories.map((t) => [t.id, t.name]));
  const ref = (id: number) => ({ id, name: names.get(id)! });
  validateTurn({
    map,
    board: input.board.territories.map(
      (t): LiveTerritory => ({
        territoryId: t.territoryId,
        fogLevel: t.armies === null ? 4 : 1,
        fogged: t.armies === null,
        owner: t.owner.kind === 'player' ? t.owner.playerId : t.owner.kind === 'neutral' ? OWNER_NEUTRAL : -1,
        armies: t.armies,
      }),
    ),
    myInGameId: ME,
    income: input.income,
    guard: input.settings?.oneArmyStandsGuard ?? true,
    deploys: p.deploys.map((d) => ({ territory: ref(d.territoryId), armies: d.armies })),
    moves: p.moves.map((m) => ({ from: ref(m.from), to: ref(m.to), armies: m.armies })),
  });
  return p;
}

describe('#121 a capture keeps what holds a safe border', () => {
  // 18(n2) – 22(mine 8) – 23(enemy 7) ; 27(mine 0) – 6(n1). Income 5.
  // T22 holds at the start: taking 8 needs 13, more than a threat of 6 movable + 5 deploy = 11.
  const g = buildGraph(makeMap([6, 18, 22, 23, 27], [[18, 22], [22, 23], [6, 27]]));
  const s = board([mine(22, 8), enemy(23, 7), neutral(18, 2), mine(27, 0), neutral(6, 1)]);
  const at = (income: number, settings = STD): PlanInput => ({ graph: g, board: s, me: ME, income, settings });

  it('T22 is not left takeable by its capture of T18 (both captures do not fit with the guard)', () => {
    expect(takes(8)).toBeGreaterThan(11);
    const input = at(5);
    const p = plan(input);
    // Before #121: deploys 22+2, 27+3 and 22->18 x3 left T22 on 7, which 11 take.
    expect(takes(endsOn(input, p, 22))).toBeGreaterThan(11);
  });

  it('the capture deploys what keeps T22 holding when it fits', () => {
    const input = at(5, { ...STD, oneArmyStandsGuard: false });
    const p = plan(input);
    expect(p.moves.filter((m) => m.kind === 'attack').map((m) => m.to).sort((a, b) => a - b)).toEqual([6, 18]);
    expect(deployedOn(p, 22)).toBe(3);
    expect(takes(endsOn(input, p, 22))).toBeGreaterThan(11);
  });

  it('with income to spare it takes T18 and keeps the hold', () => {
    const input = at(8);
    const p = plan(input);
    expect(p.moves.some((m) => m.from === 22 && m.to === 18)).toBe(true);
    expect(takes(endsOn(input, p, 22))).toBeGreaterThan(11);
  });
});
