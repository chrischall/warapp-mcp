// Owner request 2026-11-24: warapp_check_plan projects the Sanctions its orders play onto next turn's income. The
// card works from the turn after it is played (the bundle: an ActiveCard from the play, applied to the target's
// income per card as round((1 − Percentage) × income), capped at 10,000) for the game's Duration. A negative
// percentage raises the target's income: worth playing on myself, never on an opponent; a positive one the other way
// round (warapp_submit_turn refuses the wrong side; here it is a warning, since the test still runs). Pure.
import { percentText, sanctionedIncome, sanctionsSettings } from '../analysis/cards-in-effect.js';
import type { GameSettings } from '../normalize.js';

/** The Sanctions card's type id. */
export const CARD_SANCTIONS = 9;

/** One Sanctions play in the orders: whom it names and the income it changes next turn. */
export interface SanctionsPlayed {
  player: number;
  /** The game's percentage (a fraction; negative raises the target's income); `null` when unread. */
  percentage: number | null;
  /** The turns it lasts, when the settings say. */
  turns: number | null;
  /**
   * The target's income next turn without and with the card: mine from this turn's income (cards and any
   * Sanctions on me aside: the plan's own figure), an opponent's from its deploy estimate. Absent when not
   * modelled (Local Deployment, an unread percentage, a wrong side, no estimate).
   */
  nextIncome?: { before: number; after: number; change: number };
}

export interface SanctionsPlayedInput {
  settings: GameSettings | undefined;
  me: number;
  friends: ReadonlySet<number>;
  myIncome: number;
  estimateOf: (player: number) => number | undefined;
}

/** The Sanctions plays among the orders (targets by GameFeed id), each projected, with the warnings to show. */
export function sanctionsPlayed(targets: readonly number[], input: SanctionsPlayedInput): { entries: SanctionsPlayed[]; warnings: string[] } {
  const san = sanctionsSettings(input.settings);
  const pct = san?.percentage ?? null;
  const turns = san?.duration ?? null;
  const lasting = turns ? ` for ${turns} turn${turns === 1 ? '' : 's'}` : '';
  const local = input.settings?.localDeployments === true;
  const entries: SanctionsPlayed[] = [];
  const warnings: string[] = [];
  for (const player of targets) {
    const mine = player === input.me;
    const friendly = mine || input.friends.has(player);
    const entry: SanctionsPlayed = { player, percentage: pct, turns };
    entries.push(entry);
    if (pct === null) {
      warnings.push(`The Sanctions on player ${player}: this game's percentage could not be read, so the income it changes is not projected.`);
      continue;
    }
    if (pct > 0 && friendly) {
      warnings.push(
        `The Sanctions on ${mine ? 'yourself' : `your teammate ${player}`} would cut that income by ${percentText(pct)} (this game's percentage is positive): warapp_submit_turn refuses it. Sanction an opponent instead.`,
      );
      continue;
    }
    if (pct < 0 && !friendly) {
      warnings.push(
        `The Sanctions on player ${player} would raise its income by ${percentText(-pct)} (this game's percentage is negative): warapp_submit_turn refuses it. Play it on yourself instead.`,
      );
      continue;
    }
    if (pct === 0) continue;
    if (local) {
      warnings.push(`The Sanctions on ${mine ? 'yourself' : `player ${player}`}: under Local Deployment the change across the pools is not modelled, so next turn's income is not projected.`);
      continue;
    }
    const before = mine ? input.myIncome : friendly ? undefined : input.estimateOf(player);
    if (before === undefined) continue;
    const after = sanctionedIncome(before, [pct]);
    entry.nextIncome = { before, after, change: after - before };
    warnings.push(
      mine
        ? `Your Sanctions on yourself (${percentText(pct)}) raise your income from next turn${lasting}: ${before} → ${after} (+${after - before}), on this turn's income.`
        : `The Sanctions on player ${player} (${percentText(pct)}) cut its income from next turn${lasting}: its estimate ${before} → ${after}.`,
    );
  }
  return { entries, warnings };
}
