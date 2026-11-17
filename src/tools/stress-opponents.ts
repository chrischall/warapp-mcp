// Who the stress test tries, and with what deploy: the same per-opponent estimates
// warapp_plan_turn works from. Shared by warapp_check_plan and warapp_submit_turn's commander
// check (#274), so both size a reply alike.
import { incomeDetail, planEnemyEstimates, symmetricStart, trackGame, trackOpponents, unevenStart, type PlannerSettings } from '../analysis/index.js';
import type { MapGraph } from '../analysis/graph.js';
import { neutralizeSeats, seatEndRules, staticSeats } from '../analysis/static-seats.js';
import type { TurnBoard } from '../analysis/opponents.js';
import type { BoardState } from '../board.js';
import type { Card } from '../cards.js';
import type { Game, GameMap, Player } from '../normalize.js';
import { carriesTeam } from '../teams.js';
import { opponentReinforcement } from './card-advice.js';
import { boardCardsInEffect } from './card-effects.js';
import { commerceDeployOf } from './commerce-deploy.js';

export interface StressOpponentsInput {
  graph: MapGraph;
  map: GameMap;
  game: Game;
  me: Player;
  /**
   * The board the orders are tried on (the award's proven starts in it), and the one war.app showed.
   * A static seat's territories (#270) are read as neutrals here whether or not the caller did.
   */
  board: BoardState;
  seen: BoardState;
  /** Earlier boards (boardHistory), oldest first, and turn − 1's. */
  boards: readonly TurnBoard[];
  previous?: BoardState;
  turn: number | null;
  settings: PlannerSettings;
  hand: readonly Card[];
  info: unknown;
  /** #166: the opponent's opening simulated from the starts the award proved. */
  opening?: ReadonlyMap<number, number>;
  /** Overrides every estimate. */
  enemyDeploy?: number;
}

export function stressOpponents(input: StressOpponentsInput) {
  const { graph, map, game, me, seen, turn, settings, hand, info } = input;
  // #270: a player out of the game whose seat no AI plays deploys and attacks nothing: its
  // territories are neutrals (static armies), and it is tried as no opponent.
  const seats = staticSeats(game.players, game.endRules, me.id);
  const board = neutralizeSeats(input.board, seats);
  const previous = input.previous ? neutralizeSeats(input.previous, seats) : undefined;
  const tracks =
    turn !== null
      ? trackOpponents(graph, [...input.boards, { turn, board: seen }], me.id, settings, trackGame(game.players, game.settings, map, game.endRules))
      : undefined;
  // #253: what the army cap leaves me and what I earn before the cut.
  const incomeOnBoard = incomeDetail(graph, board, me.id, game.settings);
  // #332: in a commerce game, the armies my gold buys (as warapp_plan_turn and warapp_submit_turn have it).
  const commerce = commerceDeployOf(game, me, info, incomeOnBoard.income);
  const income = commerce ? commerce.armies : incomeOnBoard.income;
  const earnedIncome = incomeOnBoard.cap ? incomeOnBoard.cap.uncapped : income;
  // PLAN-TEAMS D3: the cards in effect the decoder is sure of.
  const effect = boardCardsInEffect(game, me, turn, info);
  const previousOrders = previous && turn !== null ? input.boards.find((b) => b.turn === turn - 1)?.orders : undefined;
  const { estimates } = planEnemyEstimates({
    graph,
    board,
    me: me.id,
    income,
    ...(incomeOnBoard.cap ? { incomeCap: incomeOnBoard.cap } : {}),
    settings,
    ...(previous ? { previousBoard: previous } : {}),
    // #226: my orders on that turn, when this server sent them.
    ...(previousOrders ? { previousOrders } : {}),
    ...(tracks ? { tracks } : {}),
    // The fog prior in a 1v1 that started even (#119) and the turn (#128), as warapp_plan_turn has them.
    game: {
      players: game.players.map((p) => ({
        id: p.id,
        ...(p.team !== undefined ? { team: p.team } : {}),
        ...(p.state !== undefined ? { state: p.state } : {}),
        ...(p.humanTurnedIntoAI ? { humanTurnedIntoAI: true } : {}),
      })),
      ...(game.endRules && Object.keys(seatEndRules(game.endRules)).length ? { endRules: seatEndRules(game.endRules) } : {}),
      turn,
      symmetricStart: symmetricStart(game.settings),
      ...(unevenStart(game.settings) ? { unevenStart: unevenStart(game.settings)! } : {}),
      ...(input.opening ? { opening: input.opening } : {}),
      ...(game.settings?.fog !== undefined ? { fog: game.settings.fog } : {}),
      ...(opponentReinforcement(game.settings, hand) ? { reinforcement: opponentReinforcement(game.settings, hand)! } : {}),
    },
    turn,
    ...(effect.sanctionsOnOthers.length ? { sanctions: effect.sanctionsOnOthers } : {}),
  });
  const myTeam = carriesTeam(me.team) ? me.team : undefined;
  const teamOf = new Map(game.players.map((p) => [p.id, p.team]));
  const friend = (id: number) => id === me.id || (myTeam !== undefined && teamOf.get(id) === myTeam);
  // Whoever holds a stack on the board can use it, whatever GameFeed says of the player (a booted
  // seat may be an AI): every owner in view, then every other player still in the game. A static
  // seat's territories are neutral on `board` (#270), so it is never among them.
  const onBoard = new Set(board.territories.flatMap((t) => (t.owner.kind === 'player' ? [t.owner.playerId] : [])));
  const stillIn = game.players.filter((p) => (p.state ?? 'Playing') === 'Playing').map((p) => p.id);
  const base = settings.baseIncome ?? 0;
  const estimateOf = (id: number) => estimates.find((x) => x.playerId === id)?.estimate ?? base;
  const opponents = [...new Set([...onBoard, ...stillIn])]
    .filter((id) => !friend(id))
    .sort((a, b) => a - b)
    .map((id) => {
      const e = estimates.find((x) => x.playerId === id);
      return { id, deploy: input.enemyDeploy ?? e?.estimate ?? base, base: e?.base ?? base, ...(e?.card ? { card: e.card.armies } : {}) };
    });
  const teams = new Map<number, number>();
  for (const p of game.players) if (carriesTeam(p.team)) teams.set(p.id, p.team);
  const inView = new Set(board.territories.flatMap((t) => (t.owner.kind === 'player' && t.armies !== null ? [t.owner.playerId] : [])));
  // #180: in a free-for-all I lead when my income beats every estimate of an opponent in view
  // (two at least; enemy_deploy is a what-if, not the game's standing).
  const rivals = opponents.filter((o) => inView.has(o.id));
  const leader = teams.size === 0 && rivals.length >= 2 && rivals.every((o) => earnedIncome > estimateOf(o.id));
  return { board, seats, tracks, incomeOnBoard, income, earnedIncome, effect, estimates, estimateOf, friend, opponents, teams, inView, leader, commerce };
}
