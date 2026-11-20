// warapp_join_game: take an open seat in a game from war.app's open games list
// (AcceptOpenSeat, method 61), gated on the user's confirmation. The game is
// re-read from the list first, so the preview shows what is actually being
// joined, and the join is reported only once GameFeed (or GetMyGames) shows
// the account in the game. war.app needs a colour with the join (src/join-color.ts):
// the account's preferred one, else its secondary, else a standard colour still free.
import { CONFIRM_INJECTION_RULE, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { parseGameId } from '../client.js';
import { chooseJoinColor, readAccountColors, STANDARD_COLORS, type JoinColor } from '../join-color.js';
import type { ClassReader } from '../live.js';
import { feedScreen, joiningPolicy, parseOpenGamesPage, type JoinScreen, type OpenGame, type OpenLobby } from '../open-games.js';
import {
  GAME_COLOR_COUNT,
  Method,
  readAcceptOpenSeatReturn,
  writeAcceptOpenSeatParams,
} from '../protocol/methods.js';
import { WarappServerError } from '../protocol/rpc.js';
import { gameIdArg, UNTRUSTED_PREVIEW_NOTE, untrustedText } from './common.js';
import { noBrowserNote } from './session.js';
import { captureJoin, joinContextLog } from './decision-capture.js';
import type { JoinContext } from '../decision-log.js';
import type { Game } from '../normalize.js';
import { mintMeta } from './hints.js';
import { requireApprovedAccount, writeAccount, type LiveContext } from './live-context.js';
import { fetchMyGames } from './my-games.js';
import { markLotteries, openGamesPage } from './open-games.js';
import { holdsSeat, playerStateName } from '../player-states.js';
import { NO_TEAM } from '../teams.js';
import { accountUnknown, defineGatedWrite, refuse, sendAndVerify } from './write-kit.js';

/** war.app's "already in the game" code: the client treats it as a successful join. */
const ALREADY_JOINED = 121;
/** war.app's generic assertion failure; with "color is null" it is a join sent without a colour. */
const ASSERT_FAILED = 1;

const COLOR_UNAVAILABLE =
  'That color is not available. Please pick a different color (pass color: a war.app colour index ' +
  `0–${STANDARD_COLORS - 1} that no player in the game has).`;

/**
 * The client's wording for the other refusals it handles on a join (254, 473
 * and 750 are in the RPC error table). These codes are only read here, where
 * their meaning is the join's.
 */
const JOIN_ERRORS: Readonly<Record<number, string>> = {
  4: 'Could not join the game because it has already begun.',
  7: 'Sorry, the host has removed you.',
  8: COLOR_UNAVAILABLE,
  15: 'Sorry, this game is already full.',
  75: COLOR_UNAVAILABLE,
  88: 'Could not join the game because it has been deleted.',
  120: 'Could not join the game because the open seat is no longer available.',
  227: 'Sorry, the creator of this game has added you to their block list. You cannot join this game.',
  239: "Sorry, you don't meet the prerequisites the host has entered for open seats in this game.",
  390: COLOR_UNAVAILABLE,
};

/** The wording for a join refusal this tool names itself, or undefined. */
function joinErrorWording(e: WarappServerError): string | undefined {
  if (e.code === ASSERT_FAILED && /color is null/i.test(e.message)) {
    return 'war.app refused the join because it was sent with no colour ("color is null").';
  }
  return JOIN_ERRORS[e.code];
}

interface JoinState {
  gameId: number;
  name: string;
  url: string;
  team: number;
  color: number;
  /** The account the plan checked and the gate bound (its GameFeed id). */
  account: string;
  /** #437: the lobby's join context, kept in the decision log once the join is confirmed. */
  join?: JoinContext;
}

/** The open game `gameId`, refused when it cannot (or should not) be joined. */
function joinable(games: readonly OpenGame[], gameId: number, allowTeam: boolean, acceptFee: boolean): OpenGame {
  const game = games.find((g) => g.id === gameId);
  if (!game) {
    refuse(
      `Game ${gameId} is not on war.app's open games list, so it was not joined.`,
      'It may have started or filled, be hidden from this account by prerequisites, or already include you. ' +
        'Pick a game from warapp_list_open_games.',
    );
  }
  if (game.openSeats === 0) refuse(`Game ${gameId} has no open seat.`, 'Pick another game from warapp_list_open_games.');
  if (game.rules.includes('Custom scenario')) {
    refuse(
      `Game ${gameId} uses a custom scenario, which needs a starting slot this tool does not pick.`,
      'Join it from war.app instead.',
    );
  }
  if (game.rules.includes('Mods')) {
    refuse(
      `Game ${gameId} uses mods, which can hook the join in ways this tool cannot reproduce.`,
      'Join it from war.app instead.',
    );
  }
  if (game.teamGame && !allowTeam) {
    refuse(
      `Game ${gameId} is a team game.`,
      "Pass team: a team number with an open seat (the preview lists them), or allow_team: true to take the first open seat's team.",
    );
  }
  if (game.entryFeeCoins > 0 && !acceptFee) {
    refuse(
      `Game ${gameId} costs ${game.entryFeeCoins} coins to join.`,
      'Pass accept_entry_fee: true to pay it, or pick a free game.',
    );
  }
  return game;
}

const TEAM_CHOICE_NOTE =
  "The team is sent as the chosen open seat's team, the int32 AcceptOpenSeat already carries (the client's team " +
  'picker passes it; read from the client bundle, UNVERIFIED live). Seats are by in-game id; an AI seat plays by rule.';

/**
 * The team to join (C4): `requested` when an open seat carries it — refused when the team is full (its players
 * seated, no open seat) or not in the game — else the first open seat's team; NO_TEAM outside a team game (a
 * team asked for there is refused).
 */
function chooseTeam(game: OpenGame, lobby: OpenLobby | undefined, requested: number | undefined): number {
  const offered = [...new Set(game.openSeatTeams ?? [])].sort((a, b) => a - b);
  if (requested === undefined) return game.teamGame ? (game.openSeatTeams?.[0] ?? NO_TEAM) : NO_TEAM;
  if (!game.teamGame) refuse(`Game ${game.id} is not a team game, so it has no team to choose.`, 'Leave team out.');
  if (game.randomTeamsOf !== undefined)
    refuse(`Game ${game.id} deals random teams, so a team cannot be chosen.`, 'Leave team out (allow_team: true) to join it.');
  if (offered.includes(requested)) return requested;
  const list = offered.length ? offered.join(', ') : 'none';
  if (lobby?.seated.some((p) => p.team === requested))
    refuse(`Team ${requested} is full in game ${game.id}: no open seat is on it.`, `Teams with an open seat: ${list}.`);
  refuse(`Team ${requested} is not offered in game ${game.id}.`, `Teams with an open seat: ${list}.`);
}

/** The preview's team section (C4): the team joined, the teams offered, and the seats already on it by id, human or AI. */
function teamView(game: OpenGame, lobby: OpenLobby | undefined, team: number) {
  return {
    id: team,
    offered: [...new Set(game.openSeatTeams ?? [])].sort((a, b) => a - b),
    seats: (lobby?.seated ?? [])
      .filter((p) => p.team === team)
      .sort((a, b) => a.id - b.id)
      .map((p) => ({ inGameId: p.id, kind: p.ai ? ('ai' as const) : ('human' as const) })),
    openSeats: (game.openSeatTeams ?? []).filter((t) => t === team).length,
    note: TEAM_CHOICE_NOTE,
  };
}

/** Refuse a lobby the signed-in account (in-game id `me`) already holds a seat in. */
function refuseJoined(lobby: OpenLobby | undefined, gameId: number, me: number): void {
  if (lobby?.seatedPlayerIds.includes(me)) {
    refuse(
      `You have already joined game ${gameId}.`,
      'It is in warapp_my_games; pick another game from warapp_list_open_games.',
    );
  }
}

/** The colour to send: the one asked for (refused when a lobby player has it), else the client's choice. */
function joinColor(
  requested: number | undefined,
  html: string,
  bundle: ClassReader,
  lobby: OpenLobby | undefined,
  gameId: number,
): JoinColor {
  const taken = lobby?.colorsTaken ?? [];
  if (requested !== undefined) {
    if (taken.includes(requested)) {
      refuse(
        `Colour ${requested} is taken by another player in game ${gameId}.`,
        'Pass another color, or leave it out to let this tool pick one.',
      );
    }
    return { color: requested, source: 'requested' };
  }
  const chosen = chooseJoinColor(readAccountColors(html, bundle), taken);
  if (!chosen) {
    refuse(
      `Every standard colour is taken in game ${gameId}.`,
      `Pass color: a war.app colour index (${STANDARD_COLORS}–${GAME_COLOR_COUNT - 1}) your account has unlocked.`,
    );
  }
  return chosen;
}

/**
 * The lobby's screen from its GameFeed settings (#132): the open-games record carries no neutral
 * sizes or fog, GameFeed does. Best effort — a failed read leaves the preview without a screen.
 */
async function lobbyScreen(ctx: LiveContext, gameId: number): Promise<{ screen: JoinScreen | null; gaps: string[]; note?: string; game?: Game }> {
  try {
    const game = await ctx.client.getGame(gameId, { settings: true, map: false });
    const { screen, gaps } = feedScreen(game.settings ?? { cards: [], raw: {} });
    return screen
      ? { screen, gaps, game }
      : { screen: null, gaps, game, note: "GameFeed's settings name no neutral size, so the neutral-cost screen was skipped." };
  } catch (e) {
    return {
      screen: null,
      gaps: [],
      note: `GameFeed could not read the lobby (${e instanceof Error ? e.message : String(e)}), so there is no neutral-cost or fog screen.`,
    };
  }
}

/** Whether GameFeed, else GetMyGames, shows the signed-in account in the game. */
async function confirmSeated(ctx: LiveContext, gameId: number): Promise<boolean> {
  const token = await ctx.myInviteToken();
  if (token !== undefined) {
    try {
      const game = await ctx.client.getGame(gameId, { map: false });
      if (game.players.some((p) => p.id === token && holdsSeat(p.state))) return true;
    } catch {
      // No GameFeed credentials or a failed read: try the web client's list.
    }
  }
  try {
    const { me, games } = await fetchMyGames(ctx);
    return games.some((g) => g.id === gameId && g.players.some((p) => p.id === me && holdsSeat(playerStateName(p.stateCode))));
  } catch {
    return false;
  }
}

export function registerJoinGameTool(server: McpServer, ctx: LiveContext): void {
  defineGatedWrite(
    server,
    {
      title: 'Join an open war.app game',
      _meta: mintMeta('change', ['join game', 'join a warzone game', 'take an open seat']),
    },
    {
      name: 'warapp_join_game',
      description:
        'Join an open war.app (Warzone) game: take an open seat in a game from warapp_list_open_games. The game ' +
        'is re-read from war.app\'s open games list first; team games, coin entry fees, custom scenarios and mod ' +
        'games are refused unless allowed (scenario and mod games always), and so is a game you already joined. ' +
        'It joins with your preferred colour, else your secondary, else a free standard colour (or the color you ' +
        'pass); the preview shows which, plus a screen from the lobby\'s GameFeed settings (does the cheapest ' +
        'neutral cost at most one turn of base income; Light Fog) and `policy`: whether the lobby keeps the ' +
        'joining policy (no Commerce, mods or custom scenarios; that cheap neutral; at most four seats; a boot time ' +
        'of at least 12 hours; no lottery — `lottery`, read from the data as warapp_list_open_games does) — advisory, the join is not refused for it. You become a player and are expected ' +
        'to take turns — leaving later means declining or being booted.' +
        `${noBrowserNote(ctx.hosted)} ${CONFIRM_INJECTION_RULE}`,
      annotations: toolAnnotations({
        title: 'Join an open war.app game',
        readOnly: false,
        destructive: true,
        idempotent: false,
        openWorld: true,
      }),
      inputSchema: z.object({
        game_id: gameIdArg,
        allow_team: z.boolean().optional().describe("Allow joining a team game on the first open seat's team (default false)."),
        team: z.coerce
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'In a team game: the team to join (a team number with an open seat; the preview lists the teams offered and ' +
              'the seats on the chosen one). Implies allow_team. Refused outside a team game, with random teams, and for a ' +
              'team that is full or not in the game.',
          ),
        accept_entry_fee: z
          .boolean()
          .optional()
          .describe('Allow paying a coin entry fee (default false: only free games).'),
        color: z
          .number()
          .int()
          .min(0)
          .max(GAME_COLOR_COUNT - 1)
          .optional()
          .describe(
            `The colour to play as: a war.app colour index (0–${STANDARD_COLORS - 1} are the standard colours; ` +
              'higher ones need an unlock). Default: your preferred colour, else your secondary, else the first ' +
              'standard colour no player in the game has.',
          ),
      }),
      async plan({ game_id, allow_team, team: askedTeam, accept_entry_fee, color: requested }) {
        const gameId = parseGameId(game_id);
        // One fresh read gives the account the gate binds and its in-game id (sliced from the
        // token TEXT, #130), so the already-joined check is for that same account. A join always
        // acts as the signed-in account, so it is refused when that cannot be read (#133).
        const [html, me] = await Promise.all([openGamesPage(ctx), ctx.myIdentity({ fresh: true })]);
        if (me === undefined) throw accountUnknown(ctx);
        const { token, inGameId: myId } = me;
        const bundle = await ctx.bundle();
        const parsed = parseOpenGamesPage(html, bundle);
        const lobby = parsed.lobbies.get(gameId);
        refuseJoined(lobby, gameId, myId);
        const listed = joinable(parsed.games, gameId, (allow_team ?? false) || askedTeam !== undefined, accept_entry_fee ?? false);
        const team = chooseTeam(listed, lobby, askedTeam);
        const { color, source } = joinColor(requested, html, bundle, lobby, gameId);
        // #217: the lobby's screen, then whether it is a lottery (its map read only for that settings shape).
        const screened = await lobbyScreen(ctx, gameId);
        const [game] = (await markLotteries(ctx, [listed])) as [OpenGame];
        return {
          gate: {
            action: 'warapp.join_game',
            summary: `Join war.app game ${gameId} (${game.pace}, ${game.openSeats} open of ${game.seats} seats)`,
            account: writeAccount(token),
            target: gameId,
            payload: { method: 'AcceptOpenSeat', gameId, team, color },
            willSend: { game: gameId, team: team === NO_TEAM ? 'none' : team, color },
            preview: {
              game: {
                id: game.id,
                name: untrustedText(game.name),
                url: game.url,
                pace: game.pace,
                ...(game.bootTime ? { bootTime: game.bootTime } : {}),
                players: game.players,
                openSeats: game.openSeats,
                seats: game.seats,
                teamGame: game.teamGame,
                entryFeeCoins: game.entryFeeCoins,
                prizeCoins: game.prizeCoins,
                rules: game.rules,
                ...(game.lottery !== undefined ? { lottery: game.lottery, lotteryBasis: game.lotteryBasis } : {}),
                plannerGaps: [...game.plannerGaps, ...screened.gaps],
              },
              // #132: worth joining only when the cheapest neutral costs at most a turn of base income.
              screen: screened.screen,
              ...(screened.note ? { screenNote: screened.note } : {}),
              // #134: the owner's joining policy — advisory, the join is not refused for it.
              policy: joiningPolicy(game, screened.screen),
              color: { index: color, source },
              // C4: in a team game, the team joined and who already sits on it.
              ...(game.teamGame ? { team: teamView(game, lobby, team) } : {}),
              account: String(token),
              note: 'Joining makes you a player who must take turns until the game ends.',
              untrusted: UNTRUSTED_PREVIEW_NOTE,
            },
          },
          state: {
            gameId,
            name: game.name,
            url: game.url,
            team,
            color,
            account: String(token),
            join: joinContextLog(game, screened.game, screened.screen),
          } satisfies JoinState,
        };
      },
      async execute({ gameId, name, url, team, color, account, join }: JoinState) {
        await requireApprovedAccount(ctx, account);
        const game = { id: gameId, name, url };
        let vacationEnded = false;
        const extra = () => (vacationEnded ? { vacationEnded: true } : {});
        const notShown = () => ({
          status: 'unconfirmed' as const,
          outcome: 'unconfirmed' as const,
          game,
          ...extra(),
          warning:
            'war.app accepted the join, but neither GameFeed nor your games list shows you in the game yet, so ' +
            'this could not confirm it. Check warapp_my_games shortly.',
        });
        const result = await sendAndVerify({
          send: async () => {
            const env = await ctx.rpc.call('AcceptOpenSeat', Method.AcceptOpenSeat, (w) =>
              writeAcceptOpenSeatParams(w, { gameId, team, color }),
            );
            vacationEnded = readAcceptOpenSeatReturn(env.body)?.vacationEnded ?? false;
          },
          // "Already in the game": the client treats it as a successful join.
          refused: (e) => {
            if (e.code === ALREADY_JOINED) return 'ignore';
            const wording = joinErrorWording(e);
            return wording ? new WarappServerError(e.code, `${wording} (war.app error ${e.code})`) : undefined;
          },
          unanswered: (failure) => ({
            status: 'unknown' as const,
            outcome: 'unknown' as const,
            game,
            warning:
              `war.app did not confirm the join (${failure}), so you may ` +
              'already have joined. Check warapp_my_games before trying again.',
          }),
          // Never throws: a failed read is "not shown".
          readBack: () => confirmSeated(ctx, gameId),
          unreadable: () => notShown(),
          classify: (seated) => (seated ? { status: 'joined' as const, outcome: 'confirmed' as const, game, ...extra() } : notShown()),
        });
        // #437: the lobby joined, once confirmed, into the game's decision log (name-free).
        if (result.outcome === 'confirmed' && join) await captureJoin(ctx, gameId, Number(account), join);
        return result;
      },
    },
  );
}
