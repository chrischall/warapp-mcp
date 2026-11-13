// Resolve a territory or player named by a caller: an id, an exact name
// (case-insensitive), or a unique part of a name. Errors listing candidates show
// each name through `untrustedText` (names are other players' and map makers'
// words, and errors are not inside the untrusted envelope) and cap the list.

import { McpToolError } from '@chrischall/mcp-utils';
import type { Bonus, GameMap, Player, Territory } from '../normalize.js';
import { UNTRUSTED_LIST_MAX, untrustedList, untrustedText } from './common.js';

function pick<T extends { id: number; name: string }>(items: readonly T[], input: string | number, what: string): T {
  const raw = String(input).trim();
  if (!raw) throw new McpToolError(`Name a ${what} (an id or a name).`);
  if (/^\d+$/.test(raw)) {
    const byId = items.find((i) => i.id === Number(raw));
    if (byId) return byId;
  }
  const q = raw.toLowerCase();
  const exact = items.filter((i) => i.name.toLowerCase() === q);
  const hits = exact.length ? exact : items.filter((i) => i.name.toLowerCase().includes(q));
  if (hits.length === 1) return hits[0]!;
  const label = (i: T) => `${untrustedText(i.name)} (${i.id})`;
  if (hits.length === 0) {
    throw new McpToolError(`No ${what} matches ${JSON.stringify(raw)}.`, {
      hint: `Use the ${what}'s id, or part of its name as spelled in the game.`,
    });
  }
  throw new McpToolError(
    `${JSON.stringify(raw)} matches ${hits.length} ${what === 'territory' ? 'territories' : `${what}${what.endsWith('s') ? 'es' : 's'}`}: ` +
      `${untrustedList(hits, UNTRUSTED_LIST_MAX, label)}.`,
    { hint: `Pass the id of the one you mean.` },
  );
}

export function resolveTerritory(map: GameMap, input: string | number): Territory {
  return pick(map.territories, input, 'territory');
}

export function resolveBonus(map: GameMap, input: string | number): Bonus {
  return pick(map.bonuses, input, 'bonus');
}

/** A player by id or name; with no input, an error listing who to choose from. */
export function resolvePlayer(players: readonly Player[], input: string | number | undefined): Player {
  if (input === undefined || String(input).trim() === '') {
    const list = untrustedList(players, UNTRUSTED_LIST_MAX, (p) => `${untrustedText(p.name)} (${p.id})`);
    throw new McpToolError(`Say which player to analyze the board for: ${list || 'the game lists no players'}.`, {
      hint: 'Pass `player` as a name or id — usually your own war.app name.',
    });
  }
  return pick(players, input, 'player');
}
