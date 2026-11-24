// My card state (src/card-state.ts) read from the live board for warapp_get_game and warapp_begin_turn: the whole
// cards I (or my team) hold by type and the pieces toward the next. One GetLatestGameInfo, only for a game being
// played or picked with my seat in it and a card in play; never throws (a failed read is `cardsUnread`).
import { cardState, type CardState } from '../card-state.js';
import type { Game } from '../normalize.js';
import { handOwners } from './card-advice.js';
import { readLatestBoard, type LiveContext } from './live-context.js';

export interface CardStateRead {
  cards?: CardState;
  /** Why the card state was not read (the live board failed, or my seat is unknown). */
  cardsUnread?: string;
}

const IN_PLAY = new Set(['Playing', 'DistributingTerritories']);

/** Whether {@link readCardState} would read anything for this game (no request). */
export const cardStateApplies = (game: Game): boolean => IN_PLAY.has(game.state) && (game.settings?.cards.length ?? 0) > 0;

/** My card state for `game`, or `{}` when it does not apply (no card in play, not being played). */
export async function readCardState(ctx: LiveContext, game: Game, info?: unknown): Promise<CardStateRead> {
  if (!cardStateApplies(game)) return {};
  try {
    const token = await ctx.myInviteToken();
    const me = token === undefined ? undefined : game.players.find((p) => p.id === token);
    if (!me) return { cardsUnread: 'the signed-in account holds no seat in this game, or could not be read' };
    const read = info ?? (await readLatestBoard(ctx, game.id)).info;
    const cards = cardState(read, handOwners(game, me), game.settings);
    return cards ? { cards } : {};
  } catch (e) {
    return { cardsUnread: e instanceof Error ? e.message : String(e) };
  }
}
