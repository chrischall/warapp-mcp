// warapp_team_brief (C4, docs/PLAN-TEAMS.md): the content of a team-chat message as data, by stage — never sent.
// While picking: my list and its overlap with each teammate's. On turn 1: the picks my list lost and what they
// show. Each turn: each opponent's estimated income and its basis, my planned deploys and attacks, what I ask of
// my teammates, what I could give them, the card I intend to play, and the conflicts between my plan and the
// orders they have entered. The agent words it and sends it with warapp_send_chat (channel: "team").
//
// Read-only: it plans as warapp_plan_turn would (livePlanSetup, award not read and not written) and writes
// nothing — no board cache, no award, no outlook. UNVERIFIED live: the teams (V1, via resolveTeams), the
// teammates' entered orders (V5) and picks (V5/V6), what a move onto a teammate does (V7) and how the team hand
// is keyed (V8). The pure parts are src/analysis/team-brief.ts.
import { McpToolError } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { readAward } from '../analysis/award.js';
import { planEnemyEstimates, planTurn } from '../analysis/planner.js';
import { briefAsks, briefConflicts, opponentIncomes, pickOverlap, picksLost } from '../analysis/team-brief.js';
import { advisedOrderPriority, type Card } from '../cards.js';
import { parseGameId } from '../client.js';
import { boardStateFromLive } from '../live.js';
import type { Player } from '../normalize.js';
import { readPickRecord } from '../pick-list.js';
import { withTeammateOrders } from '../team-orders.js';
import { carriesTeam, teammatesOf } from '../teams.js';
import { gameIdArg, graphOf, namer, readAnnotations, respond, untrustedDescription, untrustedText } from './common.js';
import { lookupMeta } from './hints.js';
import { loadLiveGame, loadPicks, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE } from './live.js';
import { mapOf } from './map.js';
import { readTeammatePicks } from './team.js';
import { resolveTeamsFor } from './team-source.js';
import { boardHistory, currentTurn, livePlanSetup, requirePlayingSeat } from './turn.js';
import { accountUnknown } from './write-kit.js';

const DISTRIBUTING = 'DistributingTerritories';
const PLAYING = 'Playing';

/** What every brief says about itself. */
export const BRIEF_NOTES = [
  'Data for a team-chat message, never sent: word it and send it with warapp_send_chat (channel: "team"). ' +
    'In a team everything true and concrete is shared; promise only what the plan does.',
  "Teams come from GameFeed, else your game list (unverified, V1). Your teammates' entered orders and picks are read " +
    'from the live board (UNVERIFIED live, V5; picks fall back to GetTerritoryPicks, V6): none read means unknown, so ' +
    'no conflict can be named — not "no conflict".',
  'What a plain move onto a teammate\'s territory does is unverified (V7): every ask to move armies onto one is advice ' +
    "to your teammate, never an order of yours, and warapp_plan_turn never puts one in `orders`.",
];

const CONFLICT_NOTE =
  "`same-target`: you both attack it — whichever lands second moves onto your teammate's territory (V7), so one of " +
  'you should switch, unless it is a joint capture (`joint`); `bonus`: their attack takes a member of a bonus your plan ' +
  'completes (`completes`) or captures into (a bonus pays one holder: agree who takes it); `attacks-me`: an order of theirs attacks your territory; `onto-mine`: a plain ' +
  'order of theirs moves onto your territory (what it does is V7).';

const PICKS_LOST_NOTE =
  'Each pick ranked above one you were granted went to another player first: `teammate` when the first board showed it ' +
  "as your teammate's, `opponent` otherwise (a fogged one could still be your teammate's: team vision is unverified). " +
  'An opponent start says where they are.';

export function registerTeamBriefTool(server: McpServer, ctx: LiveContext): void {
  server.registerTool(
    'warapp_team_brief',
    {
      title: 'Brief my teammates in a war.app team game',
      description: untrustedDescription(
        'The facts for a team-chat message in a war.app (Warzone) team game, by stage, as data — it sends nothing. ' +
          "While picking: your pick list and its overlap with each teammate's (the same picks with both positions, and " +
          'the bonuses you both pick into). On turn 1: the picks your list lost and to whom (teammate or opponent, from ' +
          'your kept pick list and the first board). Each turn: each opponent\'s estimated income and its basis, your ' +
          "planned deploys and attacks (warapp_plan_turn's plan, profile goal), what you ask of your teammates (keep a " +
          'joint attack, cover a border you concede), what you could give them (a border of theirs your idle armies would ' +
          'hold), the card you intend to play and the cards left to them, and the conflicts with the orders they have ' +
          'entered (a target you both attack, a bonus you complete or capture into, an order onto your territory). Word it and send it with ' +
          'warapp_send_chat (channel: "team"). Teammate orders and picks are read from the client\'s own structures and are ' +
          `UNVERIFIED live. Refuses outside a team game. ${BRIDGE_NOTE} Read-only: writes nothing.`,
      ),
      _meta: lookupMeta(['team brief', 'brief my teammate', 'what to tell my teammate', 'team chat message', 'coordinate with my team']),
      annotations: readAnnotations('Brief my war.app team'),
      inputSchema: z.object({ game_id: gameIdArg }),
    },
    async ({ game_id }) => {
      const gameId = parseGameId(game_id);
      const identity = await ctx.myIdentity().catch(() => undefined);
      if (!identity) throw accountUnknown(ctx.hosted, 'your team brief cannot be read');
      const feed = await ctx.client.getGame(gameId, { settings: true });
      if (feed.state !== PLAYING && feed.state !== DISTRIBUTING) {
        throw new McpToolError(`Game ${feed.id} is not being picked or played (game state: ${feed.state}), so there is nothing to brief.`, {
          hint: 'A brief is for a game in progress: picking territories or playing turns.',
        });
      }
      const seat = feed.players.find((p) => p.id === identity.token);
      if (!seat) {
        throw new McpToolError(`The signed-in war.app account is not a player in game ${feed.id}.`, {
          hint: 'Check the game id with warapp_my_games.',
        });
      }
      requirePlayingSeat(feed, seat);
      // The teams, after the seat refusals: GameFeed's, else the game list's (asked once per game, kept).
      const { game, me, source } = await resolveTeamsFor(ctx, feed, seat);
      if (source === 'none' || !carriesTeam(me.team)) {
        throw new McpToolError(`Game ${game.id} is not a team game, or your team there is unknown.`, {
          hint: "GameFeed's team field is unverified and your game list did not name a team either. warapp_get_team reads the team.",
        });
      }
      const mates = teammatesOf(game.players, me);
      const allies = new Set(mates.map((p) => p.id));
      const map = mapOf(game);
      const graph = graphOf(map);
      const name = namer(map);
      const bonusRef = (id: number) => {
        const b = map.bonuses.find((x) => x.id === id);
        return { id, name: b?.name ?? String(id), value: b?.value ?? null };
      };
      const playerRef = (id: number) => {
        const p = game.players.find((x) => x.id === id);
        return { id, name: p ? untrustedText(p.name) : null };
      };
      const who = (id: number) => (id === me.id ? ('me' as const) : playerRef(id));
      const head = {
        game: { id: game.id, state: game.state, turn: currentTurn(game) },
        team: { id: me.team, source },
        me: { id: me.id, name: untrustedText(me.name) },
        teammates: mates.map((p) => ({
          ...playerRef(p.id),
          kind: p.isAI || p.humanTurnedIntoAI ? ('ai' as const) : ('human' as const),
          committed: p.hasCommittedOrders,
        })),
      };

      if (game.state === DISTRIBUTING) {
        const { territories, info } = await loadLiveGame(ctx, game);
        const board = withTeammateOrders(boardStateFromLive(territories, me, game.players), info, me, game.players);
        const mine = await loadPicks(ctx, game.id, identity.inGameId).catch(() => null);
        const lists: { player: number; list: number[] | null; source: string | null }[] = [];
        for (const p of mates) {
          const entry = board.teammateOrders?.find((e) => e.playerId === p.id);
          const read = await readTeammatePicks(ctx, game.id, p, entry);
          lists.push({ player: p.id, list: read?.territories ?? null, source: read?.source ?? null });
        }
        const o = pickOverlap(graph, mine ?? [], lists);
        return respond(undefined, ['compact'], () => ({
          ...head,
          stage: 'picks' as const,
          picks: {
            mine: mine === null ? null : mine.map(name),
            teammates: lists.map((l) => ({ player: playerRef(l.player), list: l.list === null ? null : l.list.map(name), source: l.source })),
            overlap: o.overlap.map((x) => ({ territory: name(x.territory), mine: x.mine, teammate: playerRef(x.teammate), theirs: x.theirs })),
            sharedBonuses: o.sharedBonuses.map((b) => ({ bonus: bonusRef(b.bonus), mine: b.mine.map(name), teammate: playerRef(b.teammate), theirs: b.theirs.map(name) })),
            ...(mine === null ? { note: 'Your own list could not be read: warapp_get_my_picks.' } : !mine.length ? { note: 'You have no picks entered yet: warapp_plan_picks, then warapp_submit_picks.' } : {}),
          },
          notes: BRIEF_NOTES,
        }));
      }

      const turn = currentTurn(game);
      const [{ territories, info }, history] = await Promise.all([loadLiveGame(ctx, game), boardHistory(ctx, game, me, turn)]);
      // award: false — reading the award on turn 1 writes it, and a team plan does not use it (two players only).
      const setup = await livePlanSetup(ctx, { game, map, me, turn, territories, info, history, award: false });
      const plan = planTurn(setup.input);
      const { estimates } = planEnemyEstimates({
        graph,
        board: setup.board,
        me: me.id,
        income: setup.income - setup.cards.extraArmies,
        settings: setup.settings,
        ...(setup.trend ? { previousBoard: setup.trend.board } : {}),
        ...(setup.trend && setup.previousOrders ? { previousOrders: setup.previousOrders } : {}),
        ...(setup.tracks ? { tracks: setup.tracks } : {}),
        game: setup.gameContext,
        turn,
      });
      const foes = game.players.filter((p) => p.id !== me.id && !allies.has(p.id) && (p.state ?? PLAYING) === PLAYING).map((p) => p.id);
      const joint = plan.team?.jointCaptures ?? [];
      const conflicts = briefConflicts({
        g: graph,
        board: setup.seen,
        me: me.id,
        allies,
        moves: plan.moves,
        bonusesCompleted: plan.expected.bonusesCompleted,
        joint: new Set(joint.map((j) => j.target)),
      });
      const asks = briefAsks({
        g: graph,
        board: setup.seen,
        allies,
        conceded: plan.conceded,
        jointCaptures: joint.map((j) => ({
          target: j.target,
          teammates: [...new Set(j.teammate.map((x) => x.player))],
          ...(j.mustGoFirst !== undefined ? { mustGoFirst: j.mustGoFirst } : {}),
        })),
      });
      const advised = plan.cardAdvice === 'order-priority' ? advisedOrderPriority(setup.myCards, setup.cards) : undefined;
      const plays: Card[] = advised ? [...setup.cards.plays, advised] : setup.cards.plays;
      const cardRef = (c: Card) => ({ id: c.id, type: c.name, ...(c.armies !== undefined ? { armies: c.armies } : {}) });
      const read = (setup.seen.teammateOrders ?? []).filter((e) => allies.has(e.playerId) && e.orders).map((e) => e.playerId);
      const lost = turn === 1 ? await firstTurnPicks(ctx, game, me, setup.seen) : undefined;

      return respond(undefined, ['compact'], () => ({
        ...head,
        stage: 'turn' as const,
        // Turn 1 only: what the award of my picks showed.
        ...(lost !== undefined
          ? {
              picks:
                lost === null
                  ? { lost: null, note: 'No pick list of yours is kept for this game (warapp_submit_picks keeps it), or it does not explain your start.' }
                  : {
                      granted: lost.granted.map(name),
                      lost: lost.lost.map((x) => ({ territory: name(x.territory), rank: x.rank, by: x.by })),
                      ...(lost.unlisted.length ? { unlisted: lost.unlisted.map(name) } : {}),
                      note: PICKS_LOST_NOTE,
                    },
            }
          : {}),
        opponents: opponentIncomes(estimates, foes).map((o) => ({ ...o, player: playerRef(o.player) })),
        income: setup.income,
        goal: plan.goal,
        deploys: plan.deploys.map((d) => ({ territory: name(d.territoryId), armies: d.armies })),
        attacks: plan.moves
          .filter((m) => m.kind === 'attack')
          .map((m) => ({
            from: name(m.from),
            to: name(m.to),
            armies: m.armies,
            ...(m.winChance !== undefined ? { winChance: Math.round(m.winChance * 1000) / 1000 } : {}),
          })),
        conceded: plan.conceded.map(name),
        bonusesCompleted: plan.expected.bonusesCompleted.map(bonusRef),
        asks: asks.map((a) =>
          a.kind === 'joint-capture'
            ? {
                kind: a.kind,
                target: name(a.target),
                teammates: a.teammates.map(playerRef),
                ...(a.mustGoFirst !== undefined ? { mustGoFirst: a.mustGoFirst === null ? ('either' as const) : who(a.mustGoFirst) } : {}),
              }
            : { kind: a.kind, territory: name(a.territory), beside: a.beside.map((b) => ({ teammate: playerRef(b.teammate), territory: name(b.territory), armies: b.armies })) },
        ),
        offers: (plan.team?.support ?? []).map((s) => ({
          territory: name(s.territory),
          teammate: playerRef(s.teammate),
          threat: s.threat,
          from: playerRef(s.player),
          need: s.need,
          mine: s.from.map((f) => ({ territory: name(f.territory), armies: f.armies })),
        })),
        cards: {
          play: plays.map(cardRef),
          discard: setup.cards.discards.map(cardRef),
          leftToTeammates: setup.teamClaimed.map((c) => ({ ...cardRef(c.card), teammate: playerRef(c.player), kind: c.kind })),
        },
        conflicts: {
          // `null`: no teammate's orders were read, so conflicts are unknown.
          read: read.length ? read.map(playerRef) : null,
          list: conflicts.map((c) =>
            c.kind === 'same-target'
              ? { kind: c.kind, territory: name(c.territory), teammate: playerRef(c.teammate), mine: c.mine, theirs: c.theirs, joint: c.joint }
              : c.kind === 'bonus'
                ? { kind: c.kind, bonus: bonusRef(c.bonus), territory: name(c.territory), teammate: playerRef(c.teammate), completes: c.completes }
                : { kind: c.kind, from: name(c.from), to: name(c.to), teammate: playerRef(c.teammate), armies: c.armies },
          ),
          note: CONFLICT_NOTE,
        },
        notes: BRIEF_NOTES,
      }));
    },
  );
}

/**
 * Turn 1: the picks my kept list lost, read from the first board (`readAward`, pure — this tool writes no award;
 * warapp_plan_turn keeps it). `null` when no list is kept or it does not explain the start; `undefined` without a
 * data directory. Never throws.
 */
async function firstTurnPicks(
  ctx: LiveContext,
  game: { id: number; players: readonly Player[] },
  me: Player,
  board: ReturnType<typeof boardStateFromLive>,
): Promise<ReturnType<typeof picksLost> | null | undefined> {
  if (!ctx.dataDir) return undefined;
  const record = await readPickRecord(ctx.dataDir, game.id, me.id).catch(() => undefined);
  if (!record?.list) return null;
  let reading = record.award;
  if (reading === undefined) {
    const mates = new Set(teammatesOf(game.players, me).map((p) => p.id));
    const held = (pred: (owner: number) => boolean) =>
      board.territories.filter((t) => t.owner.kind === 'player' && pred(t.owner.playerId)).map((t) => t.territoryId);
    reading = readAward({ list: record.list, mine: held((o) => o === me.id), players: game.players.length, teammateHeld: held((o) => mates.has(o)) });
  }
  return reading ? picksLost(record.list, reading) : null;
}
