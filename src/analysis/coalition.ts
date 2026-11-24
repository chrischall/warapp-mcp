// Before surrendering a free-for-all, whether a coalition against the leader is viable and with whom (#445,
// owner 2026-11-20: "reach out to the weaker players and team up"; answers of 2026-11-23). Pure, advice only:
// it never sends a message and never changes a plan or the surrender line's own maths (#436).
//
// Once the #436 surrender line is crossed in a free-for-all with three or more players still playing, the
// advice is "try a coalition first" instead of "surrender" while:
// - the trailing players together (me and every viable partner) out-earn the leader on the calibrated
//   estimates (#419), or would once the leader loses the largest bonus of its we could break;
// - the attempt is inside its grace window: {@link COALITION_GRACE_TURNS} turns, counted from the turn the line
//   was crossed (the crossing turn is attempt turn 1);
// - and the leader's income lead over me has not grown since the line was crossed.
// Otherwise the surrender advice returns. A viable partner borders the leader, is not at war with me (no truce
// broken in this game, no attack declared on it) and is not ruled out by the cross-game record (a truce broken
// against me in any game, owner decision 2026-11-22). Every viable partner is ranked — by the largest leader
// bonus it borders, then its income, then id — and the top {@link OUTREACH_DRAFTS} get a #415 `propose` draft
// naming the leader's bonus we could break together, priced as warapp_advise_diplomacy counts a bonus (its
// value a turn, and the visible defenders on the weak member). Drafts are never sent here: with
// WARAPP_CHAT_AUTOMATION on a draft carries `send` (warapp_send_chat's arguments, `automated: true`), and every
// send still goes through warapp_send_chat's confirm gate.

import type { BoardState } from '../board.js';
import { bonusTerritories } from './bonuses.js';
import { specialUnitStrength } from './combat.js';
import { neighborsOf, type MapGraph } from './graph.js';
import { underSurrenderLine, SURRENDER_TURNS, type OpponentIncome } from './outlook.js';
import type { ChatAutomation } from '../chat-automation.js';

/** Owner decision of 2026-11-23: the coalition attempt gets this many turns once the surrender line is crossed. */
export const COALITION_GRACE_TURNS = 2;

/** Owner decision of 2026-11-23: rank every viable partner, draft for this many (the top ones). */
export const OUTREACH_DRAFTS = 2;

/** The strategy notes the coalition advice rests on (ids in src/strategy/notes.ts). */
export const COALITION_NOTE_IDS = ['ffa-coalition-match-commitment', 'ffa-second-needs-third'] as const;

/** A leader's bonus a trailing player could break: the leader holds every member, and the player borders one. */
export interface LeaderBonus {
  bonus: number;
  value: number;
  /** Per trailing player bordering a member: its weakest bordered member, the visible defenders there, its armies beside. */
  by: { playerId: number; target: number; defenders: number; armiesBeside: number }[];
}

/**
 * The positive bonuses `leader` holds in full on `board` (every member visibly its own), with each other player
 * that borders a member (`candidates`, me included): the member with the fewest visible defenders it borders.
 * Largest first, then id. Pure.
 */
export function leaderBonuses(graph: MapGraph, board: BoardState, leader: number, candidates: ReadonlySet<number>): LeaderBonus[] {
  const at = new Map(board.territories.map((t) => [t.territoryId, t]));
  const ownerOf = (id: number) => {
    const o = at.get(id)?.owner;
    return o?.kind === 'player' ? o.playerId : undefined;
  };
  const out: LeaderBonus[] = [];
  for (const bonus of [...graph.bonusById.values()].sort((a, b) => a.id - b.id)) {
    if (bonus.value <= 0) continue;
    const ts = bonusTerritories(graph, bonus.id);
    if (!ts.length || !ts.every((t) => ownerOf(t) === leader)) continue;
    const by = new Map<number, LeaderBonus['by'][number]>();
    for (const t of [...ts].sort((a, b) => a - b)) {
      const defenders = (at.get(t)?.armies ?? 0) + specialUnitStrength(at.get(t)?.specialUnits);
      const beside = new Map<number, number>();
      for (const n of neighborsOf(graph, t)) {
        const p = ownerOf(n);
        if (p !== undefined && p !== leader && candidates.has(p)) beside.set(p, (beside.get(p) ?? 0) + (at.get(n)?.armies ?? 0));
      }
      for (const [p, armies] of beside) {
        const was = by.get(p);
        if (!was || defenders < was.defenders) by.set(p, { playerId: p, target: t, defenders, armiesBeside: armies });
      }
    }
    if (by.size) out.push({ bonus: bonus.id, value: bonus.value, by: [...by.values()].sort((a, b) => a.playerId - b.playerId) });
  }
  return out.sort((a, b) => b.value - a.value || a.bonus - b.bonus);
}

/** The logged turns' incomes, as the outlook log keeps them (`src/outlook-log.ts`). */
export interface LoggedIncomeTurn {
  income?: { mine: number; low: number; estimate: number };
  surrender?: { low: number; estimate: number };
}

/**
 * The consecutive turns, ending at `latest`, the outlook log shows under the surrender line (the outlook's own
 * test, {@link underSurrenderLine}, against the side it judges: the strongest anywhere when logged, else the
 * outlook's). With each one's lead: the side's estimate minus my income. Pure.
 */
export function surrenderStreak(turns: Readonly<Record<string, LoggedIncomeTurn>>, latest: number): { turns: number; leads: Map<number, number> } {
  const leads = new Map<number, number>();
  let n = 0;
  for (let t = latest; ; t--) {
    const x = turns[String(t)];
    const side = x?.surrender ?? x?.income;
    if (!x?.income || !side || !underSurrenderLine(x.income.mine, side)) break;
    leads.set(t, side.estimate - x.income.mine);
    n++;
  }
  return { turns: n, leads };
}

export interface CoalitionPartner {
  playerId: number;
  /** Its income estimate (calibrated when `calibrated`). */
  income: number;
  calibrated: boolean;
  /** The largest leader bonus it borders, priced: the leader's income lost, the weak member and its defenders. */
  jointBreak?: { bonus: number; value: number; target: number; defenders: number; theirArmiesBeside: number; myArmiesBeside?: number };
}

/** A #415 `propose` stance: a draft the owner may send; never sent here. */
export interface CoalitionDraft {
  to: number;
  stance: 'propose';
  draft: string;
  reasons: string[];
  priceWith: 'warapp_advise_diplomacy';
  noteIds: string[];
  automation: ChatAutomation;
  /** With WARAPP_CHAT_AUTOMATION on: warapp_send_chat's arguments (still confirm-gated). */
  send?: { game_id: number; message: string; to: number; automated: true };
}

export type LeftOutReason = 'broke-a-truce' | 'at-war' | 'not-bordering-leader';

export interface CoalitionAdvice {
  /** The trailing players out-earn the leader now (`now`) or once it loses a breakable bonus (`after-break`). */
  viable: boolean;
  viableBy?: 'now' | 'after-break';
  /** Viable, inside the grace window and the lead not growing: the coalition advice replaces the surrender advice. */
  inForce: boolean;
  leader: number;
  leaderIncome: number;
  /** Mine plus every viable partner's income. */
  trailingIncome: number;
  /** The largest leader bonus a viable partner or I border: the leader's income once it is broken. */
  afterBreak?: { bonus: number; value: number; leaderIncome: number };
  /** Viable partners, ranked: the largest leader bonus each borders, then income (largest), then id. */
  partners: CoalitionPartner[];
  /** The top {@link OUTREACH_DRAFTS} partners. */
  outreach: number[];
  drafts: CoalitionDraft[];
  /** Other trailing players and why they are not partners. */
  leftOut: { playerId: number; reason: LeftOutReason }[];
  /** The attempt's turn (1 on the turn the line was crossed) and the window's length. */
  graceTurn: number;
  graceTurns: number;
  /** The leader's income lead over me: when the line was crossed and now. */
  lead: { atCrossing: number; now: number; growing: boolean };
  /** One line for the owner. */
  advice: string;
}

export interface CoalitionInput {
  me: number;
  myIncome: number;
  /** The side the surrender line judges against (a player in a free-for-all) and its estimate. */
  leader: { playerId: number; estimate: number };
  /** Every opponent's income estimate (the surrender line's `opponents`). */
  opponents: readonly OpponentIncome[];
  /** Players still playing, me included (3+ needed). */
  playersLeft: number;
  bordersLeader: ReadonlySet<number>;
  /** Out of the game. */
  out?: ReadonlySet<number>;
  /** A truce broken in this game, or an attack I declared on them (the relations ledger). */
  atWar?: ReadonlySet<number>;
  /** A truce broken against me on the cross-game record. */
  breakers?: ReadonlySet<number>;
  bonuses?: readonly LeaderBonus[];
  /** The surrender line's consecutive turns crossed-or-below, and the lead per turn (see {@link surrenderStreak}). */
  turnsBelow: number;
  leads?: ReadonlyMap<number, number>;
  turn: number;
  gameId?: number;
  automation?: ChatAutomation;
}

/** `null` outside a free-for-all of three or more still playing, or when I lead. The caller checks the format. */
export function coalitionAdvice(input: CoalitionInput): CoalitionAdvice | null {
  const { me, leader } = input;
  if (input.playersLeft < 3 || leader.playerId === me) return null;
  const trailing = input.opponents.filter((o) => o.playerId !== leader.playerId && o.playerId !== me && !input.out?.has(o.playerId));
  if (!trailing.length) return null;
  const leftOut: CoalitionAdvice['leftOut'] = [];
  const viableRows: OpponentIncome[] = [];
  for (const o of trailing) {
    if (input.breakers?.has(o.playerId)) leftOut.push({ playerId: o.playerId, reason: 'broke-a-truce' });
    else if (input.atWar?.has(o.playerId)) leftOut.push({ playerId: o.playerId, reason: 'at-war' });
    else if (!input.bordersLeader.has(o.playerId)) leftOut.push({ playerId: o.playerId, reason: 'not-bordering-leader' });
    else viableRows.push(o);
  }
  const bonuses = input.bonuses ?? [];
  const partners: CoalitionPartner[] = viableRows
    .map((o) => {
      const b = bonuses.find((x) => x.by.some((y) => y.playerId === o.playerId));
      const theirs = b?.by.find((y) => y.playerId === o.playerId);
      const mine = b?.by.find((y) => y.playerId === me && y.target === theirs?.target);
      return {
        playerId: o.playerId,
        income: o.estimate,
        calibrated: o.calibrated,
        ...(b && theirs
          ? {
              jointBreak: {
                bonus: b.bonus,
                value: b.value,
                target: theirs.target,
                defenders: theirs.defenders,
                theirArmiesBeside: theirs.armiesBeside,
                ...(mine ? { myArmiesBeside: mine.armiesBeside } : {}),
              },
            }
          : {}),
      };
    })
    .sort((a, b) => (b.jointBreak?.value ?? 0) - (a.jointBreak?.value ?? 0) || b.income - a.income || a.playerId - b.playerId);
  const trailingIncome = input.myIncome + partners.reduce((n, p) => n + p.income, 0);
  const coalition = new Set([me, ...partners.map((p) => p.playerId)]);
  const breakable = bonuses.find((b) => b.by.some((y) => coalition.has(y.playerId)));
  const afterBreak = breakable ? { bonus: breakable.bonus, value: breakable.value, leaderIncome: Math.max(0, leader.estimate - breakable.value) } : undefined;
  const viableBy: CoalitionAdvice['viableBy'] = !partners.length
    ? undefined
    : trailingIncome > leader.estimate
      ? 'now'
      : afterBreak && trailingIncome > afterBreak.leaderIncome
        ? 'after-break'
        : undefined;
  const graceTurn = Math.max(1, input.turnsBelow - SURRENDER_TURNS + 1);
  const crossingTurn = input.turn - (graceTurn - 1);
  const leadNow = leader.estimate - input.myIncome;
  const atCrossing = input.leads?.get(crossingTurn) ?? leadNow;
  const growing = graceTurn > 1 && leadNow > atCrossing;
  const inGrace = graceTurn <= COALITION_GRACE_TURNS;
  const inForce = viableBy !== undefined && inGrace && !growing;
  const outreach = partners.slice(0, OUTREACH_DRAFTS).map((p) => p.playerId);
  const automation: ChatAutomation = input.automation === 'on' ? 'on' : 'off';
  const drafts: CoalitionDraft[] = inForce
    ? partners.slice(0, OUTREACH_DRAFTS).map((p) => {
        const j = p.jointBreak;
        const draft = j
          ? `Player ${leader.playerId} is pulling ahead of every one of us, and whoever it turns on next is finished. [[b:${j.bonus}]] is worth +${j.value} a turn to it, and you border it at [[t:${j.target}]]: if we both press it now we can break it before it decides the game. I propose we hold off attacking each other while we do. I will tell you before I change that.`
          : `Player ${leader.playerId} is pulling ahead of every one of us, and whoever it turns on next is finished. I propose we hold off attacking each other and both press it on our borders with it, before it decides the game. I will tell you before I change that.`;
        const reasons = [
          `A coalition against the free-for-all leader (#445): the trailing players earn ~${trailingIncome} against its ~${leader.estimate}${viableBy === 'after-break' && afterBreak ? `, ~${afterBreak.leaderIncome} once bonus ${afterBreak.bonus} (+${afterBreak.value}) breaks` : ''}.`,
          j
            ? `The joint break: bonus ${j.bonus} costs the leader +${j.value} a turn; its weak member ${j.target} shows ${j.defenders} defender${j.defenders === 1 ? '' : 's'} against ${j.theirArmiesBeside} of theirs beside it${j.myArmiesBeside !== undefined ? ` and ${j.myArmiesBeside} of mine` : ''}.`
            : 'It borders the leader, but no bonus the leader holds in full borders it on this board.',
          `Price the truce with warapp_advise_diplomacy for player ${p.playerId} before sending; record it with warapp_record_agreement once agreed.`,
          'The draft states the shared threat and only the bonus figures (public on the map); my own income is not shared.',
          automation === 'on'
            ? 'WARAPP_CHAT_AUTOMATION is on: `send` holds warapp_send_chat\'s arguments, still confirm-gated.'
            : 'WARAPP_CHAT_AUTOMATION is off: the owner sends it, through warapp_send_chat (confirm-gated).',
        ];
        return {
          to: p.playerId,
          stance: 'propose' as const,
          draft,
          reasons,
          priceWith: 'warapp_advise_diplomacy' as const,
          noteIds: [...COALITION_NOTE_IDS],
          automation,
          ...(automation === 'on' && input.gameId !== undefined ? { send: { game_id: input.gameId, message: draft, to: p.playerId, automated: true as const } } : {}),
        };
      })
    : [];
  const ranked = partners.map((p) => `player ${p.playerId}${p.jointBreak ? ` (bonus ${p.jointBreak.bonus}, +${p.jointBreak.value})` : ''}`).join(', ');
  const sums = `the trailing players together earn ~${trailingIncome} against player ${leader.playerId}'s ~${leader.estimate}`;
  const advice = inForce
    ? `Try a coalition first (attempt turn ${graceTurn} of ${COALITION_GRACE_TURNS}; advice only, nothing is sent): ${sums}${
        viableBy === 'after-break' && afterBreak ? `, and would out-earn it once bonus ${afterBreak.bonus} (+${afterBreak.value}) breaks (~${afterBreak.leaderIncome})` : ''
      }. Partners, best first: ${ranked}; drafts for player${outreach.length === 1 ? '' : 's'} ${outreach.join(', ')}. If nobody agrees within the window, or the leader's lead keeps growing, the surrender advice returns.`
    : viableBy !== undefined && growing
      ? `The coalition attempt has lapsed: the leader's lead over me grew from ~${atCrossing} to ~${leadNow} since the surrender line was crossed, so the surrender advice stands.`
      : viableBy !== undefined
        ? `The coalition attempt has had its ${COALITION_GRACE_TURNS} turns since the surrender line was crossed, so the surrender advice stands.`
        : `No coalition looks viable: ${sums}${afterBreak ? `, still not enough once bonus ${afterBreak.bonus} (+${afterBreak.value}) breaks` : ''}${partners.length ? '' : ', and no player bordering the leader is free to ask'}, so the surrender advice stands.`;
  return {
    viable: viableBy !== undefined,
    ...(viableBy ? { viableBy } : {}),
    inForce,
    leader: leader.playerId,
    leaderIncome: leader.estimate,
    trailingIncome,
    ...(afterBreak ? { afterBreak } : {}),
    partners,
    outreach,
    drafts,
    leftOut,
    graceTurn,
    graceTurns: COALITION_GRACE_TURNS,
    lead: { atCrossing, now: leadNow, growing },
    advice,
  };
}

/** The ledger as {@link atWarWith} reads it (`src/relations-store.ts`). */
export interface WarLedger {
  agreements: readonly { with: number; status: string; createdTurn: number }[];
  commitments?: readonly { kind: string; with?: number; sentTurn: number }[];
}

/**
 * The players in `among` I am at war with in this game's ledger: the latest agreement with one was broken (by
 * either side), or I declared an attack on it (a `will-attack` commitment) after the latest agreement with it was
 * made. Pure; no ledger, nobody.
 */
export function atWarWith(ledger: WarLedger | undefined, among: readonly number[]): Set<number> {
  const out = new Set<number>();
  if (!ledger) return out;
  for (const p of among) {
    const latest = ledger.agreements.filter((a) => a.with === p).sort((a, b) => b.createdTurn - a.createdTurn)[0];
    if (latest && (latest.status === 'broken-by-them' || latest.status === 'broken-by-me')) out.add(p);
    else if ((ledger.commitments ?? []).some((c) => c.kind === 'will-attack' && c.with === p && (!latest || c.sentTurn >= latest.createdTurn))) out.add(p);
  }
  return out;
}
