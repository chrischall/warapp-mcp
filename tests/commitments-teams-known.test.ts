// #275: the plan warapp_send_chat checks a promise against is the plan warapp_plan_turn makes. While the
// teams of a 3+ seat game cannot be read (an opponent may be a teammate), warapp_plan_turn reads no
// broken-estimate tripwire, so the promise check must not either. readTripwires is wrapped to record what
// each call was told. Every id and name here is made up; no war.app traffic.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { liveHarness, type Harness } from './helpers.js';
import * as T from './team-fallback.js';

const seen = vi.hoisted(() => [] as Array<boolean | undefined>);
vi.mock('../src/tools/survival.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tools/survival.js')>();
  return {
    ...orig,
    readTripwires: (a: Parameters<typeof orig.readTripwires>[0]) => {
      seen.push(a.teamsKnown);
      return orig.readTripwires(a);
    },
  };
});

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
  seen.length = 0;
});

const promise = (player: string) =>
  h!.call('warapp_send_chat', { game_id: T.TEAM_GAME, message: 'a message', commitments: [{ kind: 'no-attack', player, turns: 1 }] });

describe('warapp_send_chat commitments and the teams (#275)', () => {
  it('teams unknown (no team in GameFeed, the game list unreadable): the plan checked reads no tripwire, as warapp_plan_turn\'s does not', async () => {
    h = await liveHarness({ feed: [T.teamGame()], pages: T.SIGNED_IN_ANN, warapp: T.teamServer('fail') });
    await promise('Cy');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((k) => k === false)).toBe(true);
  });

  it('teams known (GameFeed sends them): the tripwire is read (the control)', async () => {
    h = await liveHarness({ feed: [T.teamGame({ teams: true })], pages: T.SIGNED_IN_ANN, warapp: T.teamServer('fail') });
    await promise('Cy');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((k) => k !== false)).toBe(true);
  });
});
