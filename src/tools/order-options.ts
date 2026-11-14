// The options an attack/transfer order can carry (#165): Transfer Only, Attack Only, a percentage
// of the armies, the commander, and attacking teammates. Each is refused unless the game allows
// it — war.app's own validator refuses a percentage order (error 360), Transfer Only (361) and
// Attack Only (362) when the setting is off (read from the client bundle) — and every one is
// UNVERIFIED against a live commit: the encoding follows the client's writer (docs/WEB-PROTOCOL.md).
import { McpToolError } from '@chrischall/mcp-utils';
import { percentOf } from '../analysis/turn-sim.js';
import type { LiveTerritory } from '../live.js';
import type { GameSettings } from '../normalize.js';
import type { OrderCommander } from '../protocol/methods.js';
import { untrustedText } from './common.js';

/** A move's mode, as warapp_submit_turn takes it. */
export const MOVE_MODES = ['attack-transfer', 'attack-only', 'transfer-only'] as const;
export type MoveMode = (typeof MOVE_MODES)[number];

type Place = { id: number; name: string };

/** A resolved move with its options, as {@link checkMoveOptions} reads it. */
export interface OptionMove {
  from: Place;
  to: Place;
  /** Armies; with `percent`, the percentage. */
  armies: number;
  mode?: MoveMode;
  percent?: boolean;
  commander?: boolean;
  attackTeammates?: boolean;
}

interface MoveOptionsCheck {
  warnings: string[];
  /** Move index → the commander it takes along (GUID and owner, from the live board). */
  commanders: Map<number, OrderCommander>;
  /** Move index → for a percentage order, the armies it would send on the board as it stands now. */
  estimates: Map<number, number>;
}

/** Options used, said once per preview: none of them has been sent in a live commit yet. */
const OPTIONS_UNVERIFIED =
  'Order options (Transfer Only, Attack Only, percentage, the commander, attack teammates) follow the war.app ' +
  "client's own encoding but are not yet verified by a live commit: check the orders in the game after sending.";

const label = (t: Place) => `${untrustedText(t.name)} (${t.id})`;
const move = (m: OptionMove) => `${label(m.from)} → ${label(m.to)}`;

/**
 * Check each move's options against the game's settings and the live board at the start of the
 * turn; throws a clear refusal on the first that cannot be sent, else returns warnings, the
 * commander each commander move takes, and what each percentage order would send now.
 */
export function checkMoveOptions(args: {
  moves: readonly OptionMove[];
  board: readonly LiveTerritory[];
  myInGameId: number;
  settings: GameSettings | undefined;
  /** My teammates' in-game ids (empty outside a team game). */
  teammates: ReadonlySet<number>;
  /** This turn's deploys per territory. */
  deployedOn: ReadonlyMap<number, number>;
}): MoveOptionsCheck {
  const { moves, board, myInGameId: me, teammates } = args;
  const s = args.settings;
  const standing = new Map(board.map((t) => [t.territoryId, t]));
  const ownerOf = (id: number) => {
    const t = standing.get(id);
    return t && !t.fogged ? t.owner : undefined;
  };
  const warnings: string[] = [];
  const commanders = new Map<number, OrderCommander>();
  const estimates = new Map<number, number>();
  let used = false;
  /** Where my commander stands at the start of the turn. */
  const home = board.find((t) => !t.fogged && t.specialUnits?.some((u) => u.kind === 'commander' && u.owner === me));
  const myCommander = home?.specialUnits?.find((u) => u.kind === 'commander' && u.owner === me);
  /** Where my commander is after the commander moves so far. */
  let commanderAt: number | undefined = home?.territoryId;
  let commanderMoves = 0;

  moves.forEach((m, i) => {
    if (m.mode === 'transfer-only' || m.mode === 'attack-only') used = true;
    if (m.mode === 'transfer-only' && s?.allowTransferOnly !== true) {
      throw new McpToolError(`Transfer Only orders are off in this game (AllowTransferOnly; war.app refuses one, error 361): ${move(m)}.`, {
        hint: 'Send it without `mode`: an ordinary attack/transfer.',
      });
    }
    if (m.mode === 'attack-only' && s?.allowAttackOnly !== true) {
      throw new McpToolError(`Attack Only orders are off in this game (AllowAttackOnly; war.app refuses one, error 362): ${move(m)}.`, {
        hint: 'Send it without `mode`: an ordinary attack/transfer.',
      });
    }
    const target = ownerOf(m.to.id);
    const friendly = target === me || (target !== undefined && teammates.has(target) && !m.attackTeammates);
    if (m.mode === 'transfer-only' && !friendly) {
      warnings.push(
        `Transfer Only ${move(m)}: ${label(m.to)} is not yours at the start of the turn, so the order does nothing unless it is yours (or a teammate's) when it runs.`,
      );
    }
    if (m.mode === 'attack-only' && target === me) {
      warnings.push(`Attack Only ${move(m)}: ${label(m.to)} is yours, so the order fires only if it has fallen by the time it runs; otherwise nothing moves.`);
    }

    if (m.percent) {
      used = true;
      if (s?.allowPercentageAttacks !== true) {
        throw new McpToolError(`Percentage orders are off in this game (AllowPercentageAttacks; war.app refuses one, error 360): ${move(m)}.`, {
          hint: 'Send a number of armies instead (leave `percent` out).',
        });
      }
      if (m.armies < 1 || m.armies > 100) {
        throw new McpToolError(`${move(m)} asks for ${m.armies}%: a percentage order sends 1 to 100 percent.`, {
          hint: 'With `percent`, `armies` is the percentage of the armies the territory can move when the order runs.',
        });
      }
      const guard = s?.oneArmyStandsGuard === false ? 0 : 1;
      const now = Math.max(0, (standing.get(m.from.id)?.armies ?? 0) + (args.deployedOn.get(m.from.id) ?? 0) - guard);
      const est = percentOf(m.armies, now);
      estimates.set(i, est);
      warnings.push(
        `${move(m)} sends ${m.armies}% of the armies ${label(m.from)} can move when it runs: about ${est} now (worked out when the order runs, so it scales with what is left).`,
      );
    } else if (m.armies === 0 && !m.commander) {
      throw new McpToolError(`${move(m)} sends no armies.`, {
        hint: 'Send at least one army; 0 is only for a commander moving alone (`commander: true`).',
      });
    }

    if (m.attackTeammates) {
      used = true;
      if (!teammates.size) {
        throw new McpToolError(`${move(m)} sets attack_teammates, but you have no teammates in this game.`, {
          hint: 'Leave attack_teammates out: outside a team game every territory not yours is attacked anyway.',
        });
      }
      if (target === undefined || !teammates.has(target)) {
        warnings.push(`${move(m)} attacks teammates, but ${label(m.to)} is not a teammate's at the start of the turn: the flag matters only if it is one when the order runs.`);
      }
    }

    if (m.commander) {
      used = true;
      if (s?.commanders !== true) {
        throw new McpToolError(`This game has no commanders, so ${move(m)} cannot take one along.`, { hint: 'Leave `commander` out.' });
      }
      if (!home || !myCommander) {
        throw new McpToolError(`No commander of yours is on the live board, so ${move(m)} cannot take one along.`, {
          hint: 'Leave `commander` out; warapp_get_live_board shows your commander when you have one.',
        });
      }
      if (commanderMoves > 0 && !(s?.multiAttack && m.from.id === commanderAt)) {
        throw new McpToolError(`Your commander moves once a turn, and ${move(m)} would move it again.`, {
          hint: 'Take the commander along on one move only (under Multi-Attack it may go on from the territory it just took).',
        });
      }
      if (m.from.id !== commanderAt) {
        throw new McpToolError(`Your commander is not on ${label(m.from)}: it stands on territory ${commanderAt} at the start of the turn.`, {
          hint: 'Take it along on a move from the territory it stands on.',
        });
      }
      commanders.set(i, { id: myCommander.id, owner: me });
      commanderMoves += 1;
      const ontoTeammate = target !== undefined && target !== me && teammates.has(target) && !m.attackTeammates;
      // It reaches m.to only when the order surely carries it there: not onto a teammate's land
      // (it stays home), not an Attack Only onto my own territory or a Transfer Only onto one not
      // mine (either may not fire). Otherwise it is held where it stood, so a Multi-Attack chain
      // from m.to is refused rather than assumed.
      const mayNotFire = (m.mode === 'attack-only' && target === me) || (m.mode === 'transfer-only' && target !== undefined && !friendly);
      if (!ontoTeammate && !mayNotFire) commanderAt = m.to.id;
      if (ontoTeammate) {
        warnings.push(`${move(m)} goes to a teammate's territory: a commander does not move onto a teammate's land, so your commander stays on ${label(m.from)}.`);
      } else if (!friendly) {
        warnings.push(
          `Your commander goes with ${move(m)}: it fights as 7 armies after the ones with it, and if it dies (7 damage left over in the battle) you are eliminated.`,
        );
      }
    }
  });
  if (used) warnings.push(OPTIONS_UNVERIFIED);
  return { warnings, commanders, estimates };
}
