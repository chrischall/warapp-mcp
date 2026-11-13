// Where the opponents are and what they are doing, as a tool: the model of
// src/analysis/whereabouts.ts over the boards this server saw of the game (the live board plus the
// cached history, as warapp_track_opponents reads them), the opponent tracks, the starts the award
// of picks proves (src/tools/award.ts), the territories that were pickable (src/pick-list.ts) and,
// on a local install with WARAPP_STATS=1, the finished games already cached for the map
// (src/stats.ts — the cache alone, never a request). Read-only on war.app; it caches the board it
// read, like warapp_track_opponents. The turn planner does not use any of it yet.
import type { EnvSource } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { trackGame, trackOpponents } from '../analysis/index.js';
import {
  locateOpponents,
  MAX_APPROACHES,
  MAX_PREPARE,
  PREPARE_TURNS,
  type Approach,
  type OpponentWhereabouts,
  type Prepare,
  type StartCandidates,
  type StartPrior,
  type WhereSettings,
} from '../analysis/whereabouts.js';
import { boardStateFromLive } from '../live.js';
import { MIN_SAMPLE } from '../map-stats.js';
import type { Game, GameMap } from '../normalize.js';
import { readPickRecord, writePickable } from '../pick-list.js';
import { cachedRecords, STATS_ENV, statsGate } from '../stats.js';
import { CACHED_TURNS, writeBoardCache } from '../trend.js';
import { loadAward } from './award.js';
import { gameIdArg, graphOf, readAnnotations, respond, round2, untrustedDescription, viewArg } from './common.js';
import { lookupMeta } from './hints.js';
import { loadLiveGame, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE, playerArg, resolveMe } from './live.js';
import { mapOf } from './map.js';
import { boardHistory, currentTurn, plannerSettings, requireTurnPhase } from './turn.js';

const VIEWS = ['compact', 'full'] as const;
/** The most entries any one list names on the compact view; the rest are a count. */
const LIST_MAX = 10;
/** Approaches listed per opponent on the compact view (the full view lists the model's maximum). */
const COMPACT_APPROACHES = 3;
/** The least likelihood the full view lists under `presence`. */
export const PRESENCE_LISTED = 0.15;

const namer = (map: GameMap) => {
  const names = new Map(map.territories.map((t) => [t.id, t.name]));
  return (id: number) => ({ id, name: names.get(id) ?? String(id) });
};

/**
 * Keep the territories the live board shows as pickable, for the signed-in account when it is a
 * player of `game`: later turns have no other way to know where a player could have started.
 * Best effort: without a data directory or a readable account nothing is kept. Never throws.
 */
export async function keepPickable(ctx: Pick<LiveContext, 'dataDir' | 'myInviteToken'>, game: Game, pickable: readonly number[]): Promise<void> {
  if (!ctx.dataDir || !pickable.length) return;
  try {
    const account = await ctx.myInviteToken();
    if (account !== undefined && game.players.some((p) => p.id === account)) await writePickable(ctx.dataDir, game.id, account, pickable);
  } catch {
    // Best effort: the picks are planned either way.
  }
}

/**
 * Where a player could have started, and how the candidates weigh: the pickable territories kept
 * during distribution, else (statistics on) every territory a player started on in the finished
 * games cached for the map; the prior counts those starts, plus one, when statistics are on and
 * some game is cached. Only files this server already wrote are read.
 */
async function startKnowledge(
  ctx: Pick<LiveContext, 'dataDir'>,
  env: EnvSource | undefined,
  game: Game,
  map: GameMap,
  me: number,
): Promise<{ candidates?: StartCandidates; prior?: StartPrior }> {
  if (!ctx.dataDir) return {};
  const onMap = new Set(map.territories.map((t) => t.id));
  const kept = (await readPickRecord(ctx.dataDir, game.id, me))?.pickable?.filter((t) => onMap.has(t)) ?? [];
  const records = statsGate(env).enabled ? await cachedRecords(ctx.dataDir, map.id) : [];
  /** Territory → the players who started on it, over the cached games. */
  const started = new Map<number, number>();
  for (const r of records)
    for (const p of r.players) for (const t of new Set(p.starts)) if (onMap.has(t)) started.set(t, (started.get(t) ?? 0) + 1);
  const candidates: StartCandidates | undefined = kept.length
    ? { territories: kept, source: 'pickable' }
    : started.size
      ? { territories: [...started.keys()].sort((a, b) => a - b), source: 'statistics' }
      : undefined;
  if (!candidates) return {};
  if (!records.length) return { candidates };
  return {
    candidates,
    prior: {
      // Plus one, so a candidate nobody started on in the sample is unlikely, not impossible.
      weights: new Map(candidates.territories.map((t) => [t, (started.get(t) ?? 0) + 1])),
      source: 'statistics',
      sample: records.length,
      weak: records.length < MIN_SAMPLE,
    },
  };
}

export function registerWhereTool(server: McpServer, ctx: LiveContext, deps: { env?: EnvSource } = {}): void {
  server.registerTool(
    'warapp_locate_opponents',
    {
      title: 'Locate my opponents in a war.app game',
      description: untrustedDescription(
        'Where each opponent of an in-progress war.app (Warzone) game probably is and what it may be doing, so you ' +
          'can pre-empt or prepare. Per opponent, by name: `seen` holds the only facts — its territories in view on ' +
          'the live board, and territories now hidden that your earlier boards last showed as its own. Everything ' +
          'else is a guess, kept apart: `starts` (the starts the award of your picks proves, then the likely ones ' +
          'among the territories a player could start on, less those a board showed as a neutral or as yours), ' +
          '`presence` (hidden territories it may hold, each with a `likelihood` and its `basis`: last-seen; start; ' +
          'corridor, the shortest ways between a likely start and a sighting; growth, what a player could plausibly ' +
          'have taken from that start by now; income, bonuses that would explain its tracked income), `bonuses` it ' +
          'probably holds in full, its tracked `income` and `hiddenArmies` (as warapp_track_opponents), `approaches` ' +
          '(the earliest turn it could attack each border territory of yours: from a stack in view, with the armies ' +
          'that could arrive, or from a territory it only probably holds, marked `guessed`) and `doing` (plain ' +
          `sentences, each from a named rule), with a one-line \`summary\`. Then \`prepare\`, most urgent first (at most ${MAX_PREPARE}): ` +
          `\`hold\` (a territory of a bonus you hold in full, or your commander's, that a stack in view can attack within ${PREPARE_TURNS} ` +
          'turns, with the armies it needs to hold), `contested` (a bonus you hold part of whose missing territory it ' +
          'holds, may hold or can take in that time) and `scout` (a territory whose capture would show a guess that ' +
          'could go either way). The likelihoods are estimates of a simple model, not measured probabilities: present ' +
          'them as guesses, and `seen` as what is known. The model assumes one capture per turn along a path, pooled ' +
          'armies when it grows a start, that a start is never abandoned, and ignores cards (the full view lists its ' +
          'assumptions). The start candidates are the territories the live board showed as pickable, kept by ' +
          'warapp_plan_picks and by warapp_submit_picks; with none kept and no statistics, no start is guessed ' +
          '(`starts.source` is "none") and the rest works from what was seen. The start prior is uniform, unless the ' +
          `server runs locally with ${STATS_ENV}=1: then each candidate weighs by how often players started on it in the ` +
          'finished games warapp_map_stats already cached for the map (the sample is reported, and called weak under ' +
          `${MIN_SAMPLE} games), and with no pickable territories kept those starts are the candidates. It reads only boards ` +
          `this server already saw (the last ${CACHED_TURNS} turns warapp_plan_turn, warapp_track_opponents and this tool cached, ` +
          'or the game history when war.app sends it) plus those files: no war.app request beyond the live board and ' +
          `the game feed warapp_track_opponents reads. Refuses outside a turn phase. ${BRIDGE_NOTE} Read-only on war.app; it ` +
          'caches the board it read. warapp_plan_turn does not use these guesses yet.',
      ),
      _meta: lookupMeta(['where is my opponent', 'locate opponents', 'where did they start', 'what is my opponent doing', 'what should i prepare for']),
      annotations: readAnnotations('Locate war.app opponents'),
      inputSchema: z.object({
        game_id: gameIdArg,
        player: playerArg,
        view: viewArg(
          VIEWS,
          `compact (default) gives each opponent's facts, its likely starts, the ${LIST_MAX} likeliest hidden territories, the bonuses it probably ` +
            `holds, its ${COMPACT_APPROACHES} soonest approaches and what it is doing, then what to prepare for; "full" adds every hidden ` +
            `territory at a likelihood of ${PRESENCE_LISTED} or more, every approach (up to ${MAX_APPROACHES}), the candidates the boards ruled out and the model's assumptions.`,
        ),
      }),
    },
    async ({ game_id, player, view }) => {
      const game = await ctx.client.getGame(game_id, { settings: true });
      requireTurnPhase(game);
      const map = mapOf(game);
      const me = await resolveMe(ctx, game.players, player);
      const { territories } = await loadLiveGame(ctx, game);
      const graph = graphOf(map);
      // The board war.app showed: the model takes the starts the award proves as `proven`, never
      // as territories standing on the board.
      const board = boardStateFromLive(territories, me, game.players);
      const settings = plannerSettings(game.settings);
      const turn = currentTurn(game);
      const history = await boardHistory(ctx, game, me, turn);
      const boards = turn !== null ? [...history.boards, { turn, board }] : [{ turn: 0, board }];
      const about = trackGame(game.players, game.settings, map);
      const tracks = trackOpponents(graph, boards, me.id, settings, about);
      const award = await loadAward(ctx.dataDir, game, me, board, turn);
      const proven = new Map<number, readonly number[]>();
      if (award?.opponent && award.reading.opponentStarts.length) proven.set(award.opponent.id, award.reading.opponentStarts);
      const { candidates, prior } = await startKnowledge(ctx, deps.env, game, map, me.id);
      const s = game.settings;
      const whereSettings: WhereSettings = {
        ...settings,
        // How many territories a player started on, when the distribution says (not under full
        // distribution or a scenario: `trackGame`).
        ...(about.start
          ? { startsPerPlayer: about.start.territories, startingArmies: about.start.armiesPerTerritory }
          : s?.initialPlayerArmiesPerTerritory !== undefined
            ? { startingArmies: s.initialPlayerArmiesPerTerritory }
            : {}),
        ...(s?.initialNonDistributionArmies !== undefined ? { neutralArmies: s.initialNonDistributionArmies } : {}),
        ...(s?.initialNeutralsInDistribution !== undefined ? { distributionNeutralArmies: s.initialNeutralsInDistribution } : {}),
      };
      const result = locateOpponents({
        graph,
        me: me.id,
        boards,
        players: about.players,
        settings: whereSettings,
        ...(candidates ? { candidates } : {}),
        ...(prior ? { prior } : {}),
        proven,
        tracks,
      });
      if (ctx.dataDir && turn !== null) await writeBoardCache(ctx.dataDir, game.id, me.id, turn, board);

      const name = namer(map);
      const playerNames = new Map(game.players.map((p) => [p.id, p.name]));
      const playerOf = (id: number) => ({ id, name: playerNames.get(id) ?? String(id) });
      const bonusOf = (id: number) => {
        const b = map.bonuses.find((x) => x.id === id);
        return { id, name: b?.name ?? String(id), value: b?.value ?? 0 };
      };
      /** One approach in a sentence, by id (the names are in the fields beside it). */
      const approachText = (o: number, a: Approach) =>
        `Player ${o} could attack territory ${a.target} on turn ${a.turn} from territory ${a.from} (${a.source})` +
        `${a.armies !== null ? ` with up to ${a.armies} armies` : ''}.`;
      const prepareView = (p: Prepare) => ({
        kind: p.kind,
        text: p.text,
        turn: p.turn,
        opponent: playerOf(p.opponent),
        territory: name(p.territory),
        ...(p.bonusId !== undefined ? { bonus: bonusOf(p.bonusId) } : {}),
        ...(p.need !== undefined ? { need: p.need, have: p.have, armies: p.armies } : {}),
        ...(p.from !== undefined ? { from: name(p.from) } : {}),
        ...(p.likelihood !== undefined ? { likelihood: round2(p.likelihood) } : {}),
        ...(p.reveals ? { reveals: p.reveals.map(name) } : {}),
      });

      return respond(view, VIEWS, (rung) => {
        const full = rung === 'full';
        /** The first entries of a list, and how many more there are (none on the full view). */
        const some = <T>(rows: readonly T[], max = LIST_MAX) => (full ? [...rows] : rows.slice(0, max));
        const more = (rows: readonly unknown[], key: string, max = LIST_MAX) => (!full && rows.length > max ? { [key]: rows.length - max } : {});
        const opponentView = (o: OpponentWhereabouts) => {
          const presence = full ? o.presence.filter((p) => p.likelihood >= PRESENCE_LISTED) : o.presence.slice(0, LIST_MAX);
          return {
            player: playerOf(o.playerId),
            summary: o.summary,
            // FACTS: what the boards showed.
            seen: {
              inView: some(o.seen.inView).map((t) => ({ territory: name(t.territoryId), armies: t.armies })),
              ...more(o.seen.inView, 'inViewMore'),
              lastSeen: some(o.seen.lastSeen).map((t) => ({ territory: name(t.territoryId), turn: t.turn, armies: t.armies })),
              ...more(o.seen.lastSeen, 'lastSeenMore'),
              bonuses: some(o.seen.bonuses).map(bonusOf),
              ...more(o.seen.bonuses, 'bonusesMore'),
            },
            // GUESSES from here on: each likelihood is the model's estimate.
            starts: {
              source: o.starts.source,
              prior: o.starts.prior,
              proven: o.starts.proven.map(name),
              likely: some(o.starts.likely).map((x) => ({ territory: name(x.territoryId), likelihood: round2(x.likelihood) })),
              ...more(o.starts.likely, 'likelyMore'),
              unknown: o.starts.unknown,
              method: o.starts.method,
              ...(o.starts.priorOnly ? { priorOnly: true } : {}),
              ...(full ? { ruledOut: o.starts.ruledOut.map(name) } : {}),
            },
            presence: presence.map((p) => ({ territory: name(p.territoryId), likelihood: round2(p.likelihood), basis: p.basis })),
            ...(o.presence.length > presence.length ? { presenceMore: o.presence.length - presence.length } : {}),
            bonuses: some(o.bonuses).map((b) => ({
              bonus: bonusOf(b.bonusId),
              likelihood: round2(b.likelihood),
              basis: b.basis,
              inView: b.inView,
              hidden: b.hidden,
            })),
            ...more(o.bonuses, 'bonusesMore'),
            income: o.income,
            hiddenArmies: o.hiddenArmies,
            approaches: some(o.approaches, COMPACT_APPROACHES).map((a) => ({
              text: approachText(o.playerId, a),
              turn: a.turn,
              inTurns: a.inTurns,
              target: name(a.target),
              from: name(a.from),
              source: a.source,
              path: a.path.map(name),
              armies: a.armies,
              valued: a.valued,
            })),
            ...more(o.approaches, 'approachesMore', COMPACT_APPROACHES),
            doing: o.doing.map((d) => ({
              rule: d.rule,
              text: d.text,
              ...(d.territoryIds.length ? { territories: d.territoryIds.map(name) } : {}),
              ...(d.bonusId !== undefined ? { bonus: bonusOf(d.bonusId) } : {}),
            })),
          };
        };
        return {
          game: { id: game.id, name: game.name ?? null, turn },
          player: { id: me.id, name: me.name },
          // The turns whose boards the model read (yours, as war.app showed them).
          turns: boards.map((b) => b.turn).sort((a, b) => a - b),
          opponents: result.opponents.map(opponentView),
          prepare: result.prepare.map(prepareView),
          ...(full ? { assumptions: result.assumptions } : {}),
        };
      });
    },
  );
}
