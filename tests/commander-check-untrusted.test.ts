// #275 review with #274: the one commander check sizes an untrusted opponent's reply at the figure its
// tripwire gave it (`untrustedDeploy`), as warapp_check_plan's stress test does, never only at the larger
// of its estimate and my income: one answer must not list a reply that kills the commander at deploy 61
// while its commander block calls the commander safe. Synthetic map and ids only.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../src/board.js';
import { buildGraph } from '../src/analysis/graph.js';
import type { GameMap } from '../src/normalize.js';
import { commanderCheckOn } from '../src/tools/commander-check.js';
import type { stressOpponents } from '../src/tools/stress-opponents.js';
import { board, mine } from './analysis/helpers.js';

const ME = 10;
const FOE = 20;
const STD = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const MAP: GameMap = {
  id: 1,
  name: 'Pair',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2] },
    { id: 2, name: 'T2', connectedTo: [1] },
  ],
  bonuses: [],
  distributionModes: [],
};
const withCommander = (t: TerritoryState): TerritoryState => ({ ...t, specialUnits: [{ kind: 'commander', id: 'c', playerId: ME }] });
// My commander on 1 with 30 armies; its 1 on 2. Estimate 5, my income 40: 39 attackers do not take 30 + 7;
// 61 + 0 movable do.
const so = {
  board: board([withCommander(mine(1, 30)), mine(2, 1, FOE)]),
  opponents: [{ id: FOE, deploy: 5, base: 5 }],
  estimateOf: () => 5,
  teams: new Map<number, number>(),
  leader: false,
} as unknown as ReturnType<typeof stressOpponents>;
const check = (untrusted?: ReadonlyMap<number, number>) =>
  commanderCheckOn({
    graph: buildGraph(MAP),
    me: ME,
    settings: STD,
    so,
    income: 40,
    deploys: [],
    moves: [],
    orderPriority: false,
    ...(untrusted ? { untrusted } : {}),
  })!;

describe('commanderCheckOn with an untrusted opponent (#275 review)', () => {
  it('is safe at the larger of the estimate and my income', () => {
    const c = check();
    expect(c.replyDeploy).toBe(40);
    expect(c.risk).toBeUndefined();
  });

  it('sizes the untrusted opponent at the figure that tripped it, and says so', () => {
    const c = check(new Map([[FOE, 61]]));
    expect(c.replyDeploy).toBe(61);
    expect(c.risk).toMatchObject({ territory: 1, replyDeploy: 61 });
    expect(c.text).toMatch(/single deploy of 61 by player 20/);
    expect(c.text).toMatch(/its untrusted figure 61 \(#275\)/);
  });

  it('never sizes it below my income: an untrusted figure under it changes nothing', () => {
    const c = check(new Map([[FOE, 12]]));
    expect(c.replyDeploy).toBe(40);
    expect(c.risk).toBeUndefined();
  });
});
