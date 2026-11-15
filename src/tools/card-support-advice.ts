// PLAN-TEAMS D2: where to play my Diplomacy, Sanctions, Airlift and Gift cards this turn, read against the
// plan (src/analysis/card-support.ts). Advice only, never auto-played: each carries the `order` to pass to
// warapp_submit_turn as is, whose encodings are UNVERIFIED live (V9). Players and territories by id only.

import { airliftAdvice, diplomacyAdvice, giftAdvice, sanctionsAdvice, type Strength, type TruceCover } from '../analysis/card-support.js';
import type { CardBoard } from '../analysis/card-threats.js';
import { incomeFor } from '../analysis/plan/shared.js';
import type { TurnPlan } from '../analysis/planner.js';
import { STRENGTH_INCOME_TURNS } from '../analysis/profile.js';
import type { Card } from '../cards.js';
import type { Game, Player } from '../normalize.js';

const CARD_AIRLIFT = 6;
const CARD_GIFT = 7;
const CARD_DIPLOMACY = 8;
const CARD_SANCTIONS = 9;

type CardOrder = { kind: 'card'; card: string } & Record<string, unknown>;

export interface SupportView {
  diplomacy?: { player: number; borders: number[]; armies: number; overTruce?: string; skipped?: string[]; order: CardOrder };
  sanctions?: { player: number; order: CardOrder };
  airlift?: { from: number; to: number; armies: number; teammate?: number; order: CardOrder };
  gift?: { player: number; bonus: number; territories: number[]; orders: CardOrder[] };
}

const PLAY_IT =
  'Advice only, not in the orders: pass its `order` to warapp_submit_turn to play it (the encoding is read from the client, not yet verified live).';

/** The Sanctions percentage (`SanctionsCard.Percentage`), when the settings carry one. */
function percentage(game: Pick<Game, 'settings'>): number | undefined {
  const raw = game.settings?.raw.SanctionsCard;
  const pct = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).Percentage : undefined;
  return typeof pct === 'number' ? pct : undefined;
}

/**
 * Each player in sight by strength (visible armies + {@link STRENGTH_INCOME_TURNS} × income): the
 * profile's free-for-all ranking when the plan has one, else read off the board (visible bonuses only:
 * an opponent's figure is a lower bound under fog). Teammates and players no longer playing are left out.
 */
function strengths(input: SupportInput): Strength[] {
  const ranking = input.plan.profile?.ranking;
  if (ranking) return ranking.players.map((p) => ({ playerId: p.playerId, strength: p.strength }));
  const out = new Map<number, number>();
  const playing = (id: number) => (input.game.players.find((p) => p.id === id)?.state ?? 'Playing') === 'Playing';
  for (const t of input.cb.board.territories) {
    if (t.owner.kind !== 'player') continue;
    const p = t.owner.playerId;
    if ((p !== input.me.id && input.cb.friends?.has(p)) || !playing(p)) continue;
    out.set(p, (out.get(p) ?? 0) + (t.armies ?? 0));
  }
  return [...out].map(([playerId, armies]) => ({
    playerId,
    strength: armies + STRENGTH_INCOME_TURNS * incomeFor(input.cb.graph, input.cb.board, playerId, input.game.settings),
  }));
}

interface SupportInput {
  game: Pick<Game, 'players' | 'settings'>;
  me: Player;
  plan: Partial<Pick<TurnPlan, 'profile' | 'team'>>;
  /** My own cards still in hand (neither played nor discarded by the plan's choice). */
  cards: readonly Card[];
  cb: CardBoard;
  /** Opponents a Diplomacy card in force already keeps from me. */
  atPeace: ReadonlySet<number>;
  truces: readonly TruceCover[];
}

/** The D2 advice for the cards in `cards`: a view and one warning per card advised. */
export function supportAdvice(input: SupportInput): { view: SupportView; warnings: string[] } {
  const { me, cards, cb } = input;
  const view: SupportView = {};
  const warnings: string[] = [];
  const first = (type: number) => cards.find((c) => c.type === type);

  const dip = first(CARD_DIPLOMACY);
  if (dip) {
    const d = diplomacyAdvice(cb, { atPeace: input.atPeace, truces: input.truces });
    if (d) {
      if (d.player !== undefined && d.pressure) {
        view.diplomacy = {
          player: d.player,
          borders: d.pressure.borders,
          armies: d.pressure.armies,
          ...(d.overTruce ? { overTruce: d.overTruce } : {}),
          ...(d.skipped.length ? { skipped: d.skipped } : {}),
          order: { kind: 'card', card: dip.id, players: [me.id, d.player] },
        };
      }
      warnings.push(
        `${d.why}${d.skipped.length ? ` Passed over: ${d.skipped.join('; ')}.` : ''}` +
          (d.player !== undefined ? ` It starts the turn after it is played: this turn's attacks still run. ${PLAY_IT}` : ''),
      );
    }
  }

  const san = first(CARD_SANCTIONS);
  if (san) {
    const s = sanctionsAdvice({ me: me.id, players: strengths(input), ...(percentage(input.game) !== undefined ? { percentage: percentage(input.game)! } : {}) });
    if (s) {
      view.sanctions = { player: s.player, order: { kind: 'card', card: san.id, player: s.player } };
      warnings.push(`${s.why} ${PLAY_IT}`);
    }
  }

  const air = first(CARD_AIRLIFT);
  if (air) {
    const a = airliftAdvice(cb);
    if (a) {
      view.airlift = {
        from: a.from,
        to: a.to,
        armies: a.armies,
        ...(a.teammate !== undefined ? { teammate: a.teammate } : {}),
        order: { kind: 'card', card: air.id, from: a.from, to: a.to, armies: a.armies },
      };
      warnings.push(`${a.why} ${PLAY_IT}`);
    }
  }

  const gifts = cards.filter((c) => c.type === CARD_GIFT);
  if (gifts.length) {
    const g = giftAdvice(cb, input.plan.team?.sharedBonuses ?? [], gifts.length);
    if (g) {
      view.gift = {
        player: g.player,
        bonus: g.bonus,
        territories: g.territories,
        orders: g.territories.map((t, i) => ({ kind: 'card', card: gifts[i]!.id, target: t, player: g.player })),
      };
      warnings.push(`${g.why} ${PLAY_IT}`);
    }
  }
  return { view, warnings };
}
