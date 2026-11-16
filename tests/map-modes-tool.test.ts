// warapp_get_map's distribution modes (#328): each mode's starting territories, read lazily from war.app's map
// details (GetMapDetails, method 73) through the bridge, decoded by the synthetic bundle's readers, kept with the
// map in the store. Synthetic map (made-up id and names); nothing reaches war.app.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FetchproxyTimeoutError } from '@fetchproxy/server';
import { afterEach, describe, expect, it } from 'vitest';
import { mapStorePath } from '../src/map-store.js';
import { WarappBundle } from '../src/protocol/bundle.js';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { FROZEN_TAB_HINT } from '../src/tools/live-context.js';
import { liveHarness, lobbyFixture, payload, type Harness } from './helpers.js';
import { CHAT_BUNDLE } from './protocol/chat-bundle.js';
import { LIVE_BUNDLE } from './protocol/live-bundle.js';
import { MAP_DETAILS_BUNDLE, writeMapDetailsResult, type SyntheticMode } from './protocol/map-details-bundle.js';
import { MY_GAMES_BUNDLE } from './protocol/my-games-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const MAP_ID = 900001;
const GAME = 12345678;

/** The lobby fixture's game on a small synthetic map with three modes. */
function feed(): Record<string, unknown> {
  const f = lobbyFixture();
  return {
    ...f,
    map: {
      id: String(MAP_ID),
      name: 'Synthetic map',
      territories: [1, 2, 3, 4, 5].map((id) => ({ id: String(id), name: `Land ${id}`, connectedTo: [] })),
      bonuses: [{ id: '1', name: 'All', value: '2', territoryIDs: ['1', '2', '3', '4', '5'] }],
      distributionModes: [
        { id: '1', name: 'Mode one', type: 'normal' },
        { id: '2', name: 'Mode two', type: 'normal' },
        { id: '3', name: 'Mode three', type: 'scenario' },
      ],
    },
  };
}

const MODES: SyntheticMode[] = [
  { kind: 'normal', id: 1, territories: [1, 2, 3, 77] },
  { kind: 'normal', id: 2, territories: null },
  { kind: 'scenario', id: 3, territories: [[4, 0], [5, 1]] },
];

const bundle = () => new WarappBundle(`${LIVE_BUNDLE}\n${MY_GAMES_BUNDLE}\n${CHAT_BUNDLE}\n${MAP_DETAILS_BUNDLE}`, 'test');

/** A fake war.app answering GetMapDetails with `reply` (default the modes above), counting the requests and their map ids. */
function warapp(reply: (w: Parameters<NonNullable<ReplyFrame['body']>>[0]) => void = (w) => writeMapDetailsResult(w, MODES)) {
  const asked: number[] = [];
  const answer = (req: DecodedRequest): Partial<ReplyFrame> => {
    if (req.method !== Method.GetMapDetails) throw new Error(`unexpected method ${req.method}`);
    asked.push(req.body.int32());
    return { body: reply };
  };
  return { asked, answer };
}

type Mode = { id: number; name: string; type?: string; territoryCount: number | null; territories: number[] | null };

describe('warapp_get_map: distribution modes (#328)', () => {
  it("full: each mode's territory count and ids, read once and kept with the map", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'warapp-modes-'));
    const fake = warapp();
    h = await liveHarness({ feed: [feed()], warapp: fake.answer, bundle: bundle(), dataDir });
    const p = payload(await h.call('warapp_get_map', { game_id: GAME, view: 'full' }));
    expect(fake.asked).toEqual([MAP_ID]);
    expect(p.distributionModes as Mode[]).toEqual([
      { id: 1, name: 'Mode one', type: 'normal', territoryCount: 3, territories: [1, 2, 3] },
      { id: 2, name: 'Mode two', type: 'normal', territoryCount: null, territories: null },
      { id: 3, name: 'Mode three', type: 'scenario', territoryCount: 2, territories: [4, 5] },
    ]);
    expect(p.warnings).toEqual([
      `Distribution mode 1: 1 territory id war.app listed is not a territory of map ${MAP_ID} and was dropped (77).`,
      expect.stringMatching(/^The starting territories of map 900001's distribution modes could not be read .*none listed for mode 2/),
    ]);
    // Kept with the map: a mode read is stored, a mode left unknown is not (it reads as not read yet).
    const stored = JSON.parse(readFileSync(mapStorePath(dataDir, MAP_ID), 'utf8'));
    expect(stored.map.distributionModes.map((d: { territories?: unknown }) => d.territories)).toEqual([[1, 2, 3], undefined, [4, 5]]);
    // A second call this process asks no more: the unknown mode was tried once.
    const again = payload(await h.call('warapp_get_map', { game_id: GAME, view: 'full' }));
    expect(fake.asked).toEqual([MAP_ID]);
    expect((again.distributionModes as Mode[]).map((d) => d.territoryCount)).toEqual([3, null, 2]);
  });

  it('a restart reads them from the store without asking war.app, when every mode is known', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'warapp-modes-'));
    const all: SyntheticMode[] = [MODES[0]!, { kind: 'normal', id: 2, territories: [5] }, MODES[2]!];
    const first = warapp((w) => writeMapDetailsResult(w, all));
    h = await liveHarness({ feed: [feed()], warapp: first.answer, bundle: bundle(), dataDir });
    await h.call('warapp_get_map', { game_id: GAME, view: 'full' });
    await h.harness.close();
    const second = warapp();
    h = await liveHarness({ feed: [feed(), { ...feed(), map: {} }], warapp: second.answer, bundle: bundle(), dataDir });
    const p = payload(await h.call('warapp_get_map', { game_id: GAME, view: 'full' }));
    expect(second.asked).toEqual([]);
    expect((p.distributionModes as Mode[]).map((d) => d.territories)).toEqual([[1, 2, 3], [5], [4, 5]]);
    expect(p).not.toHaveProperty('warnings');
  });

  it('a failed read leaves every mode unknown (null, never []) with a warning, and is not retried this process', async () => {
    const fake = warapp();
    const failing = (req: DecodedRequest): Partial<ReplyFrame> => {
      fake.answer(req);
      return { error: { code: 1, message: 'nope' } };
    };
    h = await liveHarness({ feed: [feed()], warapp: failing, bundle: bundle() });
    const p = payload(await h.call('warapp_get_map', { game_id: GAME, view: 'full' }));
    expect((p.distributionModes as Mode[]).map((d) => [d.territoryCount, d.territories])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
    expect((p.warnings as string[]).join('\n')).toMatch(/could not be read from war\.app's map details/);
    await h.call('warapp_get_map', { game_id: GAME, view: 'full' });
    expect(fake.asked).toEqual([MAP_ID]);
  });

  it('a bridged timeout (a frozen tab) says to reload or focus the war.app tab, once', async () => {
    const fake = warapp();
    const timingOut = (req: DecodedRequest): Partial<ReplyFrame> => {
      fake.answer(req);
      throw new FetchproxyTimeoutError({ url: 'https://war.app/Services?m=GetMapDetails&js=1', timeoutMs: 30000, retrySafe: true });
    };
    h = await liveHarness({ feed: [feed()], warapp: timingOut, bundle: bundle() });
    const p = payload(await h.call('warapp_get_map', { game_id: GAME, view: 'full' }));
    const why = (p.warnings as string[]).join('\n');
    expect(why).toMatch(/could not be read from war\.app's map details/);
    expect(why.split(FROZEN_TAB_HINT)).toHaveLength(2);
    expect(fake.asked).toEqual([MAP_ID]);
  });

  it('no result leaves the modes unknown', async () => {
    const fake = warapp((w) => w.bool(false));
    h = await liveHarness({ feed: [feed()], warapp: fake.answer, bundle: bundle() });
    const p = payload(await h.call('warapp_get_map', { game_id: GAME, view: 'full' }));
    expect((p.distributionModes as Mode[]).every((d) => d.territories === null && d.territoryCount === null)).toBe(true);
    expect((p.warnings as string[]).join('\n')).toMatch(/no result/);
  });

  it('compact and a bonus filter neither ask war.app nor list the modes', async () => {
    const fake = warapp();
    h = await liveHarness({ feed: [feed()], warapp: fake.answer, bundle: bundle() });
    expect(payload(await h.call('warapp_get_map', { game_id: GAME }))).not.toHaveProperty('distributionModes');
    expect(payload(await h.call('warapp_get_map', { game_id: GAME, view: 'full', bonus: 'all' }))).not.toHaveProperty('distributionModes');
    expect(fake.asked).toEqual([]);
  });

  it('a map with no modes asks nothing and lists none', async () => {
    const fake = warapp();
    const f = feed();
    h = await liveHarness({ feed: [{ ...f, map: { ...(f.map as object), distributionModes: [] } }], warapp: fake.answer, bundle: bundle() });
    const p = payload(await h.call('warapp_get_map', { game_id: GAME, view: 'full' }));
    expect(p.distributionModes).toEqual([]);
    expect(fake.asked).toEqual([]);
  });
});
