// The facts a calling model needs to plan a turn on its own (#606): the board in view, every bonus that matters
// with who holds what of it and what finishing it costs, each opponent's strength with how sure the estimate is,
// what changed since last turn, and each earlier turn this server kept. Reported only, never judged: no rule here picks anything, and no plan reads it.
// Pure and deterministic (ties on ascending id).
import type { BoardState, TerritoryState } from '../board.js';
import { bonusTerritories } from './bonuses.js';
import { armiesToTake } from './combat.js';
import { neighborsOf, type MapGraph } from './graph.js';
import type { IncomePoint } from './income-trend.js';
import type { TurnBoard } from './opponents.js';

/** The most territories listed (a huge map lists the ones nearest my land first). */
export const MAX_SITUATION_TERRITORIES = 400;
/** The most bonuses listed. */
export const MAX_SITUATION_BONUSES = 60;
/** The most earlier turns summarised (the newest). */
export const SITUATION_PAST_TURNS = 10;

/** An opponent's strength as the plan reads it. */
export interface SituationOpponentInput {
  playerId: number;
  /** Its deploy estimate this turn (what the plan sizes threats with). */
  estimate: number;
  /** Where the estimate came from (`visible`, `observed`, `tracked`, `prior`, `exact`, or a caller's word). */
  source?: string;
  /** What it visibly earns on this board: its base plus the bonuses it visibly holds in full. */
  visibleIncome?: number;
  /** Its tracked income (`null`: no usable track). */
  tracked?: number | null;
  /** While its frontier is thinly read: the range the estimate was chosen in. */
  range?: { low: number; high: number } | null;
  /** The share of its frontier its tracked turns were read from (0–1; `null` unmeasured). */
  coverage?: number | null;
  /** Its observed deploy on each tracked turn, oldest first. */
  history?: readonly { turn: number; observed: number }[];
}

export interface SituationInput {
  graph: MapGraph;
  board: BoardState;
  /** The board at the start of last turn, when one is kept. */
  previousBoard?: BoardState;
  me: number;
  /** Teammates (never opponents, listed by id). */
  friends?: ReadonlySet<number>;
  rates: { offensiveKillRate?: number; defensiveKillRate?: number };
  /** One army must stand guard (default true). */
  guard?: boolean;
  /** My deploy this turn (card armies included). */
  myIncome: number;
  /** My income on earlier turns, oldest first. */
  incomeHistory?: readonly IncomePoint[];
  opponents: readonly SituationOpponentInput[];
  /** Earlier boards this server kept for the game (with my orders that turn, when known), any order. */
  pastBoards?: readonly TurnBoard[];
}

/** `me`, `neutral`, a player's GameFeed id, or `fog` (owner hidden). */
export type Owner = 'me' | 'neutral' | 'fog' | number;

export interface SituationTerritory {
  id: number;
  name: string;
  owner: Owner;
  /** `null`: hidden. */
  armies: number | null;
  /** Special units on it (a commander fights as 7), by kind and owner. */
  units?: { kind: string; owner: Owner }[];
  /** Hops to my nearest territory (0: mine). */
  distance: number;
  bonuses: number[];
  neighbors: number[];
}

export interface SituationBonus {
  bonusId: number;
  name: string;
  value: number;
  size: number;
  mine: number;
  neutral: number;
  fogged: number;
  /** Members each other player visibly holds. */
  players: { player: number; count: number }[];
  /** Who holds every member (in view): `me`, a player, or `null`. */
  heldBy: 'me' | number | null;
  /** The members I do not hold. */
  missing: number[];
  /**
   * The attackers it takes to capture every missing member as it stands (each on its own), `null` when a missing
   * member's armies are hidden; 0 when I hold it.
   */
  armiesToFinish: number | null;
  /** The missing members beside my land. */
  reachable: number[];
}

export interface SituationOpponent {
  player: number;
  income: {
    estimate: number;
    source?: string;
    visible?: number;
    tracked?: number | null;
    range?: { low: number; high: number } | null;
    coverage?: number | null;
  };
  history?: { turn: number; observed: number }[];
  territoriesInView: number;
  armiesInView: number;
  /** Bonuses it visibly holds in full. */
  bonusesHeld: { bonusId: number; value: number }[];
  /** Its stacks beside my land: territory, armies, and the territories of mine each borders. */
  besideMe: { territoryId: number; armies: number; borders: number[] }[];
  /** Its movable armies beside my land, summed. */
  movableBesideMe: number;
}

export interface SituationChanges {
  /** Territories of mine last turn that another owner holds now (`fog`: I no longer see who). */
  lost: { territoryId: number; to: Owner }[];
  /** Territories I hold now that another owner held last turn. */
  gained: { territoryId: number; from: Owner }[];
  /** Other players' stacks in view on both boards whose armies changed, largest change first. */
  moved: { territoryId: number; owner: number; was: number; now: number }[];
}

/** One earlier turn as this server saw it: each side's land and armies in view, and my orders when kept. */
export interface SituationPastTurn {
  turn: number;
  sides: { owner: 'me' | number; territories: number; armies: number; bonusesHeld: number[] }[];
  /** My deploys and moves that turn, when this server sent or read them. */
  myOrders?: { deploys: { territoryId: number; armies: number }[]; moves: { from: number; to: number; armies: number }[] };
}

export interface Situation {
  me: {
    income: number;
    incomeHistory: IncomePoint[];
    territories: number;
    armies: number;
    bonusesHeld: { bonusId: number; value: number }[];
  };
  territories: SituationTerritory[];
  /** Territories in view beyond {@link MAX_SITUATION_TERRITORIES}, not listed. */
  territoriesOmitted: number;
  bonuses: SituationBonus[];
  bonusesOmitted: number;
  opponents: SituationOpponent[];
  /** `null`: no board kept from last turn. */
  changes: SituationChanges | null;
  /** The newest {@link SITUATION_PAST_TURNS} earlier boards kept, oldest first (whole boards: warapp_turn_history). */
  past: SituationPastTurn[];
}

const ownerOf = (t: TerritoryState | undefined, me: number): Owner => {
  if (!t || t.owner.kind === 'unknown') return 'fog';
  if (t.owner.kind !== 'player') return 'neutral';
  return t.owner.playerId === me ? 'me' : t.owner.playerId;
};

/** The facts on this board (see the file header). */
export function situation(input: SituationInput): Situation {
  const { graph: g, board, me } = input;
  const guard = input.guard === false ? 0 : 1;
  const state = new Map(board.territories.map((t) => [t.territoryId, t]));
  const owner = (id: number) => ownerOf(state.get(id), me);
  const armiesOf = (id: number) => state.get(id)?.armies ?? null;
  const mine = [...state.keys()].filter((id) => owner(id) === 'me').sort((a, b) => a - b);
  const mineSet = new Set(mine);
  const take = (n: number) => armiesToTake(n, input.rates);

  // Hops from my land, through any territory.
  const dist = new Map<number, number>(mine.map((m) => [m, 0]));
  let frontier = mine;
  while (frontier.length) {
    const next: number[] = [];
    for (const t of frontier)
      for (const n of neighborsOf(g, t))
        if (!dist.has(n)) {
          dist.set(n, dist.get(t)! + 1);
          next.push(n);
        }
    frontier = next;
  }

  const bonusesOf = new Map<number, number[]>();
  for (const b of g.map.bonuses) for (const t of bonusTerritories(g, b.id)) bonusesOf.set(t, [...(bonusesOf.get(t) ?? []), b.id]);

  // Every territory in view, plus every hidden one beside my land; nearest first.
  const listed = [...g.territoryById.keys()]
    .filter((id) => owner(id) !== 'fog' || neighborsOf(g, id).some((n) => mineSet.has(n)))
    .sort((a, b) => (dist.get(a) ?? Infinity) - (dist.get(b) ?? Infinity) || a - b);
  const territories: SituationTerritory[] = listed.slice(0, MAX_SITUATION_TERRITORIES).map((id) => {
    const t = state.get(id);
    const units = t?.specialUnits?.map((u) => ({ kind: u.kind, owner: u.playerId === me ? ('me' as const) : u.playerId }));
    return {
      id,
      name: g.territoryById.get(id)?.name ?? String(id),
      owner: owner(id),
      armies: armiesOf(id),
      ...(units?.length ? { units } : {}),
      distance: dist.get(id) ?? -1,
      bonuses: bonusesOf.get(id) ?? [],
      neighbors: [...neighborsOf(g, id)],
    };
  });

  // Every positive bonus I touch, that is beside my land, or that another player visibly holds in full.
  const bonuses: SituationBonus[] = [];
  for (const b of g.map.bonuses) {
    if (b.value <= 0) continue;
    const members = bonusTerritories(g, b.id);
    let mineN = 0;
    let neutral = 0;
    let fogged = 0;
    const players = new Map<number, number>();
    for (const t of members) {
      const o = owner(t);
      if (o === 'me') mineN++;
      else if (o === 'neutral') neutral++;
      else if (o === 'fog') fogged++;
      else players.set(o, (players.get(o) ?? 0) + 1);
    }
    const heldBy: 'me' | number | null =
      mineN === members.length ? 'me' : players.size === 1 && [...players.values()][0] === members.length ? [...players.keys()][0]! : null;
    const near = members.some((t) => (dist.get(t) ?? Infinity) <= 1);
    if (!near && heldBy === null) continue;
    const missing = members.filter((t) => owner(t) !== 'me');
    const hidden = missing.some((t) => armiesOf(t) === null);
    bonuses.push({
      bonusId: b.id,
      name: b.name,
      value: b.value,
      size: members.length,
      mine: mineN,
      neutral,
      fogged,
      players: [...players].sort((x, y) => x[0] - y[0]).map(([player, count]) => ({ player, count })),
      heldBy,
      missing,
      armiesToFinish: hidden ? null : missing.reduce((n, t) => n + (take(armiesOf(t)!) ?? Infinity), 0),
      reachable: missing.filter((t) => neighborsOf(g, t).some((n) => mineSet.has(n))),
    });
  }
  // Mine first, then the nearest to done (fewest missing), then the most valuable.
  bonuses.sort(
    (a, b) =>
      Number(b.heldBy === 'me') - Number(a.heldBy === 'me') ||
      a.missing.length - b.missing.length ||
      b.value - a.value ||
      a.bonusId - b.bonusId,
  );

  const opponents: SituationOpponent[] = [...input.opponents]
    .filter((o) => o.playerId !== me && !input.friends?.has(o.playerId))
    .sort((a, b) => a.playerId - b.playerId)
    .map((o) => {
      const theirs = [...state.keys()].filter((id) => owner(id) === o.playerId);
      const besideMe = theirs
        .filter((id) => neighborsOf(g, id).some((n) => mineSet.has(n)))
        .map((id) => ({ territoryId: id, armies: armiesOf(id) ?? 0, borders: neighborsOf(g, id).filter((n) => mineSet.has(n)) }));
      return {
        player: o.playerId,
        income: {
          estimate: o.estimate,
          ...(o.source !== undefined ? { source: o.source } : {}),
          ...(o.visibleIncome !== undefined ? { visible: o.visibleIncome } : {}),
          ...(o.tracked !== undefined ? { tracked: o.tracked } : {}),
          ...(o.range !== undefined ? { range: o.range } : {}),
          ...(o.coverage !== undefined ? { coverage: o.coverage } : {}),
        },
        ...(o.history?.length ? { history: o.history.map((h) => ({ turn: h.turn, observed: h.observed })) } : {}),
        territoriesInView: theirs.length,
        armiesInView: theirs.reduce((n, id) => n + (armiesOf(id) ?? 0), 0),
        bonusesHeld: bonuses.filter((b) => b.heldBy === o.playerId).map((b) => ({ bonusId: b.bonusId, value: b.value })),
        besideMe,
        movableBesideMe: besideMe.reduce((n, s) => n + Math.max(0, s.armies - guard), 0),
      };
    });

  let changes: SituationChanges | null = null;
  if (input.previousBoard) {
    const prev = new Map(input.previousBoard.territories.map((t) => [t.territoryId, t]));
    const was = (id: number) => ownerOf(prev.get(id), me);
    const lost: SituationChanges['lost'] = [];
    const gained: SituationChanges['gained'] = [];
    const moved: SituationChanges['moved'] = [];
    for (const id of [...new Set([...prev.keys(), ...state.keys()])].sort((a, b) => a - b)) {
      const before = was(id);
      const now = owner(id);
      if (before === 'me' && now !== 'me') lost.push({ territoryId: id, to: now });
      else if (now === 'me' && before !== 'me') gained.push({ territoryId: id, from: before });
      else if (typeof now === 'number' && before === now) {
        const a = prev.get(id)?.armies;
        const b = armiesOf(id);
        if (a !== null && a !== undefined && b !== null && a !== b) moved.push({ territoryId: id, owner: now, was: a, now: b });
      }
    }
    moved.sort((x, y) => Math.abs(y.now - y.was) - Math.abs(x.now - x.was) || x.territoryId - y.territoryId);
    changes = { lost, gained, moved: moved.slice(0, MAX_SITUATION_BONUSES) };
  }

  const past: SituationPastTurn[] = [...(input.pastBoards ?? [])]
    .sort((a, b) => a.turn - b.turn)
    .slice(-SITUATION_PAST_TURNS)
    .map((p) => {
      const at = new Map(p.board.territories.map((t) => [t.territoryId, t]));
      const sides = new Map<'me' | number, { territories: number; armies: number }>();
      for (const t of p.board.territories) {
        const o = ownerOf(t, me);
        if (o === 'fog' || o === 'neutral') continue;
        const side = sides.get(o) ?? { territories: 0, armies: 0 };
        side.territories++;
        side.armies += t.armies ?? 0;
        sides.set(o, side);
      }
      const held = (o: 'me' | number) =>
        g.map.bonuses
          .filter((b) => b.value > 0 && bonusTerritories(g, b.id).every((t) => ownerOf(at.get(t), me) === o))
          .map((b) => b.id);
      return {
        turn: p.turn,
        sides: [...sides]
          .sort((a, b) => (a[0] === 'me' ? -1 : b[0] === 'me' ? 1 : (a[0] as number) - (b[0] as number)))
          .map(([o, v]) => ({ owner: o, ...v, bonusesHeld: held(o) })),
        ...(p.orders
          ? {
              myOrders: {
                deploys: p.orders.deploys.map((d) => ({ territoryId: d.territoryId, armies: d.armies })),
                moves: p.orders.moves.map((m) => ({ from: m.from, to: m.to, armies: m.armies })),
              },
            }
          : {}),
      };
    });

  return {
    me: {
      income: input.myIncome,
      incomeHistory: [...(input.incomeHistory ?? [])],
      territories: mine.length,
      armies: mine.reduce((n, id) => n + (armiesOf(id) ?? 0), 0),
      bonusesHeld: bonuses.filter((b) => b.heldBy === 'me').map((b) => ({ bonusId: b.bonusId, value: b.value })),
    },
    territories,
    territoriesOmitted: Math.max(0, listed.length - MAX_SITUATION_TERRITORIES),
    bonuses: bonuses.slice(0, MAX_SITUATION_BONUSES),
    bonusesOmitted: Math.max(0, bonuses.length - MAX_SITUATION_BONUSES),
    opponents,
    changes,
    past,
  };
}

/** What to do with the facts: the tools that let the model test and act on its own plan. */
export const OWN_PLAN_STEPS = [
  'Read the board, bonuses, opponents and changes; the plan, options and alternatives are inputs to your judgement, not the answer.',
  'Write your own deploys and moves (any mix of the options, the alternatives or neither).',
  'Test them with warapp_check_plan (every opponent\'s replies, both move orders, one turn ahead); change and test again as needed.',
  'Look deeper when it matters: warapp_turn_history (what happened turn by turn), warapp_track_opponents and warapp_profile_opponents (how each opponent plays), warapp_plan_route (paths), warapp_get_map (the whole map), warapp_strategy (notes for this game), warapp_get_chat.',
  'Submit with warapp_submit_turn; when your orders differ from the plan, pass override_reason so the decision log keeps why.',
] as const;
