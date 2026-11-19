// Where to play the cards warapp_submit_turn can play but the planner never does (PLAN-TEAMS part D2):
// Diplomacy on the opponent pressing me hardest when two or more are, Sanctions on the leader, Airlift
// onto a border of mine or a teammate's that falls without it, and Gift as team support (a territory
// that completes a teammate's bonus); and (G2) Spy, Reconnaissance and Surveillance only where the fog
// hides what the plan needs. Advice only: nothing here changes the plan or its orders. Pure and
// deterministic (ties on ascending id); no I/O.
//
// Rules (docs/STRATEGY.md, the wiki's card pages): a Diplomacy card stops attacks between its two
// players from the turn after it is played; Sanctions cut the target's income from its next turn (a
// negative percentage raises it); an Airlift lands after the deploys and before every attack, and armies
// landing on a teammate's territory become the teammate's; a Gift moves a territory and its armies after
// the airlifts and before the attacks. The card plays' encodings are UNVERIFIED live (V9) save Airlift's (#296)
// and Diplomacy's (#369: played live 2026-11-18 and read in force on later boards).

import { bonusTerritories } from './bonuses.js';
import { COMMANDER_STRENGTH } from './combat.js';
import { reader, type CardBoard } from './card-threats.js';
import { neighborsOf } from './graph.js';
import { ownerShown, visibleState } from './plan/shared.js';
import type { SharedBonus } from './plan/team.js';

/** A truce in force, as the Diplomacy advice reads it (the plan's relations). */
export interface TruceCover {
  player: number;
  state: 'active' | 'notice';
  /** My territories the truce covers. */
  coveredMine: readonly number[];
  endsTurn?: number;
}

/** What one opponent's stacks beside me tie down: the armies my borders keep against it alone. */
interface Pressure {
  player: number;
  /** Armies my borders (after the plan) must hold against it alone, summed over the borders it touches. */
  armies: number;
  /** The borders it can take this turn as the plan leaves them. */
  takes: number[];
  /** My borders it touches, ascending. */
  borders: number[];
}

/**
 * Each opponent in contact with me (a visible stack beside a territory of mine), with the armies my
 * borders must keep against it alone: what a Diplomacy card with it frees. Strongest pressure first
 * (then ascending id).
 */
export function pressures(cb: CardBoard): Pressure[] {
  const r = reader(cb);
  const by = new Map<number, Pressure>();
  for (const b of r.ids) {
    if (!r.isMine(b)) continue;
    const cmd = r.commanderOf(b, (q) => q === cb.me);
    for (const [player, reach] of r.reachByPlayer(b)) {
      const p = by.get(player) ?? { player, armies: 0, takes: [], borders: [] };
      p.borders.push(b);
      p.armies += r.holdNeed(reach, cmd) + (cmd ? COMMANDER_STRENGTH : 0);
      if (r.toTake(r.after(b) + (cmd ? COMMANDER_STRENGTH : 0)) <= reach) p.takes.push(b);
      by.set(player, p);
    }
  }
  return [...by.values()].sort((a, b) => b.armies - a.armies || a.player - b.player);
}

export interface DiplomacyAdvice {
  /** The opponent to name with me; absent: no opponent worth it. */
  player?: number;
  pressure?: Pressure;
  /** A truce partner it is played on anyway, and why it adds protection. */
  overTruce?: string;
  why: string;
  /** Opponents passed over, and why (a truce that covers them, a Diplomacy card already in force). */
  skipped: string[];
}

/**
 * Diplomacy on the opponent pressing me hardest, when two or more opponents are in contact (with
 * one, peace with it is peace with everyone: the card is a truce for nothing). An opponent already at
 * peace with me by a Diplomacy card in force is passed over, and so is a truce partner whose truce
 * already covers every border it touches — unless the card adds protection: the truce is in notice
 * (it ends), or the partner presses a border the truce does not cover. Either way it is said.
 * `undefined` with fewer than two opponents in contact.
 */
export function diplomacyAdvice(
  cb: CardBoard,
  opts: { atPeace?: ReadonlySet<number>; truces?: readonly TruceCover[] } = {},
): DiplomacyAdvice | undefined {
  const all = pressures(cb);
  if (all.length < 2) return undefined;
  const skipped: string[] = [];
  for (const p of all) {
    if (opts.atPeace?.has(p.player)) {
      skipped.push(`player ${p.player}: a Diplomacy card between you is already in force`);
      continue;
    }
    const truce = opts.truces?.find((t) => t.player === p.player);
    let overTruce: string | undefined;
    if (truce) {
      const covered = new Set(truce.coveredMine);
      const open = p.borders.filter((b) => !covered.has(b));
      if (truce.state === 'notice') {
        overTruce = `your truce with player ${p.player} is in notice${truce.endsTurn !== undefined ? ` (it ends turn ${truce.endsTurn})` : ''}, and a Diplomacy card is enforced by the game`;
      } else if (open.length) {
        overTruce = `your truce with player ${p.player} does not cover ${open.join(', ')}, which it presses`;
      } else {
        skipped.push(`player ${p.player}: your truce already covers every border it presses, so the card adds nothing the truce does not`);
        continue;
      }
    }
    if (p.armies <= 0) break;
    const takes = p.takes.length ? `; as the plan leaves them it can take ${p.takes.join(', ')}` : '';
    return {
      player: p.player,
      pressure: p,
      ...(overTruce ? { overTruce } : {}),
      why:
        `Diplomacy with player ${p.player}: of the ${all.length} opponents beside you it presses hardest — your borders ${p.borders.join(', ')} ` +
        `keep ${p.armies} armies against it alone${takes}.${overTruce ? ` Played on a truce partner because ${overTruce}.` : ''}`,
      skipped,
    };
  }
  return { why: 'Hold the Diplomacy card: no opponent beside you is worth it this turn.', skipped };
}

/** One player's strength for the Sanctions advice: visible armies + a few turns of income. */
export interface Strength {
  playerId: number;
  strength: number;
}

export interface SanctionsAdvice {
  /** The player to sanction; absent: every opponent in sight was passed over (`skipped` says why). */
  player?: number;
  why: string;
  /** G2: opponents passed over, and why (a truce partner, a Diplomacy card with me in force). */
  skipped?: string[];
}

/**
 * Sanctions on the strongest opponent (the leader, or the strongest other player when I lead); with a
 * negative percentage the card raises income, so on me. G2: an opponent in `pass` (a truce partner, a
 * player a Diplomacy card keeps at peace with me) is passed over, its reason stated. `undefined` with no
 * opponent in sight.
 */
export function sanctionsAdvice(input: {
  me: number;
  players: readonly Strength[];
  percentage?: number;
  pass?: ReadonlyMap<number, string>;
}): SanctionsAdvice | undefined {
  const { me, players, percentage } = input;
  if (percentage !== undefined && percentage < 0) {
    return { player: me, why: `Sanctions on yourself: this game's percentage is negative (${Math.round(percentage * 100)}%), so the card raises the target's income.` };
  }
  const ranked = [...players].sort((a, b) => b.strength - a.strength || a.playerId - b.playerId);
  const opponents = ranked.filter((p) => p.playerId !== me);
  if (!opponents.length) return undefined;
  const skipped = opponents.flatMap((p) => (input.pass?.has(p.playerId) ? [`player ${p.playerId}: ${input.pass.get(p.playerId)}`] : []));
  const passed = skipped.length ? ` Passed over: ${skipped.join('; ')}.` : '';
  const top = opponents.find((p) => !input.pass?.has(p.playerId));
  if (!top) return { why: `Hold the Sanctions card: no opponent in sight is one to sanction.${passed}`, skipped };
  const lead = ranked[0]!.playerId === me;
  const pct = percentage !== undefined ? ` by ${Math.round(percentage * 100)}%` : '';
  const strongest = top === opponents[0];
  return {
    player: top.playerId,
    why:
      `Sanctions on player ${top.playerId}: ${lead ? `you lead, and it is the strongest opponent${strongest ? '' : ' left'}` : strongest ? 'it leads' : 'it is the strongest opponent left'} on strength (visible armies + ` +
      `income: ${top.strength}). A sanction cuts its income${pct} from its next turn, so a cut costs the largest player most; play it the turn before you attack.${passed}`,
    ...(skipped.length ? { skipped } : {}),
  };
}

export interface AirliftAdvice {
  from: number;
  to: number;
  armies: number;
  /** The teammate whose territory it lands on (the armies become theirs); absent: mine. */
  teammate?: number;
  /** What would take the territory without it. */
  player: number;
  reach: number;
  commander: boolean;
  why: string;
}

/**
 * An Airlift onto a territory that falls this turn without it — mine as the plan leaves it, or (in a
 * team game) a teammate's with the deploys it has entered; never one the plan moves armies out of — from a territory of mine with armies to
 * spare (what stands there after the deploys, less what the plan moves out of it and what it must
 * keep to hold). A commander's territory first, then the most armies at stake, then ascending id; the
 * first one a source can save. `undefined` when none.
 */
export function airliftAdvice(cb: CardBoard): AirliftAdvice | undefined {
  const r = reader(cb);
  const teammateDeploy = (t: number) =>
    (cb.board.teammateOrders ?? []).reduce(
      (a, e) => a + (e.orders?.deploys ?? []).filter((d) => d.territoryId === t).reduce((x, d) => x + d.armies, 0),
      0,
    );
  const friendOf = (t: number) => {
    const p = r.ownerOf(t);
    return p !== undefined && cb.friends?.has(p) ? p : undefined;
  };
  interface Target {
    id: number;
    teammate?: number;
    armies: number;
    commander: boolean;
    player: number;
    reach: number;
    need: number;
  }
  const targets: Target[] = [];
  for (const t of r.ids) {
    const teammate = friendOf(t);
    if (!r.isMine(t) && teammate === undefined) continue;
    // A border the plan withdraws from is given up on purpose: no airlift into it.
    if (teammate === undefined && r.outOf(t) > 0) continue;
    if (r.state.get(t)?.armies === null) continue;
    const reach = r.reachOf(t);
    if (!reach) continue;
    const owner = teammate ?? cb.me;
    const commander = r.commanderOf(t, (q) => q === owner);
    const armies = teammate === undefined ? r.after(t) : r.armiesOf(t) + teammateDeploy(t);
    const need = r.holdNeed(reach.reach, commander) - armies;
    if (need <= 0) continue;
    targets.push({ id: t, ...(teammate !== undefined ? { teammate } : {}), armies, commander, player: reach.player, reach: reach.reach, need });
  }
  targets.sort((a, b) => Number(b.commander) - Number(a.commander) || b.armies - a.armies || a.id - b.id);
  // What each territory of mine can spare: after the deploys, less the plan's moves out of it, less what it
  // keeps to hold (a commander's own territory keeps its hold too).
  const spare = new Map<number, number>();
  for (const s of r.ids) {
    if (!r.isMine(s)) continue;
    const reach = r.reachOf(s)?.reach;
    const keep = Math.max(r.guard, reach === undefined ? 0 : r.holdNeed(reach, r.commanderOf(s, (q) => q === cb.me)));
    const can = Math.min(r.armiesOf(s) + r.deployAt(s) - r.outOf(s), r.after(s)) - keep;
    if (can > 0) spare.set(s, can);
  }
  for (const t of targets) {
    let best: number | undefined;
    for (const [s, can] of spare) {
      if (s === t.id || can < t.need) continue;
      if (best === undefined || can > spare.get(best)! || (can === spare.get(best)! && s < best)) best = s;
    }
    if (best === undefined) continue;
    const where = t.teammate !== undefined ? `your teammate ${t.teammate}'s ${t.id}` : `${t.id}`;
    return {
      from: best,
      to: t.id,
      armies: t.need,
      ...(t.teammate !== undefined ? { teammate: t.teammate } : {}),
      player: t.player,
      reach: t.reach,
      commander: t.commander,
      why:
        `Airlift ${t.need} from ${best} to ${where}${t.commander ? ' (a commander stands there)' : ''}: its ${t.armies} fall to player ${t.player}'s ~${t.reach}, ` +
        `and ${t.armies + t.need} hold; the airlift lands before any attack.` +
        (t.teammate !== undefined ? " The armies become your teammate's, and hold only if your teammate keeps them there: say so in team chat." : ''),
    };
  }
  return undefined;
}

export interface GiftAdvice {
  player: number;
  bonus: number;
  value: number;
  territories: number[];
  why: string;
}

/**
 * A Gift as team support: my members of a bonus a teammate is nearer to holding, when giving them
 * completes it (every other member is the teammate's) and I hold enough Gift cards — never a territory
 * with a special unit on it (war.app refuses it) or one the plan moves armies out of. The most valuable
 * bonus first, then ascending id. `undefined` when none.
 */
export function giftAdvice(cb: CardBoard, shared: readonly SharedBonus[], gifts: number): GiftAdvice | undefined {
  if (gifts <= 0) return undefined;
  const r = reader(cb);
  const ok = (t: number) => !(r.state.get(t)?.specialUnits ?? []).length && r.outOf(t) === 0;
  const best = [...shared]
    .filter((b) => b.nearer !== null && b.nearer !== cb.me && !b.others.length && b.teammates.length === 1 && b.mine.length <= gifts && b.mine.every(ok))
    .sort((a, b) => b.value - a.value || a.bonusId - b.bonusId)[0];
  if (!best) return undefined;
  const mate = best.teammates[0]!.player;
  const borders = best.mine.filter((t) => r.reachOf(t) !== undefined);
  return {
    player: mate,
    bonus: best.bonusId,
    value: best.value,
    territories: [...best.mine],
    why:
      `Gift ${best.mine.join(', ')} to your teammate ${mate}: it holds every other member of bonus ${best.bonusId}, so the gift completes it ` +
      `(+${best.value} a turn for the team; a bonus pays only the player who holds all of it).` +
      (borders.length ? ` ${borders.join(', ')} ${borders.length === 1 ? 'faces' : 'face'} an opponent: your teammate must hold ${borders.length === 1 ? 'it' : 'them'}.` : ''),
  };
}

/** The information cards (G2): Spy (a player), Reconnaissance (a territory), Surveillance (a bonus). */
export type IntelCard = 'Spy' | 'Reconnaissance' | 'Surveillance';

export interface IntelAdvice {
  card: IntelCard;
  /** Spy: the player to see. */
  player?: number;
  /** Reconnaissance: the territory to see. */
  target?: number;
  /** Surveillance: the bonus to see. */
  bonus?: number;
  why: string;
}

/**
 * G2: where an information card reveals something the plan needs — never with fog off, and never just
 * to see more. Three needs, read off the board: a border of mine whose neighbour the fog hides (its
 * armies unknown: an opponent may stand there), a bonus I am completing (I hold half its members or more, not all) with
 * a member the fog hides, and an opponent with no territory in view. Spy goes on an unseen opponent, else
 * on the owner shown beside the most hidden stacks next to me; Surveillance on the bonus I am completing
 * that is nearest done (then the most valuable, then ascending id), else the bonus worth the most with a
 * hidden border of mine in it; Reconnaissance on the hidden territory next to the most of mine (then the
 * most armies of mine beside it, then ascending id), else a hidden member of the bonus I am completing.
 * `hold` says, for a card held with nothing to reveal, why it is kept. Pure; ties on ascending id.
 */
export function intelAdvice(
  cb: CardBoard,
  opts: { fog?: string; opponents: readonly number[]; held: ReadonlySet<IntelCard> },
): { advice: IntelAdvice[]; hold: string[] } {
  if (opts.fog === 'NoFog' || !opts.held.size) return { advice: [], hold: [] };
  const r = reader(cb);
  const hidden = (t: number) => !visibleState(r.state.get(t));
  const mineNext = (t: number) => neighborsOf(cb.graph, t).filter((n) => r.isMine(n));
  // A border of mine whose neighbour the fog hides.
  const blind = r.ids
    .filter((t) => !r.isMine(t) && hidden(t) && mineNext(t).length)
    .map((t) => ({ t, next: mineNext(t).length, armies: mineNext(t).reduce((a, n) => a + r.armiesOf(n), 0) }))
    .sort((a, b) => b.next - a.next || b.armies - a.armies || a.t - b.t);
  // A bonus I am completing with a member the fog hides.
  const building = cb.graph.map.bonuses
    .filter((b) => b.value > 0)
    .map((b) => {
      const ts = bonusTerritories(cb.graph, b.id);
      const held = ts.filter((t) => r.isMine(t)).length;
      return { id: b.id, value: b.value, size: ts.length, held, fogged: ts.filter((t) => !r.isMine(t) && hidden(t)) };
    })
    .filter((b) => b.size > 0 && 2 * b.held >= b.size && b.held < b.size && b.fogged.length)
    .sort((a, b) => b.held / b.size - a.held / a.size || b.value - a.value || a.id - b.id);
  // An opponent with no territory in view.
  const inView = new Set(r.ids.flatMap((t) => {
    const s = ownerShown(r.state.get(t));
    return s?.owner.kind === 'player' ? [s.owner.playerId] : [];
  }));
  const unseen = [...opts.opponents].filter((p) => p !== cb.me && !cb.friends?.has(p) && !inView.has(p)).sort((a, b) => a - b);
  // An owner shown beside me whose stack the fog hides (owner-only fog).
  const shownBeside = new Map<number, number>();
  for (const { t } of blind) {
    const s = ownerShown(r.state.get(t));
    if (s?.owner.kind === 'player' && r.foe(s.owner.playerId)) shownBeside.set(s.owner.playerId, (shownBeside.get(s.owner.playerId) ?? 0) + 1);
  }
  const hiddenStacks = [...shownBeside].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];

  const advice: IntelAdvice[] = [];
  const hold: string[] = [];
  const nothing = (card: IntelCard) =>
    hold.push(`Hold the ${card} card: the fog hides nothing the plan needs this turn (no hidden border of yours, no bonus you are completing with a fogged member, no opponent out of view).`);
  if (opts.held.has('Spy')) {
    if (unseen.length) {
      const p = unseen[0]!;
      advice.push({ card: 'Spy', player: p, why: `Spy on player ${p}: none of its territories is in view, so its income and stacks are unknown to the plan.` });
    } else if (hiddenStacks) {
      const [p, n] = hiddenStacks;
      advice.push({
        card: 'Spy',
        player: p,
        why: `Spy on player ${p}: the fog hides the armies on ${n === 1 ? 'its territory' : `${n} of its territories`} beside yours, so the threat there is a guess.`,
      });
    } else nothing('Spy');
  }
  if (opts.held.has('Surveillance')) {
    const b = building[0];
    if (b) {
      advice.push({
        card: 'Surveillance',
        bonus: b.id,
        why: `Surveillance on bonus ${b.id}: you hold ${b.held} of its ${b.size} territories and the fog hides ${b.fogged.join(', ')}, so what finishing it costs is a guess.`,
      });
    } else {
      const blindSet = new Set(blind.map((x) => x.t));
      const best = cb.graph.map.bonuses
        .filter((x) => x.value > 0)
        .map((x) => ({ id: x.id, value: x.value, n: bonusTerritories(cb.graph, x.id).filter((t) => blindSet.has(t)).length }))
        .filter((x) => x.n > 0)
        .sort((a, c) => c.value - a.value || c.n - a.n || a.id - c.id)[0];
      if (best)
        advice.push({
          card: 'Surveillance',
          bonus: best.id,
          why: `Surveillance on bonus ${best.id} (+${best.value}): the fog hides ${best.n} of its territories beside yours, so who holds it, and what they earn, is a guess.`,
        });
      else nothing('Surveillance');
    }
  }
  if (opts.held.has('Reconnaissance')) {
    const x = blind[0];
    if (x) {
      advice.push({
        card: 'Reconnaissance',
        target: x.t,
        why: `Reconnaissance on ${x.t}: it borders ${x.next} of your territories (${x.armies} armies) and the fog hides what stands there.`,
      });
    } else if (building[0]) {
      const t = building[0].fogged[0]!;
      advice.push({ card: 'Reconnaissance', target: t, why: `Reconnaissance on ${t}: a member of bonus ${building[0].id}, which you are completing, hidden by the fog.` });
    } else nothing('Reconnaissance');
  }
  return { advice, hold };
}
