// How a lost game was lost (#274 item 5), for warapp_get_game (#283: also a seat of mine out of a game still playing): read from the boards this server
// cached while it played (src/analysis/how-lost.ts), kept name-free in the outlook log so it outlives
// the board cache, and reported with names through `untrustedText`. No request; never throws.

import { howLost, type HowLost } from '../analysis/how-lost.js';
import type { Game } from '../normalize.js';
import { readOutlookLog, readOutlookPlayer, recordLoss, type OutlookLog } from '../outlook-log.js';
import { readBoardHistory, readCachedOrders, readCachedPlayer } from '../trend.js';
import { untrustedText } from './common.js';

/** #283: the seat states that put me out of a game, whether or not the others play on. */
const OUT_STATES: ReadonlySet<string> = new Set(['Eliminated', 'Booted', 'SurrenderAccepted']);

/** The causes a seat's state gives without a board (#283: `seatOut` adds the last turn and outlook). */
const STATE_CAUSES: Record<string, { cause: string; line: string }> = {
  SurrenderAccepted: { cause: 'surrendered', line: 'Surrendered (accepted).' },
  Booted: { cause: 'booted', line: 'Booted from the game.' },
};

function report(loss: HowLost, game: Game): Record<string, unknown> {
  const playerName = (id: number) => untrustedText(game.players.find((p) => p.id === id)?.name ?? id);
  const territoryName = (id: number) => {
    const t = game.map?.territories.find((x) => x.id === id);
    return t ? untrustedText(t.name) : null;
  };
  const named = (id: number) => {
    const n = territoryName(id);
    return n ? `${id} ${n}` : String(id);
  };
  const neighbours = loss.neighbours?.map((n) => ({ ...n, ...(n.playerId !== null ? { name: playerName(n.playerId) } : {}) })) ?? null;
  const when = `Eliminated on turn ${loss.turn}${loss.turnCertain ? '' : ' (the last turn cached here; the loss may have come later)'}`;
  const bordered =
    neighbours?.length
      ? ` Bordered by ${neighbours
          .map((n) => `${n.playerId === null ? 'owners hidden by the fog' : n.name} on ${n.territories} territor${n.territories === 1 ? 'y' : 'ies'}${n.armies !== null ? ` (${n.armies} armies in view)` : ''}`)
          .join(', ')}.`
      : '';
  const by = loss.by !== null ? ` to ${playerName(loss.by)}` : '';
  let line: string;
  const c = loss.commander;
  if (c) {
    const range = c.held ? `${c.held.low}${c.held.high !== c.held.low ? `–${c.held.high}` : ''}` : '';
    const held = c.held
      ? ` It held ${c.held.uncertain ? `about ${range}` : range} armies and the commander (${c.armies} at the start of the turn, +${c.deployed} deployed, −${c.movedOut} moved out, +${c.movedIn} moved in${c.walk ? `, the walk's ${c.walk.armies} among them` : ''}); taking that needs at least ${c.attackersNeeded} attackers${c.exact ? '' : ' (at the expectation: the game has luck)'}${c.held.uncertain ? ' — a bound only: an order this count leaves out (a percentage, Attack Only or Transfer Only order, or a card play) touched it' : ''}.`
      : c.walk
        ? ` My orders that turn do not say what it held there${c.walk.armies === null ? ' (the walk was a percentage order)' : ''}.`
        : ` It started the turn with ${c.armies} armies and the commander; my orders that turn are not cached, so what it held is unknown.`;
    line = c.walk
      ? `${when}: my commander walked from ${named(c.walk.from)} to ${named(c.territoryId)} that turn; it fell on ${named(c.territoryId)}${by}, or on ${named(c.walk.from)} before the walk ran (inferred: losing the commander ends the game for me; which of the two is not known).${held}${bordered}`
      : `${when}: my commander's territory ${named(c.territoryId)} fell${by} (inferred: losing the commander ends the game for me).${held}${bordered}`;
  } else if (loss.cause === 'last-territories') {
    const ids = (loss.lastTerritories ?? []).map((t) => named(t.territoryId)).join(', ');
    line = `${when}: my last ${loss.territoriesHeld} territor${loss.territoriesHeld === 1 ? 'y' : 'ies'} fell${by} (${ids}${loss.territoriesHeld > (loss.lastTerritories?.length ?? 0) ? ', …' : ''}).${bordered}`;
  } else {
    line = `${when}; the cached board does not show my commander, so the cause is unknown.`;
  }
  return {
    result: 'Eliminated',
    ...loss,
    ...(c ? { commander: { ...c, territoryName: territoryName(c.territoryId) } } : {}),
    neighbours,
    by: loss.by !== null ? { id: loss.by, name: playerName(loss.by) } : null,
    line,
  };
}

/** The newest turn this server played `gameId` on: a cached board where I held land, or a logged outlook. */
async function lastPlayed(dir: string, gameId: number, me: number): Promise<{ turn: number; log: OutlookLog | undefined } | undefined> {
  const log = await readOutlookLog(dir, gameId, me);
  const boards = await readBoardHistory(dir, gameId, me);
  const held = boards
    .filter((b) => b.board.territories.some((t) => t.owner.kind === 'player' && t.owner.playerId === me))
    .map((b) => b.turn);
  const logged = Object.keys(log?.turns ?? {}).map(Number).filter(Number.isInteger);
  const all = [...held, ...logged];
  return all.length ? { turn: Math.max(...all), log } : undefined;
}

/**
 * #283: a surrender or a boot, by my seat's state, with the last turn played here and the outlook logged
 * last (its state, and my armies and income against the strongest side's in view, when logged).
 */
function seatOut(
  result: string,
  byState: { cause: string; line: string },
  last: { turn: number; log: OutlookLog | undefined } | undefined,
  game: Game,
): Record<string, unknown> {
  if (!last) return { result, ...byState };
  const { turn, log } = last;
  const loggedTurn = Math.max(...Object.keys(log?.turns ?? {}).map(Number).filter(Number.isInteger).filter((t) => t <= turn));
  const entry = Number.isFinite(loggedTurn) ? log!.turns[String(loggedTurn)] : undefined;
  const head = `${byState.line} The last turn played here was turn ${turn}`;
  if (!entry) return { result, ...byState, turn, line: `${head}; no outlook was logged for it.` };
  const latest = log!.latest;
  const held =
    latest && latest.turn === loggedTurn && latest.state !== null
      ? { state: latest.state, ...(latest.lean ? { lean: latest.lean } : {}), turns: latest.heldTurns }
      : undefined;
  const f = entry.figures;
  const s = f?.strongest;
  const who = s
    ? s.team !== undefined
      ? `team ${s.team}`
      : untrustedText(game.players.find((p) => p.id === s.playerId)?.name ?? s.playerId)
    : undefined;
  // #522: the incomes behind the visible bonus income — under fog a leader's in-view income can sit at the base
  // while it earns several times that. Its tracked income and frontier read (#304's evidence), and the
  // calibrated range when the outlook's income side (#436) is the same side.
  const nameOf = (side: { playerId: number; team?: number }) =>
    side.team !== undefined ? `team ${side.team}` : untrustedText(game.players.find((p) => p.id === side.playerId)?.name ?? side.playerId);
  const sameSide = (a: { playerId: number; team?: number }, b: { playerId?: number; team?: number }) =>
    a.team !== undefined ? a.team === b.team : a.playerId === b.playerId && b.team === undefined;
  const members = s ? (s.team !== undefined ? game.players.filter((p) => p.team === s.team).map((p) => p.id) : [s.playerId]) : [];
  const trackedRows = (entry.evidence?.opponents ?? []).filter((r) => members.includes(r.playerId) && r.source === 'tracked');
  const tracked = trackedRows.length ? trackedRows.reduce((n, r) => n + r.income, 0) : undefined;
  const coverage = s?.team === undefined && trackedRows.length === 1 ? trackedRows[0]!.coverage : undefined;
  const inc = entry.income;
  const estimate =
    s && inc && inc.playerId !== undefined && sameSide(s, inc)
      ? { low: inc.low, high: inc.high, estimate: inc.estimate, calibrated: inc.calibrated }
      : undefined;
  // The strongest on income when it is another side: the surrender line's side anywhere (large games), else the outlook's own.
  const leaderOf = (): { playerId: number; team?: number; low: number; high?: number; estimate: number; calibrated: boolean; anywhere?: true } | undefined => {
    const sur = entry.surrender;
    if (sur) return { ...sur, anywhere: true };
    if (inc && inc.playerId !== undefined)
      return { playerId: inc.playerId, ...(inc.team !== undefined ? { team: inc.team } : {}), low: inc.low, high: inc.high, estimate: inc.estimate, calibrated: inc.calibrated };
    return undefined;
  };
  const leaderSide = leaderOf();
  const leader = leaderSide && !(s && sameSide(s, leaderSide)) ? leaderSide : undefined;
  const calText = (calibrated: boolean) => (calibrated ? "calibrated on past games' estimate ÷ truth" : 'uncalibrated');
  const outlook = {
    turn: loggedTurn,
    state: entry.state,
    // #454: the income lean beside an even state (additive).
    ...(entry.lean ? { lean: entry.lean } : {}),
    ...(held ? { held } : {}),
    ...(f ? { mine: f.mine } : {}),
    ...(s
      ? {
          strongest: {
            id: s.playerId,
            ...(s.team !== undefined ? { team: s.team } : {}),
            name: who,
            armies: s.armies,
            income: s.income,
            ...(tracked !== undefined ? { tracked } : {}),
            ...(coverage !== undefined ? { coverage } : {}),
            ...(estimate ? { estimate } : {}),
          },
        }
      : {}),
    ...(leader
      ? {
          incomeLeader: {
            id: leader.playerId,
            ...(leader.team !== undefined ? { team: leader.team } : {}),
            name: nameOf(leader),
            low: leader.low,
            ...(leader.high !== undefined ? { high: leader.high } : {}),
            estimate: leader.estimate,
            calibrated: leader.calibrated,
            ...(leader.anywhere ? { anywhere: true } : {}),
          },
        }
      : {}),
  };
  const read = `${loggedTurn === turn ? 'its outlook' : `the last outlook logged (turn ${loggedTurn})`} read ${entry.lean ? `${entry.state}, leaning ${entry.lean} on the incomes` : entry.state}${held ? ` (held ${held.turns} turn${held.turns === 1 ? '' : 's'})` : ''}`;
  const range = (low: number, high: number | undefined) => (high !== undefined && high > low ? `, range ${low}–${high}` : '');
  const behind = [
    tracked !== undefined ? `tracked ${tracked}${coverage != null ? `, ${Math.round(coverage * 100)}% of its frontier read` : ''}` : '',
    estimate ? `estimated ~${estimate.estimate}${range(estimate.low, estimate.high)}, ${calText(estimate.calibrated)}` : '',
  ].filter(Boolean);
  const against = !s
    ? ', no opponent in view'
    : behind.length
      ? ` against ${who}'s income ${s.income} in view (${behind.join('; ')}) and ${s.armies} armies in view`
      : ` against ${who}'s ${s.income} and ${s.armies} in view`;
  const figures = !f ? ' (the armies and income behind it were not logged then)' : `: my income ${f.mine.income} and ${f.mine.armies} armies${against}`;
  const leaderText = leader
    ? ` The strongest on income${leader.anywhere ? ', near or not' : ''}: ${nameOf(leader)}'s ~${leader.estimate} (tracked ${leader.low}${range(leader.low, leader.high)}; ${calText(leader.calibrated)}).`
    : '';
  return { result, ...byState, turn, outlook, line: `${head}; ${read}${figures}.${leaderText}` };
}

/**
 * How `game` was lost, when the account this server cached it for did not win it: once it is finished,
 * or (#283) while it is still playing once my seat is out (eliminated, booted or surrendered). A
 * surrender or a boot by its state, an elimination from the cached boards (kept in the outlook log
 * the first time, read back from there once the boards are gone). `undefined` otherwise.
 */
export async function lossReport(dir: string, game: Game): Promise<Record<string, unknown> | undefined> {
  try {
    const finished = game.state === 'Finished';
    // #283: a seat of mine that is out is reported while the others play on; no disk read otherwise.
    if (!finished && !game.players.some((p) => p.state !== undefined && OUT_STATES.has(p.state))) return undefined;
    const me = (await readCachedPlayer(dir, game.id)) ?? (await readOutlookPlayer(dir, game.id));
    if (me === undefined) return undefined;
    const state = game.players.find((p) => p.id === me)?.state;
    if (state === undefined || (!finished && !OUT_STATES.has(state))) return undefined;
    const byState = STATE_CAUSES[state];
    if (byState) return seatOut(state, byState, await lastPlayed(dir, game.id, me), game);
    if (state !== 'Eliminated') return undefined;
    const boards = await readBoardHistory(dir, game.id, me);
    const s = game.settings;
    const fresh = howLost({
      me,
      boards,
      orders: await readCachedOrders(dir, game.id, me),
      ...(game.map ? { adjacency: new Map(game.map.territories.map((t) => [t.id, t.connectedTo])) } : {}),
      rates: {
        ...(s?.offensiveKillRate !== undefined ? { offensiveKillRate: s.offensiveKillRate } : {}),
        ...(s?.defensiveKillRate !== undefined ? { defensiveKillRate: s.defensiveKillRate } : {}),
        ...(s?.luckModifier !== undefined ? { luck: s.luckModifier } : {}),
        ...(s?.roundingMode !== undefined ? { rounding: s.roundingMode } : {}),
      },
      ...(game.numberOfTurns !== undefined ? { turnsCompleted: game.numberOfTurns } : {}),
      ...(s?.commanders !== undefined ? { commanders: s.commanders } : {}),
    });
    if (fresh) await recordLoss(dir, game.id, me, fresh);
    const loss = fresh ?? (await readOutlookLog(dir, game.id, me))?.loss;
    return loss ? report(loss, game) : undefined;
  } catch {
    return undefined;
  }
}
