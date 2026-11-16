// warapp_locate_opponents in an automatically distributed game (#328): the territories of the map's distribution
// mode the game dealt its starts among are the start candidates, read once from war.app's map details
// (GetMapDetails) and kept with the map. A synthetic map (made-up id, names and territories) and synthetic
// boards; nothing reaches war.app.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writePickable } from '../src/pick-list.js';
import { WarappBundle } from '../src/protocol/bundle.js';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { liveHarness, lobbyFixture, payload, type Harness } from './helpers.js';
import { CHAT_BUNDLE } from './protocol/chat-bundle.js';
import { LIVE_BUNDLE, writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';
import { MAP_DETAILS_BUNDLE, writeMapDetailsResult, type SyntheticMode } from './protocol/map-details-bundle.js';
import { MY_GAMES_BUNDLE } from './protocol/my-games-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
const MAP_ID = 900002;
// Synthetic GameFeed ids: the in-game id wrapped in two check digits each end.
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };
const ME = Number(ANN.feed);
const SIGNED_IN_ANN = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };

/** A line of eight territories, 1 – 2 – … – 8. */
const TERRITORIES = [1, 2, 3, 4, 5, 6, 7, 8];
/** Mode 2 deals starts among 1, 2, 5, 6, 7 and 8; mode 1 among all eight. */
const MODES: SyntheticMode[] = [
  { kind: 'normal', id: 1, territories: TERRITORIES },
  { kind: 'normal', id: 2, territories: [1, 2, 5, 6, 7, 8] },
];

/** A two-player game on turn `turn` of the synthetic map, two starts each, dealt automatically from mode 2. */
function game(turn = 1, settings: Record<string, unknown> = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const players = (f.players as Array<Record<string, string>>)
    .slice(0, 2)
    .map((p, i) => ({ ...p, id: [ANN, BOB][i]!.feed, name: ['Ann', 'Bob'][i]!, state: 'Playing' }));
  return {
    ...f,
    state: 'Playing',
    numberOfTurns: String(turn - 1),
    players,
    settings: {
      ...(f.settings as object),
      Map: MAP_ID,
      AutomaticTerritoryDistribution: 'Automatic',
      DistributionMode: 2,
      InitialPlayerArmiesPerTerritory: 5,
      TerritoryLimit: 2,
      OverriddenBonuses: [],
      ...settings,
    },
    map: {
      id: String(MAP_ID),
      name: 'Synthetic line',
      territories: TERRITORIES.map((id) => ({
        id: String(id),
        name: `Land ${id}`,
        connectedTo: [id - 1, id + 1].filter((n) => n >= 1 && n <= 8).map(String),
      })),
      bonuses: [{ id: '20', name: 'West', value: '2', territoryIDs: ['1', '2', '3'] }],
      distributionModes: [
        { id: '1', name: 'Mode one', type: 'normal' },
        { id: '2', name: 'Mode two', type: 'normal' },
      ],
    },
  };
}

const FOG: Omit<SyntheticTerritory, 'id'> = { fogLevel: 4, owner: -1, armies: 0, fogged: true };
/** Ann on 1 and 2, 3 a neutral in view, the rest fogged. */
const BOARD: SyntheticTerritory[] = [
  { id: 1, fogLevel: 1, owner: ANN.inGame, armies: 5 },
  { id: 2, fogLevel: 1, owner: ANN.inGame, armies: 5 },
  { id: 3, fogLevel: 2, owner: 0, armies: 2 },
  ...[4, 5, 6, 7, 8].map((id) => ({ id, ...FOG })),
];

const bundle = () => new WarappBundle(`${LIVE_BUNDLE}\n${MY_GAMES_BUNDLE}\n${CHAT_BUNDLE}\n${MAP_DETAILS_BUNDLE}`, 'test');

/** A fake war.app: the live board, and GetMapDetails answered by `details` (default the modes above); counts the map details asked. */
function warapp(details: (req: DecodedRequest) => Partial<ReplyFrame> = () => ({ body: (w) => writeMapDetailsResult(w, MODES) })) {
  const asked: number[] = [];
  const answer = (req: DecodedRequest): Partial<ReplyFrame> => {
    if (req.method === Method.GetLatestGameInfo) return { body: (w) => writeLatestGameInfo(w, BOARD, [ANN.inGame]) };
    if (req.method === Method.GetMapDetails) {
      asked.push(req.body.int32());
      return details(req);
    }
    throw new Error(`unexpected method ${req.method}`);
  };
  return { asked, answer };
}

interface Named {
  id: number;
  name: string;
}
interface WherePayload {
  opponents: Array<{
    player: Named;
    starts: { source: string; likely: Array<{ territory: Named; likelihood: number }>; ruledOut?: Named[]; unknown: number | null; method: string };
    presence: Array<{ territory: Named; likelihood: number; basis: string[] }>;
  }>;
  startCandidates: { source: string; count: number; mode?: { id: number; name: string | null } };
  warnings?: string[];
  assumptions?: string[];
}

const tmp = () => mkdtempSync(join(tmpdir(), 'warapp-mcp-where-mode-'));
const locate = async (hh: Harness, args: Record<string, unknown> = {}) =>
  payload<WherePayload>(await hh.call('warapp_locate_opponents', { game_id: GAME, player: 'Ann', ...args }));
const bob = (p: WherePayload) => p.opponents.find((o) => o.player.name === 'Bob')!;

describe('warapp_locate_opponents: a distribution mode (#328)', () => {
  it("guesses the starts among the mode's territories, less mine, with the basis named", async () => {
    const fake = warapp();
    h = await liveHarness({ feed: [game(1)], warapp: fake.answer, bundle: bundle(), dataDir: tmp() });
    const p = await locate(h, { view: 'full' });
    expect(fake.asked).toEqual([MAP_ID]);
    const o = bob(p);
    expect(o.starts).toMatchObject({ source: 'distribution-mode', unknown: 2, method: 'enumerated' });
    // 1 and 2 are mine; 3 and 4 are no starts of mode 2: two starts among 5, 6, 7 and 8.
    expect(o.starts.ruledOut!.map((t) => t.id)).toEqual([1, 2]);
    expect(o.starts.likely.map((s) => [s.territory.id, s.likelihood])).toEqual([
      [5, 0.5],
      [6, 0.5],
      [7, 0.5],
      [8, 0.5],
    ]);
    expect(o.presence.map((x) => x.territory.id)).toEqual(expect.arrayContaining([5, 6, 7, 8]));
    expect(p.assumptions!.join('\n')).toMatch(/the 6 territories of the map's distribution mode 2, which dealt the starts automatically/);
    expect(p.startCandidates).toMatchObject({ source: 'distribution-mode', count: 6, mode: { id: 2 } });
    expect(p.startCandidates.mode!.name).toBe('Mode two');
    expect(p).not.toHaveProperty('warnings');
  });

  it('reads the map details once per map: a second call asks no more', async () => {
    const fake = warapp();
    h = await liveHarness({ feed: [game(1)], warapp: fake.answer, bundle: bundle(), dataDir: tmp() });
    await locate(h);
    const again = await locate(h);
    expect(fake.asked).toEqual([MAP_ID]);
    expect(bob(again).starts.source).toBe('distribution-mode');
  });

  it("says so when the mode's territories are unknown, and guesses no start", async () => {
    const fake = warapp(() => ({ error: { code: 1, message: 'nope' } }));
    h = await liveHarness({ feed: [game(1)], warapp: fake.answer, bundle: bundle(), dataDir: tmp() });
    const p = await locate(h);
    expect(bob(p).starts).toMatchObject({ source: 'none', likely: [] });
    expect(p.startCandidates).toEqual({ source: 'none', count: 0 });
    expect(p.warnings!.join('\n')).toMatch(/dealt its starts automatically from the map's distribution mode 2, whose territories are unknown/);
    expect(p.warnings!.join('\n')).toMatch(/could not be read from war\.app's map details/);
  });

  it('a mode the reply lists no territories for is unknown too', async () => {
    const fake = warapp(() => ({ body: (w) => writeMapDetailsResult(w, [MODES[0]!, { kind: 'normal', id: 2, territories: null }]) }));
    h = await liveHarness({ feed: [game(1)], warapp: fake.answer, bundle: bundle(), dataDir: tmp() });
    const p = await locate(h);
    expect(bob(p).starts.source).toBe('none');
    expect(p.warnings!.join('\n')).toMatch(/distribution mode 2, whose territories are unknown/);
  });

  it('asks nothing in a game with manual picks, or one whose DistributionMode is no mode of the map', async () => {
    for (const settings of [{ AutomaticTerritoryDistribution: 'Manual' }, { DistributionMode: -1 }, { DistributionMode: 0 }]) {
      const fake = warapp();
      h = await liveHarness({ feed: [game(1, settings)], warapp: fake.answer, bundle: bundle(), dataDir: tmp() });
      const p = await locate(h);
      expect(fake.asked).toEqual([]);
      expect(bob(p).starts.source).toBe('none');
      expect(p).not.toHaveProperty('warnings');
      await h.harness.close();
      h = undefined;
    }
  });

  it('the kept pickable territories come first: the map details are not asked', async () => {
    const dir = tmp();
    await writePickable(dir, GAME, ME, [5, 6]);
    const fake = warapp();
    h = await liveHarness({ feed: [game(1)], warapp: fake.answer, bundle: bundle(), dataDir: dir, pages: SIGNED_IN_ANN });
    const p = await locate(h);
    expect(fake.asked).toEqual([]);
    expect(bob(p).starts.source).toBe('pickable');
  });
});
