// The targeted card plays warapp_submit_turn sends (PLAN-TEAMS part D): Spy, Reconnaissance,
// Surveillance, Airlift, Gift, Diplomacy and Sanctions, and the combat cards Bomb and Emergency Blockade. Each card's fields come from the client
// bundle's `GameOrderPlayCard<X>` writer and its refusals mirror the bundle's `GameValidateOrders`
// (the error code each check stands in for is named), so a target war.app would refuse is refused
// here before anything is sent. The encodings are golden-pinned but UNVERIFIED live (V9,
// docs/WEB-PROTOCOL.md "Targeted card plays"). Third-party names reach errors only through
// `untrustedText`.

import { McpToolError } from '@chrischall/mcp-utils';
import type { CardRules } from '../cards.js';
import { inGameId, type LiveTerritory } from '../live.js';
import type { GameMap, GameSettings, Player } from '../normalize.js';
import type { CardPlayFields, CardPlayKind, OrderCommander } from '../protocol/methods.js';
import { untrustedText } from './common.js';
import { resolveBonus, resolvePlayer, resolveTerritory } from './resolve.js';

type Ref = string | number;

/** A card order's targets as the caller gives them (territories, players and bonuses by id or name). */
export interface CardTargetInput {
  target?: Ref | undefined;
  player?: Ref | undefined;
  players?: readonly Ref[] | undefined;
  bonus?: Ref | undefined;
  from?: Ref | undefined;
  to?: Ref | undefined;
  armies?: number | undefined;
  commander?: boolean | undefined;
}
type TargetField = keyof CardTargetInput;

/** The fields each card takes; every one is required except an Airlift's `commander`. */
const TAKES: Readonly<Record<CardPlayKind, readonly TargetField[]>> = {
  Reinforcement: [],
  OrderPriority: [],
  OrderDelay: [],
  Blockade: ['target'],
  EmergencyBlockade: ['target'],
  Bomb: ['target'],
  Reconnaissance: ['target'],
  Spy: ['player'],
  Sanctions: ['player'],
  Gift: ['target', 'player'],
  Diplomacy: ['players'],
  Surveillance: ['bonus'],
  Airlift: ['from', 'to', 'armies', 'commander'],
};
const OPTIONAL: ReadonlySet<TargetField> = new Set(['commander']);

/** What each field means, for the refusal that names a missing or stray one. */
const FIELD_HELP: Readonly<Record<CardPlayKind, string>> = {
  Reinforcement: 'it takes no target',
  OrderPriority: 'it takes no target',
  OrderDelay: 'it takes no target (only `before`)',
  Blockade: '`target`: your territory to blockade',
  EmergencyBlockade: '`target`: your territory to turn into a neutral wall before the attacks',
  Bomb: "`target`: a territory next to one of yours, not yours or a teammate's (its armies are halved)",
  Reconnaissance: '`target`: the territory to see',
  Spy: '`player`: the player whose territories to see',
  Sanctions: "`player`: the player whose income it cuts",
  Gift: '`target`: your territory to give, and `player`: who receives it',
  Diplomacy: '`players`: the two players who may not attack each other (usually you and one opponent)',
  Surveillance: '`bonus`: the bonus to see',
  Airlift: '`from` (yours), `to` (yours or a teammate\'s), `armies`, and optionally `commander`',
};

const article = (name: string) => (/^[aeiou]/i.test(name) ? 'An' : 'A');
const given = (v: unknown) => v !== undefined && !(typeof v === 'string' && v.trim() === '') && v !== false;

/**
 * Refuse a card order whose fields do not fit its card: a required field missing, or a field the
 * card does not take (`before` is checked by the caller).
 */
export function checkCardFields(kind: CardPlayKind, name: string, input: CardTargetInput): void {
  const takes = TAKES[kind];
  const stray = (Object.keys(input) as TargetField[]).filter((k) => given(input[k]) && !takes.includes(k));
  if (stray.length) {
    throw new McpToolError(`${article(name)} ${name} card takes no ${stray.join(' or ')}.`, {
      hint: `${name}: ${FIELD_HELP[kind]}.`,
    });
  }
  const missing = takes.filter((k) => !OPTIONAL.has(k) && !given(input[k]));
  if (missing.length) {
    throw new McpToolError(`${article(name)} ${name} card needs ${missing.map((k) => `\`${k}\``).join(' and ')}.`, {
      hint: `${name}: ${FIELD_HELP[kind]}.`,
    });
  }
}

/** A player as a resolved card play names it: GameFeed id, in-game id, display name (raw; delimit to show). */
export interface CardPlayer {
  id: number;
  inGameId: number;
  name: string;
}

/** A card play's targets, resolved and checked against the live board. */
export interface CardTargets {
  /** What the encoder writes (in-game player ids, territory and bonus ids). */
  fields: CardPlayFields;
  territory?: { id: number; name: string };
  player?: CardPlayer;
  players?: [CardPlayer, CardPlayer];
  bonus?: { id: number; name: string };
  from?: { id: number; name: string };
  to?: { id: number; name: string };
  armies?: number;
  commander?: true;
  warnings: string[];
}

/** What the checks read, and what they keep across the turn's plays (one gift per territory, …). */
export interface CardPlayContext {
  map: GameMap;
  board: readonly LiveTerritory[];
  me: Player;
  myInGameId: number;
  players: readonly Player[];
  /** My teammates' GameFeed ids. */
  teammates: ReadonlySet<number>;
  settings: GameSettings | undefined;
  rules: CardRules;
  /** Armies deployed this turn per territory (they land before an Airlift runs). */
  deployedOn: ReadonlyMap<number, number>;
  /** Territories this turn's moves leave from. */
  movesFrom: ReadonlySet<number>;
  /** Kept across the turn's plays. */
  seen: { gifted: Set<number>; blockaded: Set<number>; airliftedFrom: Map<number, number>; commanderAirlifted: boolean };
}

/** A fresh `seen` for one turn's plays. */
export const newCardPlaySeen = (): CardPlayContext['seen'] => ({
  gifted: new Set(),
  blockaded: new Set(),
  airliftedFrom: new Map(),
  commanderAirlifted: false,
});

const place = (t: { id: number; name: string }) => `${untrustedText(t.name)} (${t.id})`;
const who = (p: CardPlayer) => `${untrustedText(p.name)} (${p.id})`;

function player(ctx: CardPlayContext, ref: Ref, card: string): CardPlayer {
  const p = resolvePlayer(ctx.players, ref);
  let id: number;
  try {
    id = inGameId(p);
  } catch {
    throw new McpToolError(`${untrustedText(p.name)} (${p.id}) has no in-game id this tool can derive, so the ${card} card cannot name it.`, {
      hint: 'Play this card in the game itself.',
    });
  }
  return { id: p.id, inGameId: id, name: p.name };
}

const isMe = (ctx: CardPlayContext, p: CardPlayer) => p.id === ctx.me.id;
const isTeammate = (ctx: CardPlayContext, p: CardPlayer) => ctx.teammates.has(p.id);
/** Whether GameFeed says the player is still playing (unknown counts as playing: war.app has the last word). */
const playing = (ctx: CardPlayContext, p: CardPlayer) => {
  const state = ctx.players.find((x) => x.id === p.id)?.state;
  return state === undefined || state === 'Playing';
};

function requirePlaying(ctx: CardPlayContext, p: CardPlayer, card: string, code: string): void {
  if (playing(ctx, p)) return;
  throw new McpToolError(`${who(p)} is no longer playing, so the ${card} card cannot name them (war.app refuses it: ${code}).`, {
    hint: "warapp_get_game shows each player's state.",
  });
}

const standingOf = (ctx: CardPlayContext, id: number) => ctx.board.find((t) => t.territoryId === id);
const mine = (ctx: CardPlayContext, id: number) => {
  const t = standingOf(ctx, id);
  return t !== undefined && !t.fogged && t.owner === ctx.myInGameId;
};
/** My teammates' in-game ids (a teammate without a derivable one owns nothing on the board by it). */
function teammateIds(ctx: CardPlayContext): Set<number> {
  const out = new Set<number>();
  for (const p of ctx.players) {
    if (!ctx.teammates.has(p.id)) continue;
    try {
      out.add(inGameId(p));
    } catch {
      // An AI seat: no wrapped id.
    }
  }
  return out;
}

/** The Emergency Blockade's `MultiplyAmount`, when the settings carry one. */
function wallMultiplier(settings: GameSettings | undefined): number | undefined {
  const raw = settings?.raw.EmergencyBlockadeCard;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = Number((raw as Record<string, unknown>).MultiplyAmount);
  return Number.isFinite(m) && m > 0 ? m : undefined;
}

/** A bonus's territories, its member bonuses' included (a superbonus). */
function bonusMembers(map: GameMap, id: number, seen = new Set<number>()): number[] {
  const b = map.bonuses.find((x) => x.id === id);
  if (!b || seen.has(id)) return [];
  seen.add(id);
  return [...b.territoryIds, ...b.bonusIds.flatMap((m) => bonusMembers(map, m, seen))];
}

/** The bonuses worth something that I hold whole at the start of the turn and `territory` is in, by ascending id. */
function heldBonusesWith(ctx: CardPlayContext, territory: number): Array<{ id: number; value: number }> {
  return ctx.map.bonuses
    .filter((b) => b.value > 0)
    .map((b) => ({ id: b.id, value: b.value, members: bonusMembers(ctx.map, b.id) }))
    .filter((b) => b.members.includes(territory) && b.members.every((m) => mine(ctx, m)))
    .map(({ id, value }) => ({ id, value }))
    .sort((a, b) => a.id - b.id);
}

/** The Sanctions percentage (`SanctionsCard.Percentage`), when the settings carry one. */
function sanctionsPercentage(settings: GameSettings | undefined): number | undefined {
  const raw = settings?.raw.SanctionsCard;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const pct = (raw as Record<string, unknown>).Percentage;
  return typeof pct === 'number' ? pct : undefined;
}

/**
 * Resolve a targeted card play's fields against the map, the players and the live board, refusing
 * what war.app's validator (the client bundle's `GameValidateOrders`) or the card's rules exclude.
 * A card not in this game's card list is refused too. Blockade's own checks stay with the caller.
 */
export function resolveCardTargets(kind: CardPlayKind, cardName: string, input: CardTargetInput, ctx: CardPlayContext): CardTargets {
  const warnings: string[] = [];
  if (kind !== 'Blockade' && TAKES[kind].length && ctx.rules.inPlay.length && !ctx.rules.inPlay.includes(cardName)) {
    throw new McpToolError(`The ${cardName} card is not in play in this game.`, {
      hint: `This game's cards: ${ctx.rules.inPlay.join(', ')}.`,
    });
  }
  switch (kind) {
    case 'Spy': {
      // GameValidateOrders: 80 CannotSpyOnTeammateOrSelf, 79 CannotSpyOnThatPlayer (not playing).
      const p = player(ctx, input.player!, cardName);
      if (isMe(ctx, p) || isTeammate(ctx, p)) {
        throw new McpToolError(`A Spy card cannot target ${isMe(ctx, p) ? 'yourself' : `your teammate ${who(p)}`} (war.app refuses it: error 80).`, {
          hint: 'Spy on an opponent: you see their territories for the rest of the turn.',
        });
      }
      requirePlaying(ctx, p, cardName, 'error 79');
      return { fields: { player: p.inGameId }, player: p, warnings };
    }
    case 'Sanctions': {
      // GameValidateOrders refuses only a player not playing (219); the target is our rule: a sanction
      // cuts income, so never on me or a teammate — unless the game's percentage is negative (a boost).
      const p = player(ctx, input.player!, cardName);
      requirePlaying(ctx, p, cardName, 'error 219');
      const pct = sanctionsPercentage(ctx.settings);
      const friendly = isMe(ctx, p) || isTeammate(ctx, p);
      if (pct !== undefined && pct < 0) {
        if (!friendly) {
          throw new McpToolError(
            `This game's Sanctions percentage is negative (${Math.round(pct * 100)}%): a sanction raises the target's income, so it does not go on an opponent (${who(p)}).`,
            { hint: 'Play it on yourself or a teammate, or keep it.' },
          );
        }
      } else if (friendly) {
        throw new McpToolError(`Sanctions cut the target's income, so they do not go on ${isMe(ctx, p) ? 'yourself' : `your teammate ${who(p)}`}.`, {
          hint: 'Sanction an opponent — usually the leader.',
        });
      }
      return { fields: { player: p.inGameId }, player: p, warnings };
    }
    case 'Diplomacy': {
      // GameValidateOrders: 20 InvalidPlayer, 214 CannotDoDiplomacyBetweenTeammates (the same player twice
      // is one team), 381 DiplomacyPlayerInvalid (not playing).
      const refs = input.players!;
      if (refs.length !== 2) {
        throw new McpToolError(`A Diplomacy card names exactly two players, not ${refs.length}.`, { hint: `Diplomacy: ${FIELD_HELP.Diplomacy}.` });
      }
      const a = player(ctx, refs[0]!, cardName);
      const b = player(ctx, refs[1]!, cardName);
      if (a.id === b.id) {
        throw new McpToolError(`A Diplomacy card names one player twice (${who(a)}) (war.app refuses it: error 214).`, {
          hint: 'Name two different players, e.g. you and the opponent you want peace with.',
        });
      }
      const team = (p: CardPlayer) => isMe(ctx, p) || isTeammate(ctx, p);
      if (team(a) && team(b)) {
        throw new McpToolError(`${who(a)} and ${who(b)} are on one team, so a Diplomacy card between them does nothing (war.app refuses it: error 214).`, {
          hint: 'Name an opponent as one of the two.',
        });
      }
      requirePlaying(ctx, a, cardName, 'error 381');
      requirePlaying(ctx, b, cardName, 'error 381');
      if (!isMe(ctx, a) && !isMe(ctx, b)) {
        warnings.push(
          `Diplomacy between players ${a.id} and ${b.id} does not name you: it stops them attacking each other, not you.`,
        );
      }
      return { fields: { players: [a.inGameId, b.inGameId] }, players: [a, b], warnings };
    }
    case 'Reconnaissance': {
      // GameValidateOrders: 41 InvalidTerritory (resolving it against the map covers that).
      const t = resolveTerritory(ctx.map, input.target!);
      return { fields: { target: t.id }, territory: { id: t.id, name: t.name }, warnings };
    }
    case 'Surveillance': {
      // GameValidateOrders: 223 InvalidBonus, 224 CannotSurveillanceBonusValuedAtZero.
      const b = resolveBonus(ctx.map, input.bonus!);
      if (b.value === 0) {
        throw new McpToolError(`${place(b)} is worth 0 in this game, so it cannot be surveilled (war.app refuses it: error 224).`, {
          hint: 'Pick a bonus worth something.',
        });
      }
      return { fields: { bonus: b.id }, bonus: { id: b.id, name: b.name }, warnings };
    }
    case 'Gift': {
      // GameValidateOrders: 212 CannotGiftTerritoryYouDoNotOwn, 211 CannotGiftToYourself,
      // 213 CannotGiftSameTerritoryMoreThanOnce, 210 CannotGiftToNonPlayingPlayer, 536 CannotGiftSpecialUnit.
      const t = resolveTerritory(ctx.map, input.target!);
      const terr = { id: t.id, name: t.name };
      if (!mine(ctx, t.id)) {
        throw new McpToolError(`${place(terr)} is not yours at the start of this turn, so it cannot be gifted (war.app refuses it: error 212).`, {
          hint: 'A Gift gives away a territory you hold on the live board (warapp_get_live_board).',
        });
      }
      const p = player(ctx, input.player!, cardName);
      if (isMe(ctx, p)) {
        throw new McpToolError('A Gift cannot go to yourself (war.app refuses it: error 211).', { hint: 'Name the player who receives the territory.' });
      }
      requirePlaying(ctx, p, cardName, 'error 210');
      if (ctx.seen.gifted.has(t.id)) {
        throw new McpToolError(`${place(terr)} is gifted twice (war.app refuses it: error 213).`, { hint: 'Gift each territory once.' });
      }
      const units = standingOf(ctx, t.id)?.specialUnits ?? [];
      if (units.length) {
        const commander = units.some((u) => u.kind === 'commander');
        throw new McpToolError(
          `${place(terr)} holds ${commander ? 'a commander' : 'a special unit'}, which cannot be gifted (war.app refuses it: error 536).`,
          { hint: 'Move the unit off first, or gift another territory.' },
        );
      }
      ctx.seen.gifted.add(t.id);
      warnings.push(
        `Gift: territory ${t.id} and every army on it (this turn's deploys there included) go to player ${p.id} before the attacks run` +
          (ctx.movesFrom.has(t.id) ? '; the moves from it in these orders will not run, since it is no longer yours by then.' : '.'),
      );
      return { fields: { player: p.inGameId, target: t.id }, territory: terr, player: p, warnings };
    }
    case 'Bomb':
      return bomb(input, ctx, warnings);
    case 'EmergencyBlockade':
      return emergencyBlockade(input, ctx, warnings);
    case 'Airlift':
      return airlift(input, ctx, warnings);
    default:
      return { fields: {}, warnings };
  }
}

/**
 * A Bomb (`GameOrderPlayCardBomb`), as GameValidateOrders checks it: 526 CannotBombTeammates (the
 * target's owner at the start of the turn is me or a teammate), 527 CannotBombNonAdjacent (none of the
 * target's neighbours, by the map's own list for it, is mine). A neutral or fogged target is allowed.
 * It runs in phase 30, after the deploys and before every move.
 */
function bomb(input: CardTargetInput, ctx: CardPlayContext, warnings: string[]): CardTargets {
  const t = resolveTerritory(ctx.map, input.target!);
  const terr = { id: t.id, name: t.name };
  const standing = standingOf(ctx, t.id);
  const visible = standing !== undefined && !standing.fogged;
  if (mine(ctx, t.id)) {
    throw new McpToolError(`${place(terr)} is yours: you cannot bomb your own territory (war.app refuses it: error 526).`, {
      hint: 'Bomb an opponent\'s or a neutral territory next to one of yours.',
    });
  }
  if (visible && teammateIds(ctx).has(standing.owner)) {
    throw new McpToolError(`${place(terr)} is your teammate's: you cannot bomb your teammate's territory (war.app refuses it: error 526).`, {
      hint: 'Bomb an opponent\'s or a neutral territory next to one of yours.',
    });
  }
  if (!t.connectedTo.some((n) => mine(ctx, n))) {
    throw new McpToolError(`${place(terr)} is next to none of yours at the start of this turn, so it cannot be bombed (war.app refuses it: error 527).`, {
      hint: 'A Bomb hits a territory that borders one you hold on the live board (warapp_get_live_board).',
    });
  }
  warnings.push(
    `Bomb: territory ${t.id}'s armies (its owner's deploys there included) are halved after the deploys and before every move; a commander there is unharmed.` +
      (visible ? '' : ` Territory ${t.id} is fogged: its owner and armies are not known here.`),
  );
  return { fields: { target: t.id }, territory: terr, warnings };
}

/**
 * An Emergency Blockade (`GameOrderPlayCardAbandon`), as GameValidateOrders checks it: 95
 * AbandonCardMustTargetYourTerritory, 96 AbandonCannotBeUsedOnSameSpotMoreThanOnce. Ours (#163): never
 * on my commander's territory (it would be lost with it). It runs in phase 37, after the deploys and
 * before Airlift and the attacks: the territory turns neutral with its armies multiplied, so a move from
 * it does not run and a held bonus it is in is broken (both warnings).
 */
function emergencyBlockade(input: CardTargetInput, ctx: CardPlayContext, warnings: string[]): CardTargets {
  const t = resolveTerritory(ctx.map, input.target!);
  const terr = { id: t.id, name: t.name };
  if (!mine(ctx, t.id)) {
    throw new McpToolError(`${place(terr)} is not yours at the start of this turn, so it cannot be blockaded (war.app refuses it: error 95).`, {
      hint: 'An Emergency Blockade targets a territory you hold on the live board (warapp_get_live_board).',
    });
  }
  if (ctx.seen.blockaded.has(t.id)) {
    throw new McpToolError(`${place(terr)} is blockaded twice (war.app refuses it: error 96).`, { hint: 'Play one Emergency Blockade per territory.' });
  }
  if (standingOf(ctx, t.id)?.specialUnits?.some((u) => u.kind === 'commander' && u.owner === ctx.myInGameId)) {
    throw new McpToolError(`${place(terr)} holds your commander, so it cannot be blockaded.`, {
      hint: 'An Emergency Blockade makes the territory neutral and your commander on it would be lost. Move the commander out first, or blockade another territory.',
    });
  }
  ctx.seen.blockaded.add(t.id);
  const m = wallMultiplier(ctx.settings);
  warnings.push(
    `Emergency Blockade: territory ${t.id} turns neutral with its armies (this turn's deploys there included) ${m !== undefined ? `× ${m}` : 'multiplied'} ` +
      'before the attacks, and is no longer yours' +
      (ctx.movesFrom.has(t.id) ? '; the moves from it in these orders will not run.' : '.'),
  );
  for (const b of heldBonusesWith(ctx, t.id)) {
    warnings.push(`Emergency Blockade: territory ${t.id} is in bonus ${b.id}, which you hold: the blockade breaks it (+${b.value} a turn).`);
  }
  return { fields: { target: t.id }, territory: terr, warnings };
}

/**
 * An Airlift, as GameValidateOrders checks it: 184 CannotAirliftFromSameSpotAsOrigin, 182
 * CannotAirliftFromWhereYouDoNotControl, 183 CannotAirliftToWhereYouDoNotControl (mine or a
 * teammate's), 537 CannotAirliftSpecialUnit (a commander or boss goes only to my own territory).
 * It runs after the deploys (phase 43), so it may send the armies there plus this turn's deploys.
 */
function airlift(input: CardTargetInput, ctx: CardPlayContext, warnings: string[]): CardTargets {
  const f = resolveTerritory(ctx.map, input.from!);
  const t = resolveTerritory(ctx.map, input.to!);
  const from = { id: f.id, name: f.name };
  const to = { id: t.id, name: t.name };
  const armies = input.armies!;
  if (f.id === t.id) {
    throw new McpToolError(`An Airlift goes from ${place(from)} to itself (war.app refuses it: error 184).`, { hint: 'Airlift between two different territories.' });
  }
  if (!mine(ctx, f.id)) {
    throw new McpToolError(`${place(from)} is not yours at the start of this turn, so nothing can be airlifted from it (war.app refuses it: error 182).`, {
      hint: 'Airlift from a territory you hold on the live board (warapp_get_live_board).',
    });
  }
  const dest = standingOf(ctx, t.id);
  const toTeammate = dest !== undefined && !dest.fogged && teammateIds(ctx).has(dest.owner);
  if (!mine(ctx, t.id) && !toTeammate) {
    throw new McpToolError(`${place(to)} is neither yours nor a teammate's, so nothing can be airlifted to it (war.app refuses it: error 183).`, {
      hint: "An Airlift lands on your own territory or a teammate's; attack to take a territory.",
    });
  }
  if (!Number.isInteger(armies) || armies < 1) {
    throw new McpToolError(`An Airlift sends at least one army, not ${armies}.`, { hint: 'Give `armies` as a whole number of 1 or more.' });
  }
  const there = (standingOf(ctx, f.id)?.armies ?? 0) + (ctx.deployedOn.get(f.id) ?? 0);
  const total = (ctx.seen.airliftedFrom.get(f.id) ?? 0) + armies;
  if (total > there) {
    throw new McpToolError(
      `These orders airlift ${total} armies from ${place(from)}, but at most ${there} stand there when the Airlift runs (its armies now plus this turn's deploys).`,
      { hint: 'Airlift no more armies than stand on the territory.' },
    );
  }
  ctx.seen.airliftedFrom.set(f.id, total);
  const out: CardTargets = { fields: { from: f.id, to: t.id, armies }, from, to, armies, warnings };
  if (input.commander) {
    if (ctx.settings?.commanders !== true) {
      throw new McpToolError('This game has no commanders, so the Airlift cannot take one.', { hint: 'Leave `commander` out.' });
    }
    if (toTeammate) {
      throw new McpToolError(`A commander cannot be airlifted to a teammate's territory (${place(to)}) (war.app refuses it: error 537).`, {
        hint: 'Airlift the commander to a territory of your own, or leave `commander` out.',
      });
    }
    const unit = standingOf(ctx, f.id)?.specialUnits?.find((u) => u.kind === 'commander' && u.owner === ctx.myInGameId);
    if (!unit) {
      throw new McpToolError(`Your commander is not on ${place(from)} at the start of this turn.`, {
        hint: 'Airlift it from where it stands (warapp_get_live_board shows it), or leave `commander` out.',
      });
    }
    if (ctx.seen.commanderAirlifted) {
      throw new McpToolError('Your commander is airlifted twice.', { hint: 'Take it on one Airlift only.' });
    }
    ctx.seen.commanderAirlifted = true;
    const commander: OrderCommander = { id: unit.id, owner: ctx.myInGameId };
    out.fields.commander = commander;
    out.commander = true;
  }
  if (toTeammate) {
    warnings.push(`Airlift: the ${armies} armies landing on territory ${t.id} become your teammate's.`);
  }
  return out;
}
