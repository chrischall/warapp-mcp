// PLAN-TEAMS D3: the cards in effect the planner may rely on. `readActiveCards` (src/cards.ts) decodes
// the current standing's ActiveCards loosely and UNVERIFIED live (#163); this module decides which of
// them are sure enough to change a plan, and why the others are not. Pure and deterministic.
//
// What the client bundle says (read-only, never vendored):
//   - an ActiveCard is created when its play order is applied, with ExpiresAfterTurn = the card's
//     Duration (`ActiveOrderDuration`) + the turn number + 1, and is removed at the end of the turn
//     processing that reaches it (Diplomacy and Sanctions expire `EndOfTurn`). So a card still in the
//     current standing is in effect for the whole of the turn being ordered, and gone by its
//     `untilTurn` (src/cards.ts) — never more than Duration turns ahead;
//   - Diplomacy stops its two players attacking each other;
//   - a Sanctions card on a player multiplies that player's income by (1 − Percentage), rounded to
//     the nearest with .5 up, once per active card, after the army cap, capped at 10000 (a negative
//     Percentage raises it). How the cut is taken from Local Deployment pools is not simple, so the
//     tool does not apply it there.
//
// "Sure" means every one of: the turn is known; the card is in play in the game's settings with a
// Duration (and, for Sanctions, a Percentage of at most 1); the decoded expiry is after this turn and
// no later than Duration turns ahead; every player it names is a distinct player of this game still
// playing; and a Diplomacy names me and an opponent (not a teammate). Anything else is reported in
// `unsure` and changes nothing.

import type { ActiveCard } from '../cards.js';
import type { GameSettings } from '../normalize.js';
import { carriesTeam } from '../teams.js';

/** A player of the game as the active cards name it (in-game id → this). */
export interface EffectPlayer {
  /** GameFeed id. */
  id: number;
  team?: number;
  /** GameFeed state; absent reads as `Playing`. */
  state?: string;
}

export interface CardsInEffectInput {
  /** The decoded active cards (`readActiveCards`), players by in-game id. */
  active: readonly ActiveCard[];
  /** In-game id → the player. */
  players: ReadonlyMap<number, EffectPlayer>;
  /** My GameFeed id. */
  me: number;
  /** The turn being ordered (GameFeed `numberOfTurns` + 1); `null` when unknown. */
  turn: number | null;
  settings: GameSettings | undefined;
}

/** A Diplomacy card between me and `player` the planner may rely on: in effect until `untilTurn` (gone by then). */
export interface SureDiplomacy {
  player: number;
  untilTurn: number;
}

/** A Sanctions card on `player` (GameFeed id), cutting its income by `percentage` until `untilTurn`. */
export interface SureSanction {
  player: number;
  percentage: number;
  untilTurn: number;
}

export interface CardsInEffect {
  /** Diplomacy between me and an opponent, by player ascending (the longest card per player). */
  diplomacy: SureDiplomacy[];
  /** Sanctions on me (one entry per card: they compound). */
  sanctionsOnMe: SureSanction[];
  /** Sanctions on another player: reported, never applied to its estimate (observed deploys may already carry it). */
  sanctionsOnOthers: SureSanction[];
  /** Why a Diplomacy with me, or Sanctions on me, was read but not relied on. */
  unsure: string[];
}

/** The most a sanctioned income can be (the client bundle's cap). */
export const SANCTIONED_INCOME_CAP = 10000;

/** Round to the nearest, .5 away from zero (the client bundle's rounding of a sanctioned income). */
const roundHalfUp = (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x));

/**
 * An income under the Sanctions cards in effect on its player, as the client bundle computes it:
 * per card, round((1 − percentage) × income), capped at {@link SANCTIONED_INCOME_CAP}.
 */
export function sanctionedIncome(income: number, percentages: readonly number[]): number {
  let out = income;
  for (const p of percentages) {
    const r = roundHalfUp((1 - p) * out);
    out = r < 0 || r > SANCTIONED_INCOME_CAP ? SANCTIONED_INCOME_CAP : r;
  }
  return out;
}

function cardSettings(settings: GameSettings | undefined, card: 'Diplomacy' | 'Sanctions'): Record<string, unknown> | undefined {
  if (!settings?.cards.includes(card)) return undefined;
  const raw = settings.raw?.[`${card}Card`];
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

const durationOf = (s: Record<string, unknown> | undefined): number | undefined => {
  const d = s?.Duration;
  return typeof d === 'number' && Number.isInteger(d) && d >= 1 ? d : undefined;
};

/** Why a card's timing is not sure this turn, or `undefined` when it is. */
function timingDoubt(card: ActiveCard, turn: number | null, duration: number | undefined, name: string): string | undefined {
  if (turn === null) return 'the turn is not known';
  if (duration === undefined) return `the game's settings give no ${name} duration`;
  if (card.untilTurn === undefined) return 'its expiry was not read';
  if (card.untilTurn <= turn) return `it reads as already over (until turn ${card.untilTurn}, this is turn ${turn})`;
  if (card.untilTurn > turn + duration)
    return `it reads as lasting until turn ${card.untilTurn}, longer than the game's ${name} duration (${duration}) allows from turn ${turn}`;
  return undefined;
}

const playing = (p: EffectPlayer) => (p.state ?? 'Playing') === 'Playing';

/**
 * PLAN-TEAMS D3: which decoded active cards the planner may rely on. Only a Diplomacy that names me
 * and Sanctions on me are reasoned about in `unsure`; cards between other players are left out.
 */
export function cardsInEffect(input: CardsInEffectInput): CardsInEffect {
  const { players, me, turn, settings } = input;
  const mine = [...players].find(([, p]) => p.id === me);
  const myInGame = mine?.[0];
  const myTeam = mine && carriesTeam(mine[1].team) ? mine[1].team : undefined;
  const diplomacy = new Map<number, number>();
  const sanctionsOnMe: SureSanction[] = [];
  const sanctionsOnOthers: SureSanction[] = [];
  const unsure: string[] = [];
  const dipSettings = cardSettings(settings, 'Diplomacy');
  const sanSettings = cardSettings(settings, 'Sanctions');
  for (const a of input.active) {
    if (a.card === 'Diplomacy' && a.players) {
      const [x, y] = a.players;
      if (myInGame === undefined || (x !== myInGame && y !== myInGame)) continue;
      if (x === y) continue;
      const otherIn = x === myInGame ? y : x;
      const other = players.get(otherIn);
      const label = `Diplomacy with player ${other?.id ?? `(in-game ${otherIn})`}`;
      const doubt = !settings?.cards.includes('Diplomacy')
        ? 'the game does not have the Diplomacy card in play'
        : !other
          ? `in-game id ${otherIn} is not a player of this game`
          : myTeam !== undefined && other.team === myTeam
            ? 'it names a teammate'
            : !playing(other)
              ? 'that player is no longer playing'
              : timingDoubt(a, turn, durationOf(dipSettings), 'Diplomacy');
      if (doubt) {
        unsure.push(`${label} was read from the board, but the plan does not rely on it: ${doubt}.`);
        continue;
      }
      diplomacy.set(other!.id, Math.max(diplomacy.get(other!.id) ?? 0, a.untilTurn!));
    }
    if (a.card === 'Sanctions' && a.target !== undefined) {
      const target = players.get(a.target);
      const onMe = a.target === myInGame;
      const pct = sanSettings?.Percentage;
      const doubt = !settings?.cards.includes('Sanctions')
        ? 'the game does not have the Sanctions card in play'
        : !target
          ? `in-game id ${a.target} is not a player of this game`
          : typeof pct !== 'number' || !Number.isFinite(pct) || pct > 1
            ? "the game's settings give no usable Sanctions percentage"
            : timingDoubt(a, turn, durationOf(sanSettings), 'Sanctions');
      if (doubt) {
        if (onMe) unsure.push(`Sanctions on you were read from the board, but the plan's income does not apply them: ${doubt}.`);
        continue;
      }
      const s: SureSanction = { player: target!.id, percentage: pct as number, untilTurn: a.untilTurn! };
      (onMe ? sanctionsOnMe : sanctionsOnOthers).push(s);
    }
  }
  return {
    diplomacy: [...diplomacy].sort((p, q) => p[0] - q[0]).map(([player, untilTurn]) => ({ player, untilTurn })),
    sanctionsOnMe,
    sanctionsOnOthers,
    unsure,
  };
}
