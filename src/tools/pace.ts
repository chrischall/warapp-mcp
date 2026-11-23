// Pace: the boot clocks of my multi-day games, as the last game-list read in this process saw them
// (warapp_my_games, warapp_chat_inbox and every other tool that lists my games through `fetchMyGames`), so
// warapp_session_status can warn of a boot close by without a war.app request of its own.
import { BOOT_WARN_MINUTES, minutesText, type MyGame } from '../my-games.js';
import { untrustedText } from './common.js';

interface PaceSnapshot {
  /** When the list was read (epoch ms). */
  at: number;
  /** The games waiting on me with a boot clock: minutes left when read. */
  games: Array<{ id: number; name: string; leftMinutes: number }>;
}

const snapshots = new WeakMap<object, PaceSnapshot>();

/** Keep the boot clocks of `games` (summarized for me) as read at `at`, for the context `owner`. */
export function rememberPace(owner: object, games: readonly MyGame[], at: number): void {
  snapshots.set(owner, {
    at,
    games: games.flatMap((g) => (g.boot?.leftMinutes != null ? [{ id: g.id, name: g.name, leftMinutes: g.boot.leftMinutes }] : [])),
  });
}

/**
 * #532: drop one game from the kept snapshot — warapp_submit_turn calls it once war.app confirms my orders, since
 * the game no longer waits on me and the snapshot would keep naming it until the list is read again.
 */
export function forgetPaceGame(owner: object, gameId: number): void {
  const s = snapshots.get(owner);
  if (s) snapshots.set(owner, { ...s, games: s.games.filter((g) => g.id !== gameId) });
}

/** What warapp_session_status says of the pace: absent before any game list was read in this process. */
export interface PaceStatus {
  /** Minutes since the list was read. */
  listReadMinutesAgo: number;
  /** Games waiting on me whose boot is under six hours away now (the time since the read taken off), soonest first. */
  bootSoon: Array<{ id: number; name: string; leftMinutes: number; left: string }>;
  note: string;
}

export const PACE_NOTE =
  `Read from the last game list this server read (warapp_my_games and the chat inbox read it): each game waiting on you ` +
  `whose boot time plus your banked time, less how long your turn has run, is under ${BOOT_WARN_MINUTES / 60} hours ` +
  'away now. Unverified live; call warapp_my_games for a fresh read.';

export function paceStatus(owner: object, now: number): PaceStatus | undefined {
  const s = snapshots.get(owner);
  if (!s) return undefined;
  const ago = Math.max(0, Math.floor((now - s.at) / 60_000));
  const bootSoon = s.games
    .map((g) => ({ ...g, leftMinutes: Math.max(0, g.leftMinutes - ago) }))
    .filter((g) => g.leftMinutes < BOOT_WARN_MINUTES)
    .sort((a, b) => a.leftMinutes - b.leftMinutes || a.id - b.id)
    .map((g) => ({ id: g.id, name: untrustedText(g.name), leftMinutes: g.leftMinutes, left: minutesText(g.leftMinutes) }));
  return { listReadMinutesAgo: ago, bootSoon, note: PACE_NOTE };
}

/** The warning line for the games close to a boot, or undefined. */
export function paceWarning(p: PaceStatus | undefined): string | undefined {
  if (!p?.bootSoon.length) return undefined;
  return (
    `Boot close: ${p.bootSoon.map((g) => `game ${g.id} in ${g.left}`).join(', ')} — take ${p.bootSoon.length === 1 ? 'that turn' : 'those turns'} ` +
    `(under ${BOOT_WARN_MINUTES / 60} hours left, boot time plus bank).`
  );
}
