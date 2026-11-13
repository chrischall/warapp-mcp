import { afterEach, describe, expect, it } from 'vitest';
import { OVERRIDES_UNPARSED } from '../src/analysis/overrides.js';
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
  it('with no arguments: the topics and every note\'s id, with no traffic (every note at once is a long read)', async () => {
    h = await harnessFor(game());
    const p = payload<{ scope: string; notes: Array<Record<string, unknown>>; topics: Array<{ topic: string; title: string; notes: number }>; next: string; map?: unknown }>(
      await h.call('warapp_strategy'),
    );
    expect(p.scope).toBe('general');
    // `notes` is always there (#168): here each entry is the id and topic alone, in the table's order.
    expect(p.notes).toEqual(STRATEGY_NOTES.map((n) => ({ id: n.id, topic: n.topic })));
    expect(p.topics.map((t) => t.topic)).toEqual(['format', 'settings', 'cards', 'reading', 'opening', 'timing', 'fighting', 'map']);
    expect(p.topics.reduce((n, t) => n + t.notes, 0)).toBe(STRATEGY_NOTES.length);
    expect(p.topics.every((t) => t.title.length > 0 && t.notes > 0)).toBe(true);
    expect(p.next).toMatch(/topic/);
    expect(JSON.stringify(p).length).toBeLessThan(8000);
    expect(p.map).toBeUndefined();
    expect(h.calls).toHaveLength(0);
  });

  it('with no arguments and view full: every general note, each with its source', async () => {
    h = await harnessFor(game());
    const p = payload<StrategyPayload>(await h.call('warapp_strategy', { view: 'full' }));
    expect(p.notes.map((n) => n.id)).toEqual(STRATEGY_NOTES.map((n) => n.id));
    expect(p.notes.every((n) => n.source.startsWith('https://'))).toBe(true);
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

  it('offers a card\'s notes only when that card is in the game, and gives the card clock', async () => {
    const settings = {
      NumberOfCardsToReceiveEachTurn: 2,
      ReinforcementCard: { NumPieces: 4, InitialPieces: 0, MinimumPiecesPerTurn: 1, Weight: 1, FixedArmies: 4 },
      BombCard: { NumPieces: 5, InitialPieces: 1, MinimumPiecesPerTurn: 1, Weight: 1 },
      OrderDelayCard: 'none',
      MoveOrder: 'Cycle',
      AutomaticTerritoryDistribution: 'Manual',
      AllowTransferOnly: true,
      Wastelands: { NumberOfWastelands: 2, WastelandSize: 10 },
    };
    h = await harnessFor(game({ settings }));
    const p = payload<StrategyPayload & { cardClock?: { piecesPerTurn: number; fixed: boolean; cards: Array<{ card: string; firstPlayableTurn: { fastest: number | null; guaranteed: number | null } }> } }>(
      await h.call('warapp_strategy', { game_id: GAME }),
    );
    const ids = p.notes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['cards-count-arrival', 'cards-bomb-hold', 'cards-opponent-reinforcement-due', 'timing-transfer-only-reinforce']));
    expect(ids).not.toContain('cards-order-delay');
    expect(ids).not.toContain('cards-airlift-defend');
    expect(ids).not.toContain('timing-attack-only-retake');
    // Every piece is a minimum, so the clock is exact: 4 pieces at 1 a turn is playable on turn 5.
    expect(p.cardClock).toMatchObject({ piecesPerTurn: 2, fixed: true });
    expect(p.cardClock!.cards).toEqual([
      expect.objectContaining({ card: 'Reinforcement', firstPlayableTurn: { fastest: 5, guaranteed: 5 } }),
      expect.objectContaining({ card: 'Bomb', firstPlayableTurn: { fastest: 5, guaranteed: 5 } }),
    ]);
    // One topic: the clock comes with the cards, not with the others.
    const timing = payload<StrategyPayload & { cardClock?: unknown }>(await h.call('warapp_strategy', { game_id: GAME, topic: 'timing' }));
    expect(timing.notes.every((n) => n.topic === 'timing')).toBe(true);
    expect(timing.cardClock).toBeUndefined();
    const cards = payload<StrategyPayload & { cardClock?: unknown }>(await h.call('warapp_strategy', { game_id: GAME, topic: 'cards' }));
    expect(cards.cardClock).toBeDefined();
  });

  it('a game without cards has no card clock, and a negative bonus on its map brings that note', async () => {
    h = await harnessFor(game());
    const p = payload<StrategyPayload & { cardClock?: unknown }>(await h.call('warapp_strategy', { game_id: GAME }));
    expect(p.cardClock).toBeUndefined();
    expect(p.notes.map((n) => n.id)).not.toContain('settings-negative-bonus');
    await h.harness.close();
    // The game overrides the first bonus to −3.
    const first = (MAP.bonuses as Array<{ id: string }>)[0]!;
    h = await harnessFor(game({ settings: { OverriddenBonuses: [{ bonusID: Number(first.id), value: -3 }] } }));
    const neg = payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME }));
    expect(neg.notes.map((n) => n.id)).toContain('settings-negative-bonus');
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

  it('a 20/80 game leaves out the defend-with-three note (its numbers are for 60/70)', async () => {
    h = await harnessFor(game({ settings: { OffensiveKillRate: 20, DefensiveKillRate: 80 } }));
    const ids = payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME })).notes.map((n) => n.id);
    expect(ids).not.toContain('settings-defend-with-three');
    await h.harness.close();
    h = await harnessFor(game());
    const dflt = payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME })).notes.map((n) => n.id);
    expect(dflt).toContain('settings-defend-with-three');
  });

  it('map notes say so when the game\'s bonus overrides could not be read', async () => {
    h = await harnessFor(game({ settings: { OverriddenBonuses: { House: 3 } } }));
    const p = payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME }));
    expect(p.map!.assumptions).toContain(OVERRIDES_UNPARSED);
  });

  it('an FFA with cards and luck selects those notes', async () => {
    h = await harnessFor(game({ players: 4, settings: { LuckModifier: 0.16, ReinforcementCard: { NumPieces: 4 } } }));
    const ids = payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME })).notes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['ffa-strike-last', 'cards-piece-each-turn', 'settings-luck-guaranteed']));
    expect(ids).not.toContain('1v1-break-bonuses');
  });

  it('in the picking stage the map notes carry income targets by turn, from the pickable territories', async () => {
    // Only Alpha's side (1-3) is pickable; Charlie (6-8), the best start on the bare map, is not.
    const standing = [1, 2, 3, 4, 5, 6, 7, 8].map((t) => ({
      terrID: String(t),
      ownedBy: t <= 3 ? 'AvailableForDistribution' : 'Neutral',
      armies: '2',
    }));
    h = await harnessFor(game({ state: 'DistributingTerritories', standing }));
    const p = payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME }));
    expect(p.profile!.phase).toBe('opening');
    expect(p.map!.incomeTargets!.map((t) => t.turn)).toEqual([1, 2, 3, 4]);
    expect(p.map!.incomeTargets![0]!.income).toBeGreaterThanOrEqual(5);
    expect(p.map!.incomeTargets!.some((t) => (t as { bonuses?: string[] }).bonuses?.includes('Charlie'))).toBe(false);
  });

  it('in the picking stage with no pickable territories in the feed: no income targets, and why (#132)', async () => {
    h = await harnessFor(game({ state: 'DistributingTerritories' }));
    const p = payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME }));
    expect(p.map!.incomeTargets).toBeUndefined();
    expect(p.map!.assumptions.join(' ')).toMatch(/warapp_plan_picks/);
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
