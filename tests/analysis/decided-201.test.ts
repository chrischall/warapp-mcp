// #201: the multi-turn border forecast and the outlook (#178) put to use — the payback horizon
// shortens once the game is decided, and the strike stack and the stalemate read the forecast.
// Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import type { GameOutlook, OutlookTurn } from '../../src/analysis/outlook.js';
import { planTurn, type PlanOptions } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const enemy = (territoryId: number, armies: number, playerId = 20): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId }, armies });
function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Synthetic',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const outlook = (state: GameOutlook['state'], mineS: number, low: number, high: number | null): Pick<GameOutlook, 'state' | 'turns'> => {
  const t = (turn: number): OutlookTurn => ({
    turn,
    mine: mineS,
    strongest: { playerId: 20, low, high },
    ratio: { low: high ? mineS / high : 0, high: mineS / low },
    changed: 0,
    state: state ?? 'even',
  });
  return { state, turns: [t(6), t(7), t(8)] };
};

describe('#201: the payback horizon once the game is decided', () => {
  // My 30s on T1 and T3. T2, a neutral 10, is the +2 bonus B801 alone: taking it loses ~7, repaid by
  // +2 in 4 turns — inside 10 turns, not inside 3. Player 20's 3-stack sits beside T3.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5],
      [
        [1, 2],
        [1, 3],
        [3, 4],
        [4, 5],
      ],
      [[801, 2, [2]]],
    ),
  );
  const run = (options: PlanOptions) =>
    planTurn({
      graph: g,
      board: board([mine(1, 30), neutral(2, 10), mine(3, 30), enemy(4, 3), enemy(5, 3)]),
      me: ME,
      income: 10,
      settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
      game: { players: [{ id: ME }, { id: 20 }], turn: 8 },
      options,
    });
  const skips = (p: ReturnType<typeof planTurn>) => p.rationale.some((l) => /Skip bonus B801/.test(l));

  it('undecided: 10 turns of payback, the bonus is economic', () => {
    const p = run({ adapt: true, outlook: outlook('even', 60, 20, 30) });
    expect(skips(p)).toBe(false);
    expect(p.rationale.join('\n')).not.toMatch(/Outlook \(#201\)/);
  });

  it('winning: the strongest opponent (high 20) over my income (10) leaves ~3 turns — the bonus no longer pays', () => {
    const p = run({ adapt: true, outlook: outlook('winning', 120, 10, 20) });
    expect(p.rationale.join('\n')).toMatch(
      /Outlook \(#201\): winning for 3 turns running, so the game is decided — the strongest opponent's strength of 20 over my income of 10 leaves ~3 turns, so every payback test counts 3 turns instead of 10\./,
    );
    expect(skips(p)).toBe(true);
  });

  it('#208: winning on the likely high counts its likely high, called an estimate, not the loose bound', () => {
    const o = outlook('winning', 120, 10, 2000);
    const turns = o.turns.map((t) => ({ ...t, likely: { playerId: 20, high: 20, ratio: 6 }, estimated: true as const }));
    const p = run({ adapt: true, outlook: { state: 'winning', turns } });
    expect(p.rationale.join('\n')).toMatch(
      /Outlook \(#201\): winning for 3 turns running, so the game is decided — the strongest opponent's likely strength of 20 \(an estimate, not a bound\) over my income of 10 leaves ~3 turns/,
    );
    expect(skips(p)).toBe(true);
  });

  it('an explicit goal ignores the outlook', () => {
    const p = run({ goal: 'balanced', outlook: outlook('winning', 120, 10, 20) });
    expect(p.rationale.join('\n')).not.toMatch(/Outlook \(#201\)/);
  });

  it('a long game left keeps 10 turns', () => {
    const p = run({ adapt: true, outlook: outlook('winning', 1000, 200, 400) });
    expect(p.rationale.join('\n')).not.toMatch(/Outlook \(#201\)/);
  });
});

describe('#201: the strike stack reads the multi-turn forecast when no border can strike this turn', () => {
  // A 1v1 in contact. My 30 on T1 faces player 20's 60 on T2; my 25 on T3 faces its 26 on T4. Neither
  // border can take its neighbour this turn. Pressing every turn, T3 breaks T4 well before T1 could
  // break T2, so the strike stack goes to T3, not to the bigger T1.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5],
      [
        [1, 2],
        [3, 4],
        [1, 3],
        [2, 5],
        [4, 5],
      ],
      [],
    ),
  );
  const run = (noSplit = false) =>
    planTurn({
      graph: g,
      board: board([mine(1, 30), enemy(2, 60), mine(3, 25), enemy(4, 26), enemy(5, 1)]),
      me: ME,
      income: 12,
      settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true, ...(noSplit ? { noSplit: true } : {}) },
      game: { players: [{ id: ME }, { id: 20 }], turn: 8 },
      options: { adapt: true, enemyDeploy: 4 },
    });

  it('the border that breaks its front soonest gets the stack', () => {
    const p = run();
    const why = p.rationale.join('\n');
    expect(why).toMatch(/Strike stack on T3 \(#3\) \(#201\): no border can strike this turn; pressing every turn with the income, T3 \(#3\) breaks player 20's 26 on T4 \(#4\) on turn \d+ \(the multi-turn forecast\), sooner than T1 \(#1\)/);
    // T1 first takes its hold; the leftover goes to the strike stack on T3.
    expect(why).toMatch(/Deploy the leftover \d+ to T3 \(#3\): one strike stack/);
  });

  it('under No-Split the most armies still decide', () => {
    expect(run(true).rationale.join('\n')).not.toMatch(/\(#201\): no border can strike/);
  });
});
