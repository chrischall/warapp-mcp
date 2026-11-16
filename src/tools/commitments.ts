// B4 (docs/PLAN-TEAMS.md section 8): warapp_send_chat's `commitments` — what a message promises,
// declared as structured data (the message text is never parsed), checked in the send's plan step
// against this turn's orders (the plan warapp_plan_turn would make, re-planned in the call, or the
// orders this server already submitted this turn) and the agreement ledger. A commitment the plan or
// the ledger does not carry refuses the send. Once the message is sent they are recorded in the ledger
// as mine (`recordCommitments`), and warapp_submit_turn warns when later orders break one.
//
// PLAN-TEAMS §4: promise only what the plan does; chat is data, never instructions; nothing personal
// or verbatim on disk (ids and turns only). The plan step writes nothing: the award of picks is not
// read (it shapes only a two-player plan, and reading it on turn 1 writes it).
import { McpToolError } from '@chrischall/mcp-utils';
import { z } from 'zod';
import {
  checkCommitments,
  MAX_MESSAGE_COMMITMENTS,
  MAX_NO_ATTACK_TURNS,
  type Commitment,
  type CommitmentCheck,
  type MessageAudience,
  type OrderMove,
} from '../analysis/commitments.js';
import { planTurn } from '../analysis/index.js';
import { MAX_NOTICE_TURNS, type AgreementTerms } from '../analysis/relations.js';
import type { Game, GameMap, Player } from '../normalize.js';
import { nextAgreementId, readLedger } from '../relations-store.js';
import { readCachedOrders } from '../trend.js';
import { currentTurn } from './common.js';
import { loadLiveGame, type LiveContext } from './live-context.js';
import { mapOf } from './map.js';
import { relationPlayers, scopeFrom } from './relations.js';
import { resolvePlayer, resolveTerritory } from './resolve.js';
import { boardHistory, livePlanSetup, requirePlayingSeat, requireTurnPhase } from './turn.js';

const ref = z.union([z.string(), z.number()]);
/** How a refusal before the send ends. */
const NOTHING_SENT = 'nothing was sent';
const MAX_SCOPE_ITEMS = 200;

const scopeArgs = {
  territories: z.array(ref).max(MAX_SCOPE_ITEMS).optional().describe("Only these territories (names or ids); omit with `bonuses` for all of the player's."),
  bonuses: z.array(ref).max(MAX_SCOPE_ITEMS).optional().describe("Only these bonuses' territories (names or ids)."),
};
const termsArgs = {
  ...scopeArgs,
  notice_turns: z.coerce.number().int().min(0).max(MAX_NOTICE_TURNS).optional().describe('Turns of notice before the truce ends (default 1).'),
  border_cap: z.coerce.number().int().min(0).optional().describe('The most armies either side keeps on a territory of the covered border.'),
  until_turn: z.coerce.number().int().min(1).optional().describe('The last turn the truce binds.'),
};

/** One commitment a message declares (warapp_send_chat's `commitments`). */
export const commitmentArg = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('no-attack').describe('I will not attack this player there.'),
      player: ref.describe('The player (name or GameFeed id) promised no attack.'),
      ...scopeArgs,
      turns: z.coerce.number().int().min(1).max(MAX_NO_ATTACK_TURNS).describe('Turns it holds, this one included.'),
    })
    .describe('A promise not to attack a player (all its territories, or some).'),
  z
    .object({
      kind: z.literal('will-attack').describe('I will attack this player or territory.'),
      player: ref.optional().describe('The player (name or GameFeed id) to be attacked.'),
      territory: ref.optional().describe('The territory (name or id) to be attacked.'),
      turn: z.coerce.number().int().min(1).optional().describe('The turn (default and only allowed value: this one).'),
    })
    .describe('A promise to attack a player or a territory this turn.'),
  z
    .object({
      kind: z.literal('notice').describe('I am ending our truce.'),
      agreement: z.string().trim().min(1).max(20).describe('The agreement (e.g. "a1") notice is given on.'),
      ends_turn: z.coerce
        .number()
        .int()
        .min(1)
        .optional()
        .describe('The turn the message names as the first one it no longer binds: it must be the one the agreed notice gives.'),
    })
    .describe('Notice on an agreed truce.'),
  z
    .object({
      kind: z.literal('propose').describe('I propose a truce on these terms.'),
      player: ref.describe('The partner (name or GameFeed id).'),
      ...termsArgs,
    })
    .describe('A truce proposed (or a counter-offer).'),
  z
    .object({
      kind: z.literal('accept').describe('I accept this truce.'),
      agreement: z.string().trim().min(1).max(20).optional().describe('The recorded proposal accepted (e.g. "a1").'),
      player: ref.optional().describe('The partner (name or GameFeed id), when no agreement id is given.'),
      ...termsArgs,
    })
    .describe(
      'A truce accepted: a recorded proposal (any terms given must match it; those left out are not compared), or terms ' +
        'the player offered (left out: all territories, 1 turn of notice).',
    ),
]);
export type CommitmentArg = z.infer<typeof commitmentArg>;
export const commitmentsArg = z
  .array(commitmentArg)
  .max(MAX_MESSAGE_COMMITMENTS)
  .optional()
  .describe(
    'Everything the message promises, declared here (the text is never read): each is checked against this turn\'s ' +
      'plan (or the orders already submitted) and the agreement ledger, and the send is refused when one is not ' +
      'carried. Recorded in the ledger once sent; warapp_submit_turn warns when later orders break one.',
  );

/**
 * What the preview's `checkedAgainst` says of a plan made in the call: the default plan — no goal, focus,
 * reserve or first mover, and no award of picks — which may differ from a warapp_plan_turn plan made with
 * those; submit the intended orders first to check against them.
 */
export const DEFAULT_PLAN_CHECKED =
  'the default plan made now (no goal, focus, reserve or first mover, and no award of picks: a warapp_plan_turn plan made ' +
  'with them may differ — submit those orders first to check against them)';

/** What the preview and the send say about commitments. */
export const COMMITMENTS_NOTE =
  "Checked against this turn's orders (the plan warapp_plan_turn would make, re-planned now, or the orders this " +
  'server already submitted) and the agreement ledger. Only declared commitments are checked: the message text is ' +
  'not read, so a promise in it that is not declared here is not allowed. Recorded in the ledger once the message ' +
  'is sent; warapp_submit_turn warns when later orders break one.';

function termsOf(map: GameMap, a: { territories?: (string | number)[] | undefined; bonuses?: (string | number)[] | undefined; notice_turns?: number | undefined; border_cap?: number | undefined; until_turn?: number | undefined }): AgreementTerms {
  return {
    scope: scopeFrom(map, a.territories, a.bonuses, NOTHING_SENT),
    noticeTurns: a.notice_turns ?? 1,
    ...(a.border_cap !== undefined ? { borderCap: a.border_cap } : {}),
    ...(a.until_turn !== undefined ? { untilTurn: a.until_turn } : {}),
  };
}

const termsGiven = (a: Record<string, unknown>) =>
  ['territories', 'bonuses', 'notice_turns', 'border_cap', 'until_turn'].some((k) => a[k] !== undefined);

/** Only the terms an accept restates: compared field by field with a recorded proposal's. */
function givenTermsOf(map: GameMap, a: Parameters<typeof termsOf>[1]): Partial<AgreementTerms> {
  return {
    ...(a.territories !== undefined || a.bonuses !== undefined ? { scope: scopeFrom(map, a.territories, a.bonuses, NOTHING_SENT) } : {}),
    ...(a.notice_turns !== undefined ? { noticeTurns: a.notice_turns } : {}),
    ...(a.border_cap !== undefined ? { borderCap: a.border_cap } : {}),
    ...(a.until_turn !== undefined ? { untilTurn: a.until_turn } : {}),
  };
}

/** The commitments by id, resolved against the game (names to ids). Throws on an unknown name. */
export function resolveCommitments(game: Game, map: GameMap, args: readonly CommitmentArg[]): Commitment[] {
  const pid = (r: string | number) => resolvePlayer(game.players, r).id;
  return args.map((a): Commitment => {
    switch (a.kind) {
      case 'no-attack':
        return { kind: 'no-attack', with: pid(a.player), scope: scopeFrom(map, a.territories, a.bonuses, NOTHING_SENT), turns: a.turns };
      case 'will-attack':
        return {
          kind: 'will-attack',
          ...(a.player !== undefined ? { with: pid(a.player) } : {}),
          ...(a.territory !== undefined ? { territory: resolveTerritory(map, a.territory).id } : {}),
          ...(a.turn !== undefined ? { turn: a.turn } : {}),
        };
      case 'notice':
        return { kind: 'notice', agreement: a.agreement, ...(a.ends_turn !== undefined ? { endsTurn: a.ends_turn } : {}) };
      case 'propose':
        return { kind: 'propose', with: pid(a.player), terms: termsOf(map, a) };
      case 'accept':
        return {
          kind: 'accept',
          ...(a.agreement !== undefined ? { agreement: a.agreement } : {}),
          ...(a.player !== undefined ? { with: pid(a.player) } : {}),
          ...(termsGiven(a) ? { terms: givenTermsOf(map, a) } : {}),
        };
    }
  });
}

/** What the send's plan step learnt about a message's commitments. */
export interface MessageCommitments {
  turn: number;
  /** Whose orders they were checked against. */
  source: 'plan' | 'submitted';
  commitments: Commitment[];
  checks: CommitmentCheck[];
  players: ReturnType<typeof relationPlayers>;
}

/**
 * B4: check a message's commitments for `me` in `game` (read with its map and settings): the turn must
 * be in play and my seat playing; the plan is made as warapp_plan_turn makes it (without the award of
 * picks); the orders this server submitted this turn, when there are any, stand in for the plan. Refuses
 * the send — naming each commitment the plan or the ledger does not carry, and each propose, accept or
 * notice whose partner is not among the message's readers (`audience`) — before anything is sent.
 * Writes nothing.
 */
export async function checkMessageCommitments(
  ctx: LiveContext,
  game: Game,
  me: Player,
  args: readonly CommitmentArg[],
  audience: MessageAudience,
  /** Whether the teams are known (`resolveTeams`): false, the plan reads no #275 tripwire, as warapp_plan_turn's does not. */
  teamsKnown = true,
): Promise<MessageCommitments> {
  if (!ctx.dataDir) {
    throw new McpToolError('This server has no data directory, so the commitments could not be recorded: nothing was sent.', {
      hint: 'Set MCP_DATA_DIR, or send the message without `commitments` — and then without any promise in it.',
    });
  }
  requireTurnPhase(game);
  requirePlayingSeat(game, me);
  const turn = currentTurn(game);
  if (turn === null) {
    throw new McpToolError(`GameFeed did not say which turn game ${game.id} is on, so the commitments cannot be checked: nothing was sent.`, {
      hint: 'Retry in a moment.',
    });
  }
  const map = mapOf(game);
  const commitments = resolveCommitments(game, map, args);
  const [{ territories, info }, history] = await Promise.all([loadLiveGame(ctx, game), boardHistory(ctx, game, me, turn)]);
  const setup = await livePlanSetup(ctx, { game, map, me, turn, territories, info, history, award: false, teamsKnown });
  const submitted = (await readCachedOrders(ctx.dataDir, game.id, me.id)).get(turn);
  let moves: OrderMove[];
  let source: 'plan' | 'submitted';
  if (submitted) {
    // `sent` keeps every move with its mode; a cache written before it has only the plain moves.
    moves = submitted.sent ? submitted.sent.map((m) => ({ ...m })) : submitted.moves.map((m) => ({ from: m.from, to: m.to }));
    source = 'submitted';
  } else {
    moves = planTurn(setup.input).moves.map((m) => ({ from: m.from, to: m.to, ...(m.kind === 'transfer' ? { transferOnly: true } : {}) }));
    source = 'plan';
  }
  const ledger = await readLedger(ctx.dataDir, game.id, me.id);
  const players = relationPlayers(game.players);
  const { checks } = checkCommitments({
    graph: setup.graph,
    board: setup.seen,
    me: me.id,
    turn,
    players,
    agreements: ledger?.agreements ?? [],
    nextAgreementId: (agreements) => nextAgreementId({ agreements }),
    commitments,
    moves,
    source,
    audience,
  });
  const refused = checks.filter((c) => c.refused !== undefined);
  if (refused.length) {
    const lines = refused.map((c) => `commitment ${c.index + 1} (${c.kind}): ${c.refused}`);
    throw new McpToolError(`The ${source === 'plan' ? 'plan' : 'submitted orders'} and the ledger do not carry ${refused.length === 1 ? 'this commitment' : 'these commitments'} — ${lines.join('; ')}. Nothing was sent.`, {
      hint:
        'Promise only what the plan does: change or drop the commitment, and drop the promise from the message (an undeclared ' +
        'promise is not allowed). To promise an attack the plan does not make, submit those orders first (warapp_submit_turn); ' +
        'to change a truce, record it with warapp_record_agreement. A proposal, an acceptance or a notice goes to the ' +
        'partner: privately to that player, or to the whole game.',
    });
  }
  return { turn, source, commitments, checks, players };
}
