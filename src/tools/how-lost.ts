// How a lost game was lost (#274 item 5), for warapp_get_game: read from the boards this server
// cached while it played (src/analysis/how-lost.ts), kept name-free in the outlook log so it outlives
// the board cache, and reported with names through `untrustedText`. No request; never throws.

import { howLost, type HowLost } from '../analysis/how-lost.js';
import type { Game } from '../normalize.js';
import { readOutlookLog, readOutlookPlayer, recordLoss } from '../outlook-log.js';
import { readBoardHistory, readCachedOrders, readCachedPlayer } from '../trend.js';
import { untrustedText } from './common.js';

/** The causes a finished state gives without a board. */
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
    const held = c.held
      ? ` It held ${c.held.low}${c.held.high !== c.held.low ? `–${c.held.high}` : ''} armies and the commander (${c.armies} at the start of the turn, +${c.deployed} deployed, −${c.movedOut} moved out, +${c.movedIn} moved in); taking that needs at least ${c.attackersNeeded} attackers${c.exact ? '' : ' (at the expectation: the game has luck)'}.`
      : ` It started the turn with ${c.armies} armies and the commander; my orders that turn are not cached, so what it held is unknown.`;
    line = `${when}: my commander's territory ${named(c.territoryId)} fell${by} (inferred: losing the commander ends the game for me).${held}${bordered}`;
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

/**
 * How `game` was lost, when it is finished and the account this server cached it for did not win:
 * a surrender or a boot by its state, an elimination from the cached boards (kept in the outlook log
 * the first time, read back from there once the boards are gone). `undefined` otherwise.
 */
export async function lossReport(dir: string, game: Game): Promise<Record<string, unknown> | undefined> {
  if (game.state !== 'Finished') return undefined;
  try {
    const me = (await readCachedPlayer(dir, game.id)) ?? (await readOutlookPlayer(dir, game.id));
    if (me === undefined) return undefined;
    const state = game.players.find((p) => p.id === me)?.state;
    if (state === undefined) return undefined;
    const byState = STATE_CAUSES[state];
    if (byState) return { result: state, ...byState };
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
