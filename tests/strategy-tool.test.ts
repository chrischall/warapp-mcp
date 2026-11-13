import { afterEach, describe, expect, it } from 'vitest';
import { STRATEGY_NOTES } from '../src/strategy/notes.js';
import { harnessFor, payload, textOf, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 4242;
const MAP_ID = 9001;

/** A synthetic map: a line 1 ─ … ─ 8; Alpha (+3) = 1, 2; Bravo (+2) = 3, 4, 5; Charlie (+5) = 6, 7, 8. */
const MAP = {
  id: String(MAP_ID),
  name: 'Test Line',
  territories: Array.from({ length: 8 }, (_, i) => i + 1).map((id) => ({
    id: String(id),
    name: `T${id}`,
    connectedTo: [id - 1, id + 1].filter((x) => x >= 1 && x <= 8),
  })),
  bonuses: [
    { id: '1', name: 'Alpha', value: '3', territoryIDs: [1, 2] },
    { id: '2', name: 'Bravo', value: '2', territoryIDs: [3, 4, 5] },
    { id: '3', name: 'Charlie', value: '5', territoryIDs: [6, 7, 8] },
  ],
  distributionModes: [],
};

function game(over: { state?: string; players?: number; settings?: Record<string, unknown>; standing?: unknown[] } = {}) {
  const n = over.players ?? 2;
  return {
    termsOfUse: 'synthetic',
    id: String(GAME),
    state: over.state ?? 'Playing',
    name: 'Test game',
    numberOfTurns: over.state === 'Playing' || over.state === undefined ? '4' : '-1',
    players: Array.from({ length: n }, (_, i) => ({
      id: String(1000 + i),
      name: `Player ${i + 1}`,
      isAI: 'False',
      humanTurnedIntoAI: 'False',
      hasCommittedOrders: 'False',
      state: 'Playing',
    })),
    settings: {
      Map: MAP_ID,
      Fog: 'Foggy',
      LuckModifier: 0,
      RoundingMode: 'StraightRound',
      OffensiveKillRate: 60,
      DefensiveKillRate: 70,
      MinimumArmyBonus: 5,
      InitialNonDistributionArmies: 2,
      TerritoryLimit: 2,
      LocalDeployments: false,
      NoSplit: false,
      Commanders: false,
      ...over.settings,
    },
    map: MAP,
    ...(over.standing ? { standing: over.standing } : {}),
  };
}

interface NoteView {
  id: string;
  topic: string;
  text: string;
  source: string;
  basis?: string;
  encoded?: string | null;
}
interface StrategyPayload {
  scope: 'general' | 'map' | 'game';
  game?: { id: number; name: string | null; state: string; turn: number | null };
  profile?: { format: string; phase: string; standing: string; settings?: Record<string, unknown> };
  notes: NoteView[];
  map?: {
    id: number;
    name: string;
    bonuses: Array<{ name: string; valuePerArmy: number; armiesToTake: number; entryPoints: unknown[] }>;
    chokepoints: Array<{ name: string }>;
    incomeTargets?: Array<{ turn: number; income: number }>;
    assumptions: string[];
  };
}

describe('warapp_strategy', () => {
  it('with no arguments: every general note, with no traffic', async () => {
    h = await harnessFor(game());
    const p = payload<StrategyPayload>(await h.call('warapp_strategy'));
    expect(p.scope).toBe('general');
    expect(p.notes.map((n) => n.id)).toEqual(STRATEGY_NOTES.map((n) => n.id));
    expect(p.notes.every((n) => n.source.startsWith('https://war.app/'))).toBe(true);
    expect(p.map).toBeUndefined();
    expect(h.calls).toHaveLength(0);
  });

  it('topic filters the general notes', async () => {
    h = await harnessFor(game());
    const p = payload<StrategyPayload>(await h.call('warapp_strategy', { topic: 'cards' }));
    expect(p.notes.length).toBeGreaterThan(0);
    expect(p.notes.every((n) => n.topic === 'cards')).toBe(true);
  });

  it('with a 1v1 game: the notes its profile selects, plus the map notes', async () => {
    h = await harnessFor(game());
    const p = payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME }));
    expect(p.scope).toBe('game');
    expect(p.game).toMatchObject({ id: GAME, state: 'Playing', turn: 5 });
    expect(p.profile).toMatchObject({ format: '1v1', standing: 'unknown' });
    const ids = p.notes.map((n) => n.id);
    expect(ids).toContain('1v1-break-bonuses');
    expect(ids.some((id) => id.startsWith('ffa-'))).toBe(false);
    expect(ids.some((id) => id.startsWith('cards-'))).toBe(false);
    expect(p.map!.name).toBe('Test Line');
    expect(p.map!.bonuses.map((b) => b.name)).toEqual(['Charlie', 'Alpha', 'Bravo']);
    expect(p.map!.chokepoints.length).toBeGreaterThan(0);
    expect(p.map!.incomeTargets).toBeUndefined();
    expect(h.calls).toHaveLength(1);
  });

  it('reads the GameFeed standing when the game has one: bordering the opponent is contact', async () => {
    const standing = [
      { terrID: '4', ownedBy: '1000', armies: '3', fogLevel: 'Visible' },
      { terrID: '5', ownedBy: '1001', armies: '3', fogLevel: 'Visible' },
    ];
    h = await harnessFor(game({ standing }));
    const withBoard = payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME }));
    expect(withBoard.profile!.phase).toBe('contact');
    await h.harness.close();
    h = await harnessFor(game());
    expect(payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME })).profile!.phase).toBe('expansion');
  });

  it('an FFA with cards and luck selects those notes', async () => {
    h = await harnessFor(game({ players: 4, settings: { LuckModifier: 0.16, ReinforcementCard: { NumPieces: 4 } } }));
    const ids = payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME })).notes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['ffa-strike-last', 'cards-piece-each-turn', 'settings-luck-guaranteed']));
    expect(ids).not.toContain('1v1-break-bonuses');
  });

  it('in the picking stage the map notes carry income targets by turn', async () => {
    h = await harnessFor(game({ state: 'DistributingTerritories' }));
    const p = payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME }));
    expect(p.profile!.phase).toBe('opening');
    expect(p.map!.incomeTargets!.map((t) => t.turn)).toEqual([1, 2, 3, 4]);
    expect(p.map!.incomeTargets![0]!.income).toBeGreaterThanOrEqual(5);
  });

  it('a topic other than map leaves the map notes out', async () => {
    h = await harnessFor(game());
    const p = payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME, topic: 'reading' }));
    expect(p.map).toBeUndefined();
    expect(p.notes.every((n) => n.topic === 'reading')).toBe(true);
  });

  it('full adds each note\'s basis and where it is encoded, and the whole profile', async () => {
    h = await harnessFor(game());
    const p = payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME, view: 'full' }));
    const sizes = p.notes.find((n) => n.id === 'settings-efficient-sizes')!;
    expect(sizes.basis).toBe('source');
    expect(sizes.encoded).toMatch(/planner/);
    expect(p.profile!.settings).toBeDefined();
  });

  it('a map id alone serves the map notes once that map is cached by a game', async () => {
    h = await harnessFor(game());
    await h.call('warapp_strategy', { game_id: GAME });
    const p = payload<StrategyPayload>(await h.call('warapp_strategy', { map_id: MAP_ID }));
    expect(p.scope).toBe('map');
    expect(p.map!.id).toBe(MAP_ID);
    expect(p.map!.bonuses[0]!.name).toBe('Charlie');
    expect(p.notes.every((n) => n.topic === 'map')).toBe(true);
    expect(h.calls).toHaveLength(1);
  });

  it('a map id not seen yet: a clear error, no traffic', async () => {
    h = await harnessFor(game());
    const r = await h.call('warapp_strategy', { map_id: 123 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/game_id/);
    expect(h.calls).toHaveLength(0);
  });

  it('a map id that is not the game\'s map is refused', async () => {
    h = await harnessFor(game());
    const r = await h.call('warapp_strategy', { game_id: GAME, map_id: 123 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/9001/);
  });
});

describe('warapp://strategy resources', () => {
  it('lists the general notes resource and serves it as markdown', async () => {
    h = await harnessFor(game());
    const list = await h.harness.client.listResources();
    expect(list.resources.map((r) => r.uri)).toContain('warapp://strategy');
    const r = await h.harness.client.readResource({ uri: 'warapp://strategy' });
    const c = r.contents[0] as { mimeType?: string; text: string };
    expect(c.mimeType).toBe('text/markdown');
    expect(c.text).toContain('`settings-efficient-sizes`');
    expect(c.text).toContain('https://war.app/wiki/Combat_Basics');
  });

  it('serves a cached map\'s notes at warapp://strategy/map/{mapId}', async () => {
    h = await harnessFor(game());
    const templates = await h.harness.client.listResourceTemplates();
    expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toContain('warapp://strategy/map/{mapId}');
    await h.call('warapp_strategy', { game_id: GAME });
    const r = await h.harness.client.readResource({ uri: `warapp://strategy/map/${MAP_ID}` });
    const text = (r.contents[0] as { text: string }).text;
    expect(text).toContain('Charlie');
    expect(text).toContain('Test Line');
  });

  it('an uncached map is an error naming the way out', async () => {
    h = await harnessFor(game());
    await expect(h.harness.client.readResource({ uri: 'warapp://strategy/map/5' })).rejects.toThrow(/warapp_strategy|game/);
  });
});
