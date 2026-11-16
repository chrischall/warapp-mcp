import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FetchproxyTimeoutError } from '@fetchproxy/server';
import { afterEach, describe, expect, it } from 'vitest';
import { OVERRIDES_UNPARSED } from '../src/analysis/overrides.js';
import { STRATEGY_NOTES } from '../src/strategy/notes.js';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { harnessFor, liveHarness, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';

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
  profile?: { format: string; phase: string; standing: string; source?: string; settings?: Record<string, unknown> };
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
    expect(p.topics.map((t) => t.topic)).toEqual(['format', 'settings', 'cards', 'reading', 'opening', 'timing', 'fighting', 'diplomacy', 'map']);
    expect(p.topics.reduce((n, t) => n + t.notes, 0)).toBe(STRATEGY_NOTES.length);
    expect(p.topics.every((t) => t.title.length > 0 && t.notes > 0)).toBe(true);
    expect(p.next).toMatch(/topic/);
    // An index of ids and topics, never the notes' text (up to 340 characters each): under 60 characters a
    // note, topics included (177 notes: ~10,200), so the bound grows with the table rather than a fixed cap.
    expect(JSON.stringify(p).length).toBeLessThan(60 * STRATEGY_NOTES.length);
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

// #309: with the signed-in account readable, the profile reads the live board for my seat, since
// GameFeed's board for a game in progress carries no standing. Made-up ids: the in-game id is the
// GameFeed id less two check digits each end.
describe('warapp_strategy reads the live board for my seat (#309)', () => {
  const ANN = { feed: '3312345644', inGame: 123456 };
  const BOB = { feed: '7176543229', inGame: 765432 };
  const CAT = { feed: '5523456788', inGame: 234567 };
  const SIGNED_IN = (feed: string) => ({ 'https://war.app/InviteToken': `<p>Your invite token is ${feed}</p>` });
  /** A fogged three-player free-for-all, Bob in the first seat and Ann (me) second. */
  const ffa = () => {
    const g = game({ players: 3 });
    const seats = [BOB, ANN, CAT];
    return { ...g, players: g.players.map((p, i) => ({ ...p, id: seats[i]!.feed })) };
  };
  // Ann holds 1 and 2; Bob's 9 armies on 3 can take 2: contact. The rest is fogged.
  const contactBoard: SyntheticTerritory[] = [
    { id: 1, fogLevel: 1, owner: ANN.inGame, armies: 3 },
    { id: 2, fogLevel: 1, owner: ANN.inGame, armies: 3 },
    { id: 3, fogLevel: 1, owner: BOB.inGame, armies: 9 },
    ...[4, 5, 6, 7, 8].map((id) => ({ id, fogLevel: 4, owner: -1, armies: 0, fogged: true })),
  ];
  const live = (territories: SyntheticTerritory[]) => (req: DecodedRequest): Partial<ReplyFrame> => {
    if (req.method !== Method.GetLatestGameInfo) throw new Error(`unexpected method ${req.method}`);
    return { body: (w) => writeLatestGameInfo(w, territories, [ANN.inGame]) };
  };
  const CONTACT_NOTES = ['fighting-contested-bonus-mass', 'reading-split-growth'];

  it('a fogged FFA at contact: the phase reads contact and the contact notes are served', async () => {
    h = await liveHarness({ feed: [ffa()], warapp: live(contactBoard), pages: SIGNED_IN(ANN.feed) });
    const p = payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME }));
    expect(p.profile).toMatchObject({ format: 'ffa', phase: 'contact', standing: 'unknown', source: 'live' });
    expect(p.notes.map((n) => n.id)).toEqual(expect.arrayContaining(CONTACT_NOTES));
    // One GameFeed read and one board read: nothing else.
    expect(h.calls).toHaveLength(1);
    expect(h.exchanges.map((x) => x.request.method)).toEqual([Method.GetLatestGameInfo]);
    // Read-only: no board cache, no game record.
    expect(existsSync(join(h.dataDir, 'boards'))).toBe(false);
    expect(existsSync(join(h.dataDir, 'games'))).toBe(false);
  });

  it('falls back to GameFeed when the board cannot be read, judged for my seat, with the source said', async () => {
    h = await liveHarness({
      feed: [ffa()],
      warapp: () => {
        throw new Error('war.app is down');
      },
      pages: SIGNED_IN(ANN.feed),
    });
    const p = payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME }));
    expect(p.profile).toMatchObject({ format: 'ffa', phase: 'expansion', source: 'gamefeed' });
    expect(p.notes.map((n) => n.id)).not.toContain('fighting-contested-bonus-mass');
    // The failure is said, not dropped: a short reason beside the GameFeed fallback.
    const reason = (p.profile as { liveError?: string }).liveError;
    expect(reason).toMatch(/war\.app is down/);
    expect(reason!.length).toBeLessThanOrEqual(200);
    expect(reason).not.toMatch(/frozen/);
  });

  it('a live board read that times out through a frozen tab says so in profile.liveError', async () => {
    h = await liveHarness({
      feed: [ffa()],
      warapp: () => {
        throw new FetchproxyTimeoutError({ url: 'https://war.app/Services?m=GetLatestGameInfo&js=1', timeoutMs: 30000, retrySafe: true });
      },
      pages: SIGNED_IN(ANN.feed),
    });
    const p = payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME, view: 'full' }));
    expect(p.profile).toMatchObject({ phase: 'expansion', source: 'gamefeed' });
    const reason = (p.profile as { liveError?: string }).liveError;
    expect(reason).toMatch(/30000ms/);
    expect(reason).toMatch(/Reload or focus a war\.app tab/);
  });

  it('without a readable account: no board read, the GameFeed profile exactly as before', async () => {
    h = await liveHarness({ feed: [ffa()], warapp: live(contactBoard) });
    const p = payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME, view: 'full' }));
    expect(p.profile).toMatchObject({ phase: 'expansion', source: 'gamefeed' });
    expect(p.profile).not.toHaveProperty('liveError');
    expect(h.exchanges).toHaveLength(0);
  });

  it('an account not seated in the game: no board read', async () => {
    h = await liveHarness({ feed: [ffa()], warapp: live(contactBoard), pages: SIGNED_IN('9912345699') });
    const p = payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME }));
    expect(p.profile).toMatchObject({ phase: 'expansion', source: 'gamefeed' });
    expect(h.exchanges).toHaveLength(0);
  });

  it('a signed-in seat that is out: no board read, judged as without an account (the two left are a 1v1)', async () => {
    const g = ffa();
    const out = { ...g, players: g.players.map((p) => (p.id === ANN.feed ? { ...p, state: 'Eliminated' } : p)) };
    h = await liveHarness({ feed: [out], warapp: live(contactBoard), pages: SIGNED_IN(ANN.feed) });
    const p = payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME, view: 'full' }));
    expect(p.profile).toMatchObject({ format: '1v1', source: 'gamefeed' });
    expect(h.exchanges).toHaveLength(0);
    // Exactly the profile served with no readable account.
    const anon = await liveHarness({ feed: [out], warapp: live(contactBoard) });
    try {
      const q = payload<StrategyPayload>(await anon.call('warapp_strategy', { game_id: GAME, view: 'full' }));
      expect(p.profile).toEqual(q.profile);
    } finally {
      await anon.harness.close();
    }
  });

  it("warapp_plan_turn's full view lists the ids of the notes its own profile matches; compact does not", async () => {
    h = await liveHarness({ feed: [ffa()], warapp: live(contactBoard), pages: SIGNED_IN(ANN.feed) });
    const full = payload<{ profile: { phase: string }; notes?: string[] }>(
      await h.call('warapp_plan_turn', { game_id: GAME, view: 'full' }),
    );
    expect(full.profile.phase).toBe('contact');
    expect(full.notes).toEqual(expect.arrayContaining(CONTACT_NOTES));
    expect(full.notes!.every((id) => STRATEGY_NOTES.some((n) => n.id === id))).toBe(true);
    // The same ids warapp_strategy serves on this board, in the table's order.
    const strategy = payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME }));
    expect(full.notes).toEqual(STRATEGY_NOTES.map((n) => n.id).filter((id) => full.notes!.includes(id)));
    expect(strategy.notes.map((n) => n.id)).toEqual(expect.arrayContaining(CONTACT_NOTES));
    const compact = payload<{ notes?: unknown }>(await h.call('warapp_plan_turn', { game_id: GAME }));
    expect(compact.notes).toBeUndefined();
  });

  it('in the picking stage: no board read (the phase is the opening either way)', async () => {
    const g = { ...ffa(), state: 'DistributingTerritories', numberOfTurns: '-1' };
    h = await liveHarness({ feed: [g], warapp: live(contactBoard), pages: SIGNED_IN(ANN.feed) });
    const p = payload<StrategyPayload>(await h.call('warapp_strategy', { game_id: GAME }));
    expect(p.profile).toMatchObject({ phase: 'opening', source: 'gamefeed' });
    expect(h.exchanges).toHaveLength(0);
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
