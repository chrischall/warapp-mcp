// The agreement ledger's tools (docs/PLAN-TEAMS.md A2): `warapp_get_relations` (read-only on war.app;
// it caches the board it read, like warapp_track_opponents) and `warapp_record_agreement`, which
// writes only this machine's ledger (`<dataDir>/relations/<gameId>-<playerId>.json`) and the cross-game
// player record (src/player-record-store.ts) — nothing is sent to war.app or to any player, so it
// is not confirm-gated. An agreement exists only because the player recorded it here with
// structured terms: chat is never parsed into one, and words change no flag — only the board does.
import { McpToolError, toolAnnotations, type EnvSource } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { boardIncome, incomeRules, trackGame, trackOpponents, type MapGraph, type TurnBoard } from '../analysis/index.js';
import { isZero, playerRecord, recordDelta } from '../analysis/player-record.js';
import {
  AGREEMENT_STATUSES,
  agreementState,
  breachWatch,
  MAX_NOTICE_TURNS,
  newAgreement,
  OPENING_STATUSES,
  partyRefusal,
  scopeRefusal,
  tacitTruces,
  TERMINAL_STATUSES,
  transitionAgreement,
  TRUCE_OUTGROW_RATIO,
  trust,
  truceEndgame,
  type Agreement,
  type AgreementScope,
  type AgreementTerms,
  type WatchFlag,
} from '../analysis/relations.js';
import type { BoardState } from '../board.js';
import { boardStateFromLive } from '../live.js';
import type { Game, GameMap, Player } from '../normalize.js';
import { addPlayerCounts, playerRecordEnabled, readPlayerCounts } from '../player-record-store.js';
import { emptyLedger, nextAgreementId, readLedger, writeLedger, type RelationsLedger } from '../relations-store.js';
import { writeBoardCache } from '../trend.js';
import { currentTurn, gameIdArg, graphOf, namer, readAnnotations, respond, untrustedDescription, untrustedText, viewArg } from './common.js';
import { lookupMeta, mintMeta } from './hints.js';
import { loadLiveGame, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE, playerArg, resolveMe } from './live.js';
import { mapOf } from './map.js';
import { resolveBonus, resolvePlayer, resolveTerritory } from './resolve.js';
import { boardHistory, plannerSettings } from './turn.js';

const VIEWS = ['compact', 'full'] as const;
const MAX_SCOPE_ITEMS = 200;

/** What the results say about the board-derived parts. */
export const RELATIONS_NOTE =
  'Flags come from your own board history (the boards warapp_plan_turn, warapp_track_opponents and this tool ' +
  'cached, with the orders warapp_submit_turn sent): a fog reveal is never an event, and an event the fog leaves ' +
  'open is `massing`, never `broken`. Chat is never read into an agreement and never moves a flag. A truce ' +
  'that two players agree to but the game does not enforce (no Diplomacy card) is a promise, not a rule.';

/** How the ledger's write is described: local only. */
export const LEDGER_NOTE =
  "Written only to this machine's agreement ledger (the server's data directory); nothing was sent to war.app or to any player.";

const playerRef = z.union([z.string(), z.number()]);

/** The players as the ledger needs them. */
const relationPlayers = (players: readonly Player[]) =>
  players.map((p) => ({
    id: p.id,
    isAI: p.isAI,
    humanTurnedIntoAI: p.humanTurnedIntoAI,
    ...(p.state !== undefined ? { state: p.state } : {}),
    ...(p.team !== undefined ? { team: p.team } : {}),
  }));

const alive = (p: Player) => p.state === undefined || p.state === 'Playing';

/** Incomes on the newest board: mine (from the board) and each opponent's tracked estimate. */
interface Incomes {
  mine: number | null;
  /** By opponent id: its estimate (`income`, else what it visibly earns); `null` when never seen. */
  opponents: Map<number, number | null>;
}

function incomesOf(graph: MapGraph, boards: readonly TurnBoard[], game: Game, me: Player, map: GameMap): Incomes {
  const newest = [...boards].sort((a, b) => a.turn - b.turn).at(-1);
  const opponents = new Map<number, number | null>();
  for (const p of game.players) if (p.id !== me.id && alive(p)) opponents.set(p.id, null);
  if (!newest) return { mine: null, opponents };
  const held = new Set(
    newest.board.territories.filter((t) => t.owner.kind === 'player' && t.owner.playerId === me.id).map((t) => t.territoryId),
  );
  const mine = boardIncome(graph, held, incomeRules(game.settings)).total;
  const tracks = trackOpponents(graph, boards, me.id, plannerSettings(game.settings), trackGame(game.players, game.settings, map));
  for (const t of tracks) if (opponents.has(t.playerId)) opponents.set(t.playerId, t.firstSeen === null ? null : (t.income ?? t.visibleIncome));
  return { mine, opponents };
}

/** Whether the truce with `partner` is in its endgame; `null` when an income it needs is unknown. */
function endgameOf(incomes: Incomes, partner: number): boolean | null {
  const p = incomes.opponents.get(partner);
  if (incomes.mine === null || p === null || p === undefined) return null;
  const others = [...incomes.opponents].filter(([id]) => id !== partner);
  if (others.some(([, v]) => v === null)) return null;
  return truceEndgame({ mine: incomes.mine, partner: p, others: others.map(([, v]) => v!) });
}

/** A scope from the tool's arguments, by id. */
function scopeFrom(map: GameMap, territories: readonly (string | number)[] | undefined, bonuses: readonly (string | number)[] | undefined): AgreementScope {
  if (territories?.length && bonuses?.length) {
    throw new McpToolError('Give `territories` or `bonuses`, not both: nothing was recorded.', {
      hint: 'A truce covers all of your territories (omit both), some territories, or the territories of some bonuses.',
    });
  }
  if (territories?.length) return { territories: [...new Set(territories.map((t) => resolveTerritory(map, t).id))].sort((a, b) => a - b) };
  if (bonuses?.length) return { bonuses: [...new Set(bonuses.map((b) => resolveBonus(map, b).id))].sort((a, b) => a - b) };
  return 'all';
}

/** An agreement as a result shows it: players by id with a delimited name, territories and bonuses by id and name. */
function agreementView(a: Agreement, game: Game, map: GameMap, turn: number, rung: string) {
  const name = namer(map);
  const player = (id: number) => {
    const p = game.players.find((x) => x.id === id);
    return { id, name: p ? untrustedText(p.name) : null };
  };
  const scope = a.terms.scope;
  const state = agreementState(a, turn, relationPlayers(game.players));
  return {
    id: a.id,
    with: player(a.with),
    kind: a.kind,
    status: a.status,
    state: state.phase,
    ...(state.endsTurn !== undefined ? { endsTurn: state.endsTurn } : {}),
    ...(state.reason ? { overBecause: state.reason } : {}),
    createdTurn: a.createdTurn,
    ...(a.agreedTurn !== undefined ? { agreedTurn: a.agreedTurn } : {}),
    ...(a.noticeTurn !== undefined ? { noticeTurn: a.noticeTurn } : {}),
    ...(a.endedTurn !== undefined ? { endedTurn: a.endedTurn } : {}),
    terms: {
      scope:
        scope === 'all'
          ? 'all'
          : 'territories' in scope
            ? { territories: scope.territories.map(name) }
            : {
                bonuses: scope.bonuses.map((id) => {
                  const b = map.bonuses.find((x) => x.id === id);
                  return { id, name: b?.name ?? String(id), value: b?.value ?? null };
                }),
              },
      noticeTurns: a.terms.noticeTurns,
      ...(a.terms.borderCap !== undefined ? { borderCap: a.terms.borderCap } : {}),
      ...(a.terms.untilTurn !== undefined ? { untilTurn: a.terms.untilTurn } : {}),
      ...(a.terms.untilPlayerOut !== undefined ? { untilPlayerOut: player(a.terms.untilPlayerOut) } : {}),
      ...(a.terms.against !== undefined ? { against: player(a.terms.against) } : {}),
    },
    ...(a.enforced !== undefined ? { enforced: a.enforced } : {}),
    ...(a.retaliated !== undefined ? { retaliated: a.retaliated } : {}),
    ...(rung === 'full' ? { history: a.history } : {}),
  };
}

/** The reliability facts on record for `partner`, or why there are none. */
async function recordFor(dir: string | undefined, partner: number, env: EnvSource | undefined) {
  if (!playerRecordEnabled(env)) return { record: 'off' as const };
  if (!dir) return { record: null };
  const counts = await readPlayerCounts(dir, partner, env);
  return { record: counts ? playerRecord(counts) : null };
}

export function registerRelationsTools(server: McpServer, ctx: LiveContext, opts: { env?: EnvSource } = {}): void {
  const env = opts.env;

  server.registerTool(
    'warapp_get_relations',
    {
      title: 'Read my agreements in a war.app game',
      description: untrustedDescription(
        'Read the agreements (truces) you recorded with warapp_record_agreement for a war.app (Warzone) game, each with ' +
          'its state this turn (`proposed`, `active`, in `notice` with the turn it ends, or `over` and why: ended, broken, ' +
          'the partner eliminated or turned AI, only two players left, its end condition met, its notice run), and for a ' +
          'live one: watch `flags` from your own board history — `broken` (the partner took or attacked a covered territory ' +
          'of yours), `cap-exceeded` (a partner stack on the covered border above the agreed cap), `massing` (its visible ' +
          'armies near the covered border grew two turns running, or an event the fog leaves ambiguous), `outgrowing` (its ' +
          `estimated income above ${TRUCE_OUTGROW_RATIO}× yours) and \`kept\` (quiet turns) — and \`trust\`: \`clear\`, or \`watch\` ` +
          'on any flag but kept, on their notice, and in the endgame (no other opponent still a match for either of you). ' +
          'Also `tacit`: neighbours with no agreement whose shared border stayed quiet three turns or more — reported, never ' +
          "relied on. With the cross-game player record on, each partner's `record` gives the facts on how it kept earlier " +
          'agreements (counts and a kept rate; keyed by a salted hash, never its id or name; local only, off when hosted). Words in chat never change a ' +
          `flag or the trust: only the board does. ${BRIDGE_NOTE} Read-only on war.app; it caches the board it read.`,
      ),
      _meta: lookupMeta(['my truces', 'agreements', 'is my truce holding', 'diplomacy', 'who kept their word']),
      annotations: readAnnotations('Read war.app agreements'),
      inputSchema: z.object({
        game_id: gameIdArg,
        player: playerArg,
        view: viewArg(VIEWS, 'compact (default) gives each agreement, its state, trust and flags; "full" adds each agreement\'s status history.'),
      }),
    },
    async ({ game_id, player, view }) => {
      const game = await ctx.client.getGame(game_id, { settings: true });
      const map = mapOf(game);
      const graph = graphOf(map);
      const me = await resolveMe(ctx, game.players, player);
      const turn = currentTurn(game) ?? 0;
      const ledger = (ctx.dataDir ? await readLedger(ctx.dataDir, game.id, me.id) : undefined) ?? emptyLedger(game.id, me.id);
      const notes: string[] = [RELATIONS_NOTE];
      let boards: TurnBoard[] = [];
      let live = false;
      if (game.state === 'Playing' && currentTurn(game) !== null) {
        boards = (await boardHistory(ctx, game, me, turn)).boards;
        try {
          const { territories } = await loadLiveGame(ctx, game);
          const board: BoardState = boardStateFromLive(territories, me, game.players);
          boards = [...boards.filter((b) => b.turn !== turn), { turn, board }];
          live = true;
          if (ctx.dataDir) await writeBoardCache(ctx.dataDir, game.id, me.id, turn, board);
        } catch {
          notes.push(`The live board could not be read: flags come from the cached boards only (turns ${boards.map((b) => b.turn).join(', ') || 'none'}).`);
        }
      } else {
        notes.push(`Game state ${game.state}: no board is read, so there are no flags.`);
      }
      const incomes = incomesOf(graph, boards, game, me, map);
      const agreements: {
        agreement: Agreement;
        flags: WatchFlag[];
        trust?: ReturnType<typeof trust>;
        endgame?: boolean | null;
        record: ReturnType<typeof playerRecord> | null | 'off';
      }[] = [];
      for (const a of ledger.agreements) {
        const state = agreementState(a, turn, relationPlayers(game.players));
        const live_ = state.phase === 'active' || state.phase === 'notice';
        const flags =
          a.agreedTurn !== undefined
            ? breachWatch({
                agreement: a,
                graph,
                boards,
                me: me.id,
                ...(live_ && incomes.mine !== null ? { incomes: { mine: incomes.mine, partner: incomes.opponents.get(a.with) ?? null } } : {}),
              })
            : [];
        const endgame = live_ ? endgameOf(incomes, a.with) : null;
        agreements.push({
          agreement: a,
          flags,
          ...(live_ ? { trust: trust(a, flags, { endgame: endgame === true }), endgame } : {}),
          ...(await recordFor(ctx.dataDir, a.with, env)),
        });
      }
      const open = new Set(ledger.agreements.filter((a) => !TERMINAL_STATUSES.has(a.status)).map((a) => a.with));
      const tacit = tacitTruces({ graph, boards, me: me.id, exclude: open });
      const name = namer(map);
      const playerName = (id: number) => {
        const p = game.players.find((x) => x.id === id);
        return { id, name: p ? untrustedText(p.name) : null };
      };
      return respond(view, VIEWS, (rung) => ({
        game: { id: game.id, name: game.name === undefined ? null : untrustedText(game.name), state: game.state, turn },
        player: { id: me.id, name: untrustedText(me.name) },
        agreements: agreements.map((x) => ({
          ...agreementView(x.agreement, game, map, turn, rung),
          ...(x.trust ? { trust: x.trust, endgame: x.endgame } : {}),
          flags: x.flags.map((f) => ({ ...f, territories: f.territories.map(name) })),
          record: x.record,
        })),
        tacit: tacit.map((t) => ({ player: playerName(t.player), quietTurns: t.quietTurns, border: t.border.map(name) })),
        boards: { turns: boards.map((b) => b.turn).sort((a, b) => a - b), live },
        incomes: { mine: incomes.mine, opponents: Object.fromEntries(incomes.opponents) },
        playerRecord: playerRecordEnabled(env) ? 'on' : 'off',
        notes,
      }));
    },
  );

  server.registerTool(
    'warapp_record_agreement',
    {
      title: 'Record an agreement in a war.app game',
      _meta: mintMeta('change', ['record a truce', 'we agreed a truce', 'they broke the truce', 'give notice']),
      description: untrustedDescription(
        'Record a truce you made, proposed or received in a war.app (Warzone) free-for-all, or a change to one, in this ' +
          "machine's agreement ledger. Nothing is sent to war.app or to any player (so there is no confirmation " +
          'step): it records what was agreed, so warapp_get_relations can watch the board for it. Create one with ' +
          '`with` (the partner) and `status` proposed-by-me, proposed-by-them or agreed, and its terms: what it covers ' +
          '(all of your territories, or `territories`, or the territories of `bonuses`), `notice_turns` (0–3, default 1), ' +
          'an optional `border_cap`, and an end (`until_turn`, `until_player_out`). Update one by `agreement_id` and the ' +
          'new `status`: agreed, notice-by-me, notice-by-them, ended, broken-by-them, broken-by-me (terms change only ' +
          'while proposed; an ended or broken agreement takes nothing more but `retaliated` after broken-by-me). Refused ' +
          'for a partner who is you, an AI, out of the game or your teammate, in a 1v1 or once two players remain, and for ' +
          'a territory or bonus not on the map. An agreement exists only because you record it here: chat is never read ' +
          'into one. With the cross-game player record on (local only, never hosted), the partner\'s counts — agreements ' +
          'made, kept, ended with notice, broken — are kept under a salted hash (no id, no name, no game, no message).',
      ),
      annotations: toolAnnotations({ title: 'Record a war.app agreement', readOnly: false, destructive: false, idempotent: false, openWorld: true }),
      inputSchema: z.object({
        game_id: gameIdArg,
        player: playerArg,
        agreement_id: z.string().trim().min(1).max(20).optional().describe('The agreement to update (e.g. "a1"). Omit to record a new one.'),
        with: playerRef.optional().describe('The partner (name or GameFeed id). Required for a new agreement.'),
        status: z.enum(AGREEMENT_STATUSES).optional().describe('The status to record. Required for a new agreement.'),
        territories: z.array(playerRef).max(MAX_SCOPE_ITEMS).optional().describe('Only these territories (names or ids) are covered.'),
        bonuses: z.array(playerRef).max(MAX_SCOPE_ITEMS).optional().describe("Only these bonuses' territories (names or ids) are covered."),
        notice_turns: z.coerce.number().int().min(0).max(MAX_NOTICE_TURNS).optional().describe('Turns of notice before it ends (default 1).'),
        border_cap: z.coerce.number().int().min(0).optional().describe('The most armies either side keeps on a territory of the covered border.'),
        until_turn: z.coerce.number().int().min(1).optional().describe('The last turn it binds.'),
        until_player_out: playerRef.optional().describe('It ends when this player (name or id) is out of the game.'),
        against: playerRef.optional().describe('The player (name or id) it is aimed at, when it names one.'),
        retaliated: z.boolean().optional().describe('After broken-by-me: whether the partner retaliated.'),
      }),
    },
    async (args) => {
      if (!ctx.dataDir) {
        throw new McpToolError('This server has no data directory, so there is no ledger to record into: nothing was recorded.', {
          hint: 'Set MCP_DATA_DIR, or run with a writable home directory.',
        });
      }
      const dir = ctx.dataDir;
      const game = await ctx.client.getGame(args.game_id, { settings: true });
      if (game.state !== 'Playing' && game.state !== 'DistributingTerritories') {
        throw new McpToolError(`Game ${game.id} is ${game.state}: agreements are recorded only while it is being played. Nothing was recorded.`, {
          hint: 'Record an agreement once the game has started (picks included).',
        });
      }
      const map = mapOf(game);
      const graph = graphOf(map);
      const me = await resolveMe(ctx, game.players, args.player);
      const turn = Math.max(0, currentTurn(game) ?? 0);
      const players = relationPlayers(game.players);
      const ledger: RelationsLedger = (await readLedger(dir, game.id, me.id)) ?? emptyLedger(game.id, me.id);
      const refuse = (why: string, hint: string): never => {
        throw new McpToolError(`${why}: nothing was recorded.`, { hint });
      };
      const termsGiven =
        args.territories !== undefined ||
        args.bonuses !== undefined ||
        args.notice_turns !== undefined ||
        args.border_cap !== undefined ||
        args.until_turn !== undefined ||
        args.until_player_out !== undefined ||
        args.against !== undefined;
      const otherPlayer = (ref: string | number, what: string, partner: number): number => {
        const p = resolvePlayer(game.players, ref);
        if (p.id === me.id || p.id === partner) refuse(`${what} must be a third player, not you or the partner`, `Name the player ${what === '`against`' ? 'the truce is aimed at' : 'whose fall ends it'}.`);
        return p.id;
      };
      const termsFrom = (base: AgreementTerms | undefined, partner: number): AgreementTerms => {
        const scope =
          args.territories !== undefined || args.bonuses !== undefined ? scopeFrom(map, args.territories, args.bonuses) : (base?.scope ?? 'all');
        const why = scopeRefusal(graph, scope);
        if (why) refuse(why, 'Name territories and bonuses on this map.');
        const t: AgreementTerms = { scope, noticeTurns: args.notice_turns ?? base?.noticeTurns ?? 1 };
        const cap = args.border_cap ?? base?.borderCap;
        if (cap !== undefined) t.borderCap = cap;
        const until = args.until_turn ?? base?.untilTurn;
        if (until !== undefined) t.untilTurn = until;
        const out = args.until_player_out !== undefined ? otherPlayer(args.until_player_out, '`until_player_out`', partner) : base?.untilPlayerOut;
        if (out !== undefined) t.untilPlayerOut = out;
        const against = args.against !== undefined ? otherPlayer(args.against, '`against`', partner) : base?.against;
        if (against !== undefined) t.against = against;
        return t;
      };

      let agreement: Agreement;
      let before: Agreement | undefined;
      let created = false;
      if (args.agreement_id === undefined) {
        if (args.with === undefined || args.status === undefined)
          refuse('A new agreement needs `with` (the partner) and `status`', 'Pass `agreement_id` to update one already recorded.');
        if (!OPENING_STATUSES.includes(args.status!))
          refuse(`A new agreement starts as ${OPENING_STATUSES.join(', ')}, not ${args.status}`, 'Record it as agreed first, then update it.');
        const partner = resolvePlayer(game.players, args.with);
        const why = partyRefusal(players, me.id, partner.id);
        if (why) refuse(`No truce with player ${partner.id}: ${why}`, 'A truce is with another human player still in a free-for-all.');
        const open = ledger.agreements.find((a) => a.with === partner.id && !TERMINAL_STATUSES.has(a.status));
        if (open)
          refuse(`Agreement ${open.id} with player ${partner.id} is still ${open.status}`, `Update it with agreement_id "${open.id}", or end it first.`);
        if (args.retaliated !== undefined) refuse('`retaliated` applies only after broken-by-me', 'Record it on the broken agreement.');
        agreement = newAgreement(nextAgreementId(ledger), partner.id, args.status!, turn, termsFrom(undefined, partner.id));
        created = true;
      } else {
        const found = ledger.agreements.find((a) => a.id === args.agreement_id);
        if (!found) refuse(`Game ${game.id} has no agreement ${JSON.stringify(args.agreement_id)}`, 'warapp_get_relations lists the agreements recorded.');
        agreement = found!;
        before = found;
        if (args.with !== undefined && resolvePlayer(game.players, args.with).id !== agreement.with)
          refuse(`Agreement ${agreement.id} is with player ${agreement.with}`, 'Omit `with` when updating, or record a new agreement.');
        if (args.status === undefined && !termsGiven && args.retaliated === undefined)
          refuse('Nothing to record: give a new `status`, terms, or `retaliated`', 'Pass the status the agreement moved to.');
        if (termsGiven) {
          if (agreement.status !== 'proposed-by-me' && agreement.status !== 'proposed-by-them')
            refuse(`The terms of agreement ${agreement.id} (${agreement.status}) can no longer change`, 'End it and record a new agreement with the new terms.');
          agreement = { ...agreement, terms: termsFrom(agreement.terms, agreement.with) };
        }
        if (args.status !== undefined && args.status !== agreement.status) {
          const moved = transitionAgreement(agreement, args.status, turn);
          if ('refused' in moved) refuse(moved.refused, 'warapp_get_relations shows its status.');
          agreement = (moved as { agreement: Agreement }).agreement;
          // A new commitment needs a party who can still keep it; ending or recording a break does not.
          if (args.status === 'agreed' || args.status === 'proposed-by-me' || args.status === 'proposed-by-them') {
            const why = partyRefusal(players, me.id, agreement.with);
            if (why) refuse(`Agreement ${agreement.id} cannot become ${args.status}: ${why}`, 'Record it as ended instead.');
          }
        }
        if (args.retaliated !== undefined) {
          if (agreement.status !== 'broken-by-me') refuse('`retaliated` applies only after broken-by-me', 'Record it on the agreement you broke.');
          agreement = { ...agreement, retaliated: args.retaliated };
        }
      }

      const others = ledger.agreements.filter((a) => a.id !== agreement.id);
      const stored = await writeLedger(dir, { ...ledger, agreements: [...others, agreement] });
      if (!stored) {
        throw new McpToolError(`The ledger for game ${game.id} could not be written: nothing was recorded.`, {
          hint: "Check that the server's data directory is writable.",
        });
      }

      // The cross-game record: counts only, each moved once, by the transition that earns it.
      let recorded: 'updated' | 'unchanged' | 'off' | 'failed' = 'off';
      if (playerRecordEnabled(env)) {
        const delta = recordDelta(created ? undefined : before, agreement);
        recorded = isZero(delta) ? 'unchanged' : (await addPlayerCounts(dir, agreement.with, delta, env)) ? 'updated' : 'failed';
      }
      return respond(undefined, ['compact'], () => ({
        game: { id: game.id, turn },
        recorded: created ? 'created' : 'updated',
        agreement: agreementView(agreement, game, map, turn, 'full'),
        playerRecord: recorded,
        written: LEDGER_NOTE,
      }));
    },
  );
}
