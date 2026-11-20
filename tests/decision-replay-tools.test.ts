// #412 task 4's INVARIANT end to end: a turn warapp_plan_turn logged (Task 2's capture), replayed offline
// from the data dir alone (the decision log, the game record and the map store) with unchanged code and
// no scenario, gives the logged deploys and moves. Synthetic ids; the players' names only prove none is kept.
import { afterEach, describe, expect, it } from 'vitest';
import { replayAggregate, replayDecisions } from '../src/analysis/decision-replay.js';
import { readDecisionLog } from '../src/decision-log.js';
import { Method } from '../src/protocol/methods.js';
import { loadReplay } from '../src/replay.js';
import { liveHarness, lobbyFixture, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };

function game(numberOfTurns: string): Record<string, unknown> {
  const f = lobbyFixture();
  const players = (f.players as Array<Record<string, string>>).map((p, i) =>
    i === 0 ? { ...p, id: ANN.feed, name: 'Ann' } : i === 1 ? { ...p, id: BOB.feed, name: 'Bob' } : p,
  );
  return { ...f, state: 'Playing', numberOfTurns, players };
}

const BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 157, fogLevel: 2, owner: 0, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 7 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];

describe('decision replay from the data dir (#412 task 4)', () => {
  it('INVARIANT: the turn warapp_plan_turn logged replays to the logged deploys and moves', async () => {
    h = await liveHarness({
      feed: [game('2')],
      warapp: (req) => {
        if (req.method === Method.GetLatestGameInfo) return { body: (w) => writeLatestGameInfo(w, BOARD, [ANN.inGame]) };
        throw new Error(`unexpected method ${req.method}`);
      },
    });
    await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' });
    const log = (await readDecisionLog(h.dataDir, GAME))!;
    expect(log.turns['3']?.kind).toBe('planned');
    const replay = (await loadReplay(h.dataDir, GAME))!;
    expect(replay.map).toBeDefined();
    const r = replayDecisions(log, replay);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]).toMatchObject({ turn: 3, status: 'compared', same: true });
    expect(r.turns[0]!.goal.replayed).toBe(r.turns[0]!.goal.logged);
    expect(replayAggregate([r])).toMatchObject({ compared: 1, identical: 1 });
    // A scenario changes it.
    expect(replayDecisions(log, replay, { goal: 'defend', enemyDeploy: 50 }).turns[0]!.goal.replayed).toBe('defend');
  });
});
