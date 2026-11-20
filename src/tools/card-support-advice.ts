// PLAN-TEAMS D2: where to play my Diplomacy, Sanctions, Airlift and Gift cards this turn, read against the
// plan (src/analysis/card-support.ts). Advice only, never auto-played: each carries the `order` to pass to
// warapp_submit_turn as is, whose encodings are UNVERIFIED live (V9) save Airlift's and Diplomacy's (verified
// live, #296 and #369). Players and territories by id only.

import { airliftAdvice, diplomacyAdvice, giftAdvice, intelAdvice, sanctionsAdvice, type IntelCard, type Strength, type TruceCover } from '../analysis/card-support.js';
import type { CardBoard } from '../analysis/card-threats.js';
import { visibleIncomeFor } from '../analysis/plan/shared.js';
import type { TurnPlan } from '../analysis/planner.js';
import { STRENGTH_INCOME_TURNS } from '../analysis/profile.js';
import type { Card } from '../cards.js';
import type { Game, Player } from '../normalize.js';
import { dealtMode } from './map-details.js';

const CARD_SPY = 2;
const CARD_RECONNAISSANCE = 10;
const CARD_SURVEILLANCE = 11;
const INTEL: ReadonlyArray<[number, IntelCard]> = [
  [CARD_SPY, 'Spy'],
  [CARD_RECONNAISSANCE, 'Reconnaissance'],
  [CARD_SURVEILLANCE, 'Surveillance'],
];
const CARD_AIRLIFT = 6;
const CARD_GIFT = 7;
const CARD_DIPLOMACY = 8;
const CARD_SANCTIONS = 9;

type CardOrder = { kind: 'card'; card: string } & Record<string, unknown>;

export interface SupportView {
  diplomacy?: { player: number; borders: number[]; armies: number; overTruce?: string; skipped?: string[]; chain?: true; order: CardOrder };
  sanctions?: { player: number; skipped?: string[]; order: CardOrder };
  /** `redeploy` (#434): no border falls without it; an idle or cut-off stack goes to the strike stack or the thinnest border. */
  airlift?: { from: number; to: number; armies: number; teammate?: number; redeploy?: { source: 'idle' | 'disconnected'; target: 'strike' | 'border' }; order: CardOrder };
  gift?: { player: number; bonus: number; territories: number[]; orders: CardOrder[] };
  /** G2: the information cards, only where they reveal what the plan needs (never with fog off). */
  spy?: { player: number; order: CardOrder };
  reconnaissance?: { target: number; order: CardOrder };
  surveillance?: { bonus: number; order: CardOrder };
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
 * an opponent's figure is a lower bound under fog; every income before any army cap, as the profile's
 * ranking reads mine, #253). Teammates and players no longer playing are left out.
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
    strength: armies + STRENGTH_INCOME_TURNS * visibleIncomeFor(input.cb.graph, input.cb.board, playerId, input.game.settings),
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
  /** #424: of those, the ones whose card's last turn this is (chained rather than passed over). */
  lastTurn?: ReadonlySet<number>;
  truces: readonly TruceCover[];
}

/**
 * #424: the opponents still playing (teammates out). A lone one in contact is advised Diplomacy only
 * outside a 1v1 (2 or more), and the last-turn warning offers a chain only then too.
 */
export function diplomacyOpponents(game: SupportInput['game'], me: number, friends?: ReadonlySet<number>): number {
  return game.players.filter((p) => p.id !== me && !friends?.has(p.id) && (p.state ?? 'Playing') === 'Playing').length;
}

/** The D2 advice for the cards in `cards`: a view and one warning per card advised. */
export function supportAdvice(input: SupportInput): { view: SupportView; warnings: string[] } {
  const { me, cards, cb } = input;
  const view: SupportView = {};
  const warnings: string[] = [];
  const first = (type: number) => cards.find((c) => c.type === type);

  const dip = first(CARD_DIPLOMACY);
  if (dip) {
    const opponents = diplomacyOpponents(input.game, me.id, cb.friends);
    const d = diplomacyAdvice(cb, { atPeace: input.atPeace, truces: input.truces, opponents, ...(input.lastTurn ? { lastTurn: input.lastTurn } : {}) });
    if (d) {
      if (d.player !== undefined && d.pressure) {
        view.diplomacy = {
          player: d.player,
          borders: d.pressure.borders,
          armies: d.pressure.armies,
          ...(d.overTruce ? { overTruce: d.overTruce } : {}),
          ...(d.skipped.length ? { skipped: d.skipped } : {}),
          ...(d.chain ? { chain: true as const } : {}),
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
    // G2: a truce partner and a player a Diplomacy card keeps at peace with me are passed over, the reason stated.
    const pass = new Map<number, string>();
    for (const t of input.truces)
      pass.set(t.player, `your truce with it is ${t.state === 'notice' ? 'in notice' : 'in force'} — a sanction on a partner invites a break`);
    for (const p of input.atPeace) pass.set(p, 'a Diplomacy card between you is in force — it cannot attack you, so sanction a player who can');
    const pct = percentage(input.game);
    const s = sanctionsAdvice({ me: me.id, players: strengths(input), ...(pct !== undefined ? { percentage: pct } : {}), ...(pass.size ? { pass } : {}) });
    if (s?.player !== undefined) {
      view.sanctions = { player: s.player, ...(s.skipped?.length ? { skipped: s.skipped } : {}), order: { kind: 'card', card: san.id, player: s.player } };
      warnings.push(`${s.why} ${PLAY_IT}`);
    } else if (s) warnings.push(s.why);
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
        ...(a.redeploy ? { redeploy: a.redeploy } : {}),
        order: { kind: 'card', card: air.id, from: a.from, to: a.to, armies: a.armies },
      };
      warnings.push(`${a.why} ${PLAY_IT}`);
    }
  }

  // G2: Spy, Reconnaissance and Surveillance, only where the fog hides what the plan needs.
  const intelCards = new Map(INTEL.flatMap(([type, name]) => (first(type) ? [[name, first(type)!] as const] : [])));
  if (intelCards.size) {
    const opponents = input.game.players
      .filter((p) => p.id !== me.id && !cb.friends?.has(p.id) && (p.state ?? 'Playing') === 'Playing')
      .map((p) => p.id);
    const fog = input.game.settings?.fog;
    // #443: the distribution mode's territories, when the map already carries them (no read here).
    const starts = dealtMode(input.game.settings, cb.graph.map)?.territories;
    const intel = intelAdvice(cb, {
      ...(fog !== undefined ? { fog } : {}),
      opponents,
      held: new Set(intelCards.keys()),
      ...(starts?.length ? { likelyStarts: new Set(starts) } : {}),
    });
    for (const a of intel.advice) {
      const id = intelCards.get(a.card)!.id;
      if (a.card === 'Spy' && a.player !== undefined) view.spy = { player: a.player, order: { kind: 'card', card: id, player: a.player } };
      if (a.card === 'Reconnaissance' && a.target !== undefined)
        view.reconnaissance = { target: a.target, order: { kind: 'card', card: id, target: a.target } };
      if (a.card === 'Surveillance' && a.bonus !== undefined) view.surveillance = { bonus: a.bonus, order: { kind: 'card', card: id, bonus: a.bonus } };
      warnings.push(`${a.why} ${PLAY_IT}`);
    }
    warnings.push(...intel.hold);
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
