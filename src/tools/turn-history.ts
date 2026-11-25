// warapp_turn_history (#570): a game turn by turn as this player saw it, beside what this server planned, sent
// and expected — read from the game's decision log (src/decision-log.ts), so an agent can plan from the turns
// before or compare an outcome with its plan. Per turn: the board seen (summary, or whole with `board: true`),
// what changed hands since the turn before among the territories in view both times, every player's visible
// orders on that turn (kept since #570, `seen`), the plan, the orders sent and whether they differ, the outcome
// next turn, cards, events, and once the game is finished its truth and accuracy. Ids and counts only (players
// by GameFeed id, territories and bonuses by id: warapp_get_map names them). Read-only; it makes no request,
// except `read_last_turn`, which reads the live board once to keep the turn just resolved first.
import { McpToolError } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { BoardState, TerritoryState } from '../board.js';
import { parseGameId } from '../client.js';
import { boardAt, ordersDiffer, readDecisionLog, type DecisionEntry, type DecisionLog, type GameEvent } from '../decision-log.js';
import type { SeenOrder } from '../turn-orders.js';
import { currentTurn, gameIdArg, readAnnotations, respond, untrustedDescription } from './common.js';
import { captureSeenTurn } from './decision-capture.js';
import { lookupMeta } from './hints.js';
import { readLatestBoard, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE } from './live.js';
import { accountUnknown, refuse } from './write-kit.js';

/** Turns returned per call at most, and by default. */
export const MAX_HISTORY_TURNS = 20;
export const DEFAULT_HISTORY_TURNS = 5;

type Owner = number | 'neutral' | null;
const ownerOf = (t: TerritoryState): Owner => (t.owner.kind === 'player' ? t.owner.playerId : t.owner.kind === 'neutral' ? 'neutral' : null);

/** A board's summary for `me`: my territories and armies, and each other player's in view. */
export function boardSummary(board: BoardState, me: number) {
  const players = new Map<number, { territories: number; armies: number; hiddenArmies: number }>();
  let neutral = 0;
  let hidden = 0;
  for (const t of board.territories) {
    const o = ownerOf(t);
    if (o === null) hidden++;
    else if (o === 'neutral') neutral++;
    else {
      const p = players.get(o) ?? { territories: 0, armies: 0, hiddenArmies: 0 };
      p.territories++;
      if (t.armies === null) p.hiddenArmies++;
      else p.armies += t.armies;
      players.set(o, p);
    }
  }
  const mine = players.get(me) ?? { territories: 0, armies: 0, hiddenArmies: 0 };
  players.delete(me);
  return {
    mine: { territories: mine.territories, armies: mine.armies },
    others: [...players]
      .sort((a, b) => a[0] - b[0])
      .map(([player, p]) => ({ player, territories: p.territories, armies: p.armies, ...(p.hiddenArmies ? { armiesHiddenOn: p.hiddenArmies } : {}) })),
    neutral,
    hidden,
  };
}

/** Territories in view on both boards that changed owner, ascending: `[territory, from, to]`. Pure. */
export function ownerChanges(before: BoardState, after: BoardState): [number, Owner, Owner][] {
  const was = new Map(before.territories.map((t) => [t.territoryId, ownerOf(t)]));
  const out: [number, Owner, Owner][] = [];
  for (const t of after.territories) {
    const now = ownerOf(t);
    const prev = was.get(t.territoryId);
    if (prev === undefined || prev === null || now === null || prev === now) continue;
    out.push([t.territoryId, prev, now]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** A turn's visible orders grouped by player (`unknown` for none read). */
export function seenByPlayer(orders: readonly SeenOrder[]) {
  const out: Record<string, { deploys: [number, number][]; moves: { from: number; to: number; armies: number; mode?: string; percent?: true; commander?: true }[]; cards: string[]; discards: number; other: string[] }> = {};
  for (const o of orders) {
    const k = o.player === null ? 'unknown' : String(o.player);
    const p = (out[k] ??= { deploys: [], moves: [], cards: [], discards: 0, other: [] });
    if (o.kind === 'deploy') p.deploys.push([o.territoryId!, o.armies!]);
    else if (o.kind === 'move')
      p.moves.push({
        from: o.from!,
        to: o.to!,
        armies: o.armies!,
        ...(o.mode && o.mode !== 'attack-transfer' ? { mode: o.mode } : {}),
        ...(o.percent ? { percent: true as const } : {}),
        ...(o.commander ? { commander: true as const } : {}),
      });
    else if (o.kind === 'card') p.cards.push(o.card ?? 'card');
    else if (o.kind === 'discard') p.discards++;
    else p.other.push(o.cls ?? 'unknown');
  }
  return out;
}

const boardRows = (b: BoardState): [number, Owner, number | null][] =>
  [...b.territories].sort((x, y) => x.territoryId - y.territoryId).map((t) => [t.territoryId, ownerOf(t), t.armies]);

/** One turn as the tool shows it. Pure. */
export function historyTurn(
  log: Pick<DecisionLog, 'turns' | 'playerId' | 'events'>,
  turn: number,
  opts: { board?: boolean; full?: boolean } = {},
): Record<string, unknown> {
  const e: DecisionEntry = log.turns[String(turn)] ?? {};
  const me = log.playerId;
  const board = e.board ? boardAt(log, turn) : undefined;
  const prevBoard = log.turns[String(turn - 1)]?.board ? boardAt(log, turn - 1) : undefined;
  const d = e.decision;
  const events = (log.events ?? []).filter((x: GameEvent) => x.turn === turn);
  return {
    turn,
    ...(e.kind ? { kind: e.kind } : {}),
    ...(board ? { seen: boardSummary(board, me) } : e.board ? { seen: null, boardUnreadable: true } : {}),
    ...(board && opts.board ? { board: boardRows(board) } : {}),
    ...(board && prevBoard ? { changedHands: ownerChanges(prevBoard, board) } : {}),
    ...(e.seen ? { orders: seenByPlayer(e.seen.orders), ...(e.seen.omitted ? { ordersOmitted: e.seen.omitted } : {}) } : {}),
    ...(d
      ? {
          plan: {
            goal: d.goal,
            ...(d.income !== undefined ? { income: d.income } : {}),
            deploys: d.deploys,
            moves: d.moves,
            expected: d.expected,
            conceded: d.conceded,
            ...(d.estimates ? { estimates: d.estimates } : {}),
            outlook: d.outlook,
            ...(d.outlookLean ? { outlookLean: d.outlookLean } : {}),
            ...(opts.full ? { rationale: d.rationale, warnings: d.warnings } : { warnings: d.warnings.length }),
          },
        }
      : {}),
    ...(e.sent ? { sent: e.sent, ...(d ? { differsFromPlan: ordersDiffer(d, e.sent) } : {}) } : {}),
    ...(e.override ? { override: e.override } : {}),
    ...(e.next ? { outcome: e.next } : {}),
    ...(e.cards ? { cards: e.cards } : {}),
    ...(events.length ? { events } : {}),
    ...(e.truth ? { truth: e.truth } : {}),
    ...(e.accuracy ? { accuracy: e.accuracy } : {}),
    ...(opts.full && e.checks ? { checks: e.checks } : {}),
    ...(opts.full && e.times ? { times: e.times } : {}),
    ...(opts.full && e.firstMover !== undefined ? { firstMover: e.firstMover } : {}),
  };
}

const turnsOf = (log: Pick<DecisionLog, 'turns'>) =>
  Object.keys(log.turns)
    .filter((k) => /^\d+$/.test(k))
    .map(Number)
    .sort((a, b) => a - b);

export function registerTurnHistoryTool(server: McpServer, ctx: LiveContext): void {
  server.registerTool(
    'warapp_turn_history',
    {
      title: 'A war.app game turn by turn, as I saw it',
      description: untrustedDescription(
        'A war.app (Warzone) game turn by turn as you saw it, beside what this server planned, sent and expected: ' +
          'per turn, the board in view (`seen`: your territories and armies, each other player\'s in view, neutral and ' +
          'hidden counts; whole with `board: true`, rows of [territory, owner, armies], owner a GameFeed id, "neutral" or ' +
          'null when fogged), `changedHands` since the turn before (territories in view both times: [territory, from, ' +
          'to]), every player\'s visible `orders` that turn (deploys [territory, armies], moves, card plays by name, ' +
          'discards; kept from the next turn\'s board since #570, so earlier turns have none), the `plan` (goal, income, ' +
          'deploys, moves, expected income and captures, conceded borders, the per-opponent income estimates, the outlook), ' +
          'the orders `sent` and `differsFromPlan`, any `override`, the `outcome` next turn (income, gained, lost, captures ' +
          'made and missed, bonuses held), cards, game events, and once the game is finished each turn\'s `truth` and ' +
          '`accuracy`. Only turns this server saw are kept (planned, tracked or read). Turns `from_turn`..`to_turn` (default ' +
          `the newest ${DEFAULT_HISTORY_TURNS}, at most ${MAX_HISTORY_TURNS} per call; \`next\` pages on); view "full" adds ` +
          'the plan\'s rationale and warnings, the checks run, times and the first mover. Ids only: name territories and ' +
          'bonuses with warapp_get_map, players with warapp_get_game. Attack results are not decoded: the next turn\'s board ' +
          'and `outcome` show what an attack achieved. `read_last_turn: true` first reads the live board once to keep the ' +
          `turn just resolved (game being played, your seat). ${BRIDGE_NOTE} Read-only on war.app.`,
      ),
      _meta: lookupMeta(['turn history', 'what happened last turn', 'past turns', 'replay my game', 'compare to the plan']),
      annotations: readAnnotations('War.app game turn by turn'),
      inputSchema: z.object({
        game_id: gameIdArg,
        from_turn: z.number().int().min(1).optional().describe('First turn to show (default: the newest turns).'),
        to_turn: z.number().int().min(1).optional().describe('Last turn to show (default: the newest kept).'),
        board: z.boolean().optional().describe('Include each turn\'s whole board as seen (default false: a summary).'),
        read_last_turn: z.boolean().optional().describe('First read the live board once to keep the turn just resolved (default false).'),
        view: z.enum(['compact', 'full']).optional().describe('"compact" (default) or "full" (adds rationale, warnings, checks, times, first mover).'),
      }),
    },
    async ({ game_id, from_turn, to_turn, board, read_last_turn, view }) => {
      const gameId = parseGameId(game_id);
      if (!ctx.dataDir) refuse('This server has no data directory, so no turn history is kept.', 'Nothing to read here.');
      const warnings: string[] = [];
      let me: number | undefined;
      if (read_last_turn) {
        const game = await ctx.client.getGame(gameId);
        const token = await ctx.myInviteToken().catch(() => undefined);
        if (token === undefined) throw accountUnknown(ctx, 'the last turn cannot be read');
        if (!game.players.some((p) => p.id === token))
          throw new McpToolError(`The signed-in war.app account is not a player in game ${game.id}.`, { hint: 'Check the game id with warapp_my_games.' });
        me = token;
        try {
          const { info } = await readLatestBoard(ctx, gameId);
          if (!(await captureSeenTurn(ctx, game, token, info, currentTurn(game))))
            warnings.push('The live board carried no resolved turn to keep (no turn resolved yet, or not this game\'s last one).');
        } catch (e) {
          warnings.push(`The live board could not be read (${e instanceof Error ? e.message : String(e)}): showing what is kept.`);
        }
      }
      const log = await readDecisionLog(ctx.dataDir!, gameId, me);
      if (!log)
        refuse(
          `No turn history is kept for game ${gameId}${me !== undefined ? ' for the signed-in account' : ''}.`,
          'History is kept from the turns this server sees: plan or track a turn (warapp_plan_turn, warapp_track_opponents) first.',
        );
      const kept = turnsOf(log!);
      if (!kept.length) refuse(`No turn of game ${gameId} is kept yet.`, 'Plan or track a turn first.');
      const hi = to_turn ?? kept.at(-1)!;
      const lo = from_turn ?? Math.max(1, hi - DEFAULT_HISTORY_TURNS + 1);
      const inRange = kept.filter((t) => t >= lo && t <= hi);
      const shown = inRange.slice(0, MAX_HISTORY_TURNS);
      const more = inRange.length > shown.length ? inRange[shown.length] : undefined;
      return respond(undefined, ['compact'], () => ({
        game: { id: gameId, status: log!.status },
        player: log!.playerId,
        keptTurns: { first: kept[0], last: kept.at(-1), count: kept.length },
        turns: shown.map((t) => historyTurn(log!, t, { board: board === true, full: view === 'full' })),
        ...(more !== undefined ? { next: { from_turn: more, to_turn: hi } } : {}),
        ...(log!.accuracySummary ? { accuracySummary: log!.accuracySummary } : {}),
        ...(warnings.length ? { warnings } : {}),
      }));
    },
  );
}
