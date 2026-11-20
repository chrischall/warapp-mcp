// The decision log's capture points (#412 task 2), one helper each, so every tool logs the same way:
// `capturePlan` (warapp_plan_turn's decision, and the previous turn's outcome), `captureObservation`
// (a board read without a plan: the board cache's writers and boardHistory's history fill) and
// `captureSent` (warapp_submit_turn's orders, with any override). Best effort, never throws; nothing
// without a data dir or with `WARAPP_DECISION_LOG=off` (`LiveContext.decisionLog`). Name-free: every
// player name the game carries is scrubbed by the store.
//
// #437: the per-turn additions — `capturePlan` takes the first mover, my hand, the card advice and the
// turn's boot deadlines; `captureSent` the submit's checks; `captureCheck` warapp_check_plan's summary —
// and the pure helpers that turn each tool's own values into the log's name-free shapes.
//
// #437 task 2, per game: `captureSeats` (every GameFeed game read, through `WarappClient.observeGames`: the
// seat events and opponents first seen, as the log's own account — else the signed-in one only when a read
// already gave it, never a request), `captureGameEvent` (a pending surrender seen, my acceptance, my own
// surrender), `captureJoin` (warapp_join_game confirmed) and `captureOpponentRead` (warapp_scout_player with
// a game), and the pure shapers `joinContextLog` and `mySurrenderDetail`.
//
// #437 task 3, the picks phase: `capturePicksAdvice` (warapp_plan_picks: `picksAdviceLog`, warnings by
// `pickWarningCode`), `capturePicksSent` (warapp_submit_picks after a send) and `capturePicksAward` (the award
// `loadAward` reads on turn 1, once).
import { createHash } from 'node:crypto';
import type { HeadroomRow } from '../analysis/headroom.js';
import type { OutlookLean, OutlookState } from '../analysis/outlook.js';
import type { stressPlan } from '../analysis/stress.js';
import type { CommitmentWarning } from '../analysis/commitments.js';
import type { Card } from '../cards.js';
import { type Game, parseFeedTime } from '../normalize.js';
import { bonusTerritories } from '../analysis/bonuses.js';
import type { MapGraph } from '../analysis/graph.js';
import type { EnemyDeployEstimate, PlanInput, TurnPlan } from '../analysis/plan/shared.js';
import type { BoardState } from '../board.js';
import type { OutlookLog } from '../outlook-log.js';
import type { JoinScreen, OpenGame, PolicyCheck } from '../open-games.js';
import { policyChecks } from '../open-games.js';
import { nameFreeSettings } from '../replay.js';
import {
  type CheckPlanSummary,
  type DecisionLogMode,
  type PicksAdvice,
  type PicksSent,
  recordPicksAdvice,
  recordPicksAward,
  recordPicksSent,
  decisionLogMode,
  decisionLogOwner,
  decisionLogPath,
  decisionOutcome,
  type GameEvent,
  type JoinContext,
  type MySurrenderDetail,
  type OpponentRead,
  recordGameEvent,
  recordJoin,
  recordOpponentRead,
  recordSeats,
  type DecisionRecord,
  type DecisionTimes,
  fillOutcome,
  type LoggedChatMessage,
  recordChat,
  type LoggedCardAdvice,
  type LoggedHeadroom,
  type Observation,
  recordCheck,
  recordDecision,
  recordObservations,
  recordSubmission,
  type Submission,
  type SubmitChecks,
} from '../decision-log.js';
import type { AwardReading } from '../analysis/award.js';
import type { PickPlan } from '../analysis/picks.js';
import type { CommanderCheck } from './commander-check.js';
import type { LiveContext } from './live-context.js';

type Ctx = Partial<Pick<LiveContext, 'dataDir' | 'decisionLog'>>;
const modeOf = (ctx: Ctx) => (ctx.decisionLog ? { mode: ctx.decisionLog } : {});

/** Every bonus of the map with its member territories (superbonuses flattened). */
const bonusesOf = (graph: MapGraph): Map<number, readonly number[]> => new Map([...graph.bonusById.keys()].map((id) => [id, bonusTerritories(graph, id)]));

/**
 * Log the turn warapp_plan_turn planned (not a what-if plan), then fill the previous turn's outcome
 * from this turn's board and income when that turn has an entry without one. Never throws.
 */
export async function capturePlan(
  ctx: Ctx,
  a: {
    gameId: number;
    me: number;
    turn: number;
    board: BoardState;
    /** The board the planner read (`input.board`), when it may differ from the board seen. */
    plannedBoard?: BoardState;
    input: PlanInput;
    plan: TurnPlan;
    outlookState: OutlookState | null;
    /** #454: the outlook's income lean beside an even state (`GameOutlook.lean`). */
    outlookLean?: OutlookLean;
    /** The per-opponent deploy estimates the plan worked from (scored against the truth at the end, #412 task 3). */
    estimates?: readonly EnemyDeployEstimate[];
    graph: MapGraph;
    /** This turn's income, card armies out. */
    income: number;
    players: readonly { id: number; name?: string }[];
    /** #437: the plan's first mover (`null`: unknown), my hand and the advice, the turn's boot deadlines. */
    firstMover?: DecisionRecord['firstMover'];
    cards?: DecisionRecord['cards'];
    times?: DecisionRecord['times'];
  },
): Promise<void> {
  if (!ctx.dataDir) return;
  const opts = modeOf(ctx);
  await recordDecision(
    ctx.dataDir,
    a.gameId,
    a.me,
    {
      turn: a.turn,
      board: a.board,
      ...(a.plannedBoard ? { plannedBoard: a.plannedBoard } : {}),
      input: a.input,
      plan: a.plan,
      outlookState: a.outlookState,
      ...(a.outlookLean ? { outlookLean: a.outlookLean } : {}),
      ...(a.estimates ? { estimates: a.estimates } : {}),
      players: a.players,
      ...(a.firstMover !== undefined ? { firstMover: a.firstMover } : {}),
      ...(a.cards ? { cards: a.cards } : {}),
      ...(a.times ? { times: a.times } : {}),
    },
    opts,
  );
  if (a.turn < 2) return;
  try {
    await fillOutcome(
      ctx.dataDir,
      a.gameId,
      a.me,
      a.turn - 1,
      (entry, before) =>
        decisionOutcome({ before, after: a.board, me: a.me, income: a.income, captures: entry.decision?.expected.captures ?? [], bonuses: bonusesOf(a.graph) }),
      opts,
    );
  } catch {
    // Best effort.
  }
}

/** Log boards seen without a plan as observations (never over a planned entry). Never throws. */
export async function captureObservation(ctx: Ctx, gameId: number, me: number, seen: readonly Observation[]): Promise<void> {
  if (!ctx.dataDir || !seen.length) return;
  await recordObservations(ctx.dataDir, gameId, me, seen, modeOf(ctx));
}

/** Log the orders warapp_submit_turn sent, with any override (see `recordSubmission`). Never throws. */
export async function captureSent(ctx: Ctx, gameId: number, me: number, turn: number, sub: Submission): Promise<void> {
  if (!ctx.dataDir) return;
  await recordSubmission(ctx.dataDir, gameId, me, turn, sub, modeOf(ctx));
}

/** Log the chat read on a planned turn (#415: ids and labels only) beside its entry. Never throws. */
export async function captureChat(
  ctx: Ctx,
  gameId: number,
  me: number,
  turn: number,
  chat: readonly LoggedChatMessage[],
  opts: { blockFlagOnly?: boolean } = {},
): Promise<void> {
  if (!ctx.dataDir || !chat.length) return;
  await recordChat(ctx.dataDir, gameId, me, turn, chat, { ...modeOf(ctx), ...opts });
}

/** Log warapp_check_plan's summary of the turn (the latest run wins). Never throws. */
export async function captureCheck(ctx: Ctx, gameId: number, me: number, turn: number, summary: CheckPlanSummary): Promise<void> {
  if (!ctx.dataDir) return;
  await recordCheck(ctx.dataDir, gameId, me, turn, summary, modeOf(ctx));
}

// ---------------------------------------------------------------------------------------------
// #437: the tools' values in the log's shapes (pure)

const byNum = (a: number, b: number) => a - b;

/** My hand by card type, counted, sorted by name (then type). */
export function handLog(cards: readonly Pick<Card, 'type' | 'name'>[]): { card: string; type: number; count: number }[] {
  const m = new Map<number, { card: string; type: number; count: number }>();
  for (const c of cards) {
    const e = m.get(c.type);
    if (e) e.count += 1;
    else m.set(c.type, { card: c.name, type: c.type, count: 1 });
  }
  return [...m.values()].sort((a, b) => a.card.localeCompare(b.card) || a.type - b.type);
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []);

/**
 * The card advice warapp_plan_turn offered (`cards.advice`), one entry per card advised: its kind, the
 * target ids, the player when one is named and a reason code — never the advice's prose. `active` (the
 * cards in effect) is not advice and is left out.
 */
export function cardAdviceLog(view: object): LoggedCardAdvice[] {
  const v = view as Readonly<Record<string, unknown>>;
  const out: LoggedCardAdvice[] = [];
  const add = (kind: string, targets: number[], reason: string | null, player?: number, extra: Partial<LoggedCardAdvice> = {}) =>
    out.push({ kind, targets, ...(player !== undefined ? { player } : {}), reason, ...extra });
  const d = rec(v.orderDelay);
  if (d) add('orderDelay', [], d.insteadOfDiscard ? 'instead-of-discard' : 'delay-attacks', undefined, num(d.before) !== undefined ? { before: num(d.before)! } : {});
  const b = rec(v.bomb);
  if (b) add('bomb', num(b.target) !== undefined ? [num(b.target)!] : [], typeof b.kind === 'string' ? b.kind : 'none');
  const e = rec(v.emergencyBlockade);
  if (e) add('emergencyBlockade', nums([e.territory]), 'conceded-wall', num(e.player));
  const bk = rec(v.blockade);
  if (bk) add('blockade', nums([bk.territory]), 'gate', num(bk.player));
  const dip = rec(v.diplomacy);
  if (dip) add('diplomacy', nums(dip.borders), dip.overTruce !== undefined ? 'over-truce' : 'border-pressure', num(dip.player));
  const s = rec(v.sanctions);
  if (s) add('sanctions', [], 'strongest', num(s.player));
  const a = rec(v.airlift);
  if (a) add('airlift', nums([a.from, a.to]), a.teammate !== undefined ? 'teammate-border' : 'border');
  const g = rec(v.gift);
  if (g) add('gift', nums(g.territories), 'teammate-bonus', num(g.player));
  const spy = rec(v.spy);
  if (spy) add('spy', [], 'fog', num(spy.player));
  const r = rec(v.reconnaissance);
  if (r) add('reconnaissance', nums([r.target]), 'fog');
  const sv = rec(v.surveillance);
  if (sv) add('surveillance', nums([sv.bonus]), 'fog');
  return out;
}

/** Headroom rows logged at most. */
export const LOGGED_HEADROOM_ROWS = 5;

/** The weakest {@link LOGGED_HEADROOM_ROWS} headroom rows (the smallest deploy that takes it first; none taking it last). */
export function headroomLog(rows: readonly HeadroomRow[]): LoggedHeadroom[] {
  const key = (r: HeadroomRow) => r.deploy ?? Number.POSITIVE_INFINITY;
  return [...rows]
    .sort((x, y) => key(x) - key(y) || x.territory - y.territory)
    .slice(0, LOGGED_HEADROOM_ROWS)
    .map((r) => ({
      territory: r.territory,
      takeAt: r.deploy,
      opponent: r.opponent,
      from: r.from,
      protects: { bonuses: r.bonuses.map((b) => b.id).sort(byNum), behindIncome: r.behindIncome, breachIncome: r.breach.income },
    }));
}

/** warapp_check_plan's report in the log's shape: the verdict, the worst reply in numbers and the at-risk counts. */
export function checkPlanLog(
  report: Pick<ReturnType<typeof stressPlan>, 'safe' | 'worst' | 'harmful' | 'considered' | 'atRisk'>,
  o: { whatIf: boolean },
): CheckPlanSummary {
  const w = report.worst;
  return {
    safe: report.safe,
    worst: w
      ? {
          opponent: w.opponent,
          kind: w.kind,
          deploy: w.deploy,
          lost: w.lost.length,
          capturesFailed: w.capturesFailed.length,
          bonusesLost: w.bonusesLost.length,
          incomeLost: w.incomeLost,
          commanderLost: w.commanderLost,
        }
      : null,
    harmful: report.harmful,
    considered: report.considered,
    atRisk: {
      commander: report.atRisk.commander,
      territories: report.atRisk.territories.length,
      captures: report.atRisk.captures.length,
      bonuses: report.atRisk.bonuses.length,
    },
    ...(o.whatIf ? { whatIf: true as const } : {}),
  };
}

/** What warapp_submit_turn checked on the orders, in the log's shape (ids and numbers only). */
export function submitChecksLog(a: {
  commander: (Pick<CommanderCheck, 'safety' | 'replyDeploy'> & { accepted?: boolean }) | undefined;
  headroom: readonly HeadroomRow[];
  belowPlan: { rows: readonly { territory: number; planLeaves: number; left: number; short: number }[]; against: 'plan' | 'guess' } | undefined;
  chat: readonly Pick<CommitmentWarning, 'kind' | 'with' | 'moves' | 'unchecked'>[];
}): SubmitChecks {
  const c = a.commander;
  return {
    commander: c
      ? {
          territory: c.safety.territory,
          armies: c.safety.armies,
          needs: c.safety.needs,
          replies: c.safety.killers,
          replyDeploy: c.replyDeploy,
          ...(c.accepted ? { accepted: true } : {}),
        }
      : null,
    headroom: headroomLog(a.headroom),
    belowPlan: (a.belowPlan?.rows ?? []).map((r) => ({ territory: r.territory, planLeaves: r.planLeaves, left: r.left, short: r.short })),
    ...(a.belowPlan ? { belowPlanAgainst: a.belowPlan.against } : {}),
    chat: a.chat.map((w) => ({
      kind: w.kind,
      ...(w.with !== undefined ? { with: w.with } : {}),
      moves: w.moves.map((m) => m.index),
      ...(w.unchecked ? { unchecked: true as const } : {}),
    })),
  };
}

/**
 * The turn's start (GameFeed's `lastTurnTime`, read as it — UNVERIFIED, as the boot warnings say) and the
 * boot deadlines its AutoBoot and DirectBoot minutes give, ISO; empty when the game read gives none.
 */
export function bootTimes(game: Pick<Game, 'lastTurnTime' | 'endRules'>): Pick<DecisionTimes, 'turnStartedAt' | 'bootAt'> {
  const start = parseFeedTime(game.lastTurnTime);
  if (start === undefined) return {};
  const at = (m: number | undefined) => (m !== undefined && m > 0 ? new Date(start + m * 60_000).toISOString() : undefined);
  const auto = at(game.endRules?.autoBootMinutes);
  const direct = at(game.endRules?.directBootMinutes);
  return {
    turnStartedAt: new Date(start).toISOString(),
    ...(auto || direct ? { bootAt: { ...(auto ? { auto } : {}), ...(direct ? { direct } : {}) } } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// #437 task 2: per-game events and context

/** The turn being played as a game read gives it: GameFeed's completed turns + 1, 0 before the first turn. */
export const turnOfGame = (game: Pick<Game, 'numberOfTurns'>): number =>
  game.numberOfTurns !== undefined && game.numberOfTurns >= 0 ? game.numberOfTurns + 1 : 0;

const offMode = (ctx: Ctx) => (ctx.decisionLog ?? decisionLogMode()) === 'off';

/** Each game's seats as last captured this process (data dir + game → signature), so an unchanged read costs nothing. */
const seatsSeen = new Map<string, string>();
const SEATS_SEEN_MAX = 2000;

/**
 * Diff a game read's seats into its decision log (`recordSeats`): as the account the log belongs to when it
 * is seated, else the signed-in account when a read already gave it (`cachedInviteToken`) and the game is not
 * over — that starts a log; never a request. A read whose seats did not change since the last capture in this
 * process is skipped. Never throws.
 */
export async function captureSeats(ctx: Ctx & Partial<Pick<LiveContext, 'cachedInviteToken'>>, game: Pick<Game, 'id' | 'state' | 'players' | 'numberOfTurns'>): Promise<void> {
  try {
    if (!ctx.dataDir || offMode(ctx) || !game.players.length) return;
    const sig = JSON.stringify(game.players.map((p) => [p.id, p.state ?? null, !!p.humanTurnedIntoAI, !!p.isAI]));
    const key = `${ctx.dataDir}\0${game.id}`;
    if (seatsSeen.get(key) === sig) return;
    const ids = new Set(game.players.map((p) => p.id));
    const owner = await decisionLogOwner(decisionLogPath(ctx.dataDir, game.id), game.id);
    let me: number | undefined;
    let create = false;
    if (owner !== undefined) {
      if (ids.has(owner)) me = owner;
    } else {
      const token = ctx.cachedInviteToken?.();
      if (token !== undefined && ids.has(token) && game.state !== 'Finished') {
        me = token;
        create = true;
      }
    }
    // Not mine (yet): not remembered, so a later read that knows the account captures it.
    if (me === undefined) return;
    await recordSeats(ctx.dataDir, game.id, me, { turn: turnOfGame(game), players: game.players, create }, modeOf(ctx));
    if (seatsSeen.size >= SEATS_SEEN_MAX) seatsSeen.delete(seatsSeen.keys().next().value as string);
    seatsSeen.set(key, sig);
  } catch {
    // Best effort.
  }
}

/** Log one per-game event (see `recordGameEvent`), starting a log with `create`. Never throws. */
export async function captureGameEvent(
  ctx: Ctx,
  gameId: number,
  me: number,
  ev: Omit<GameEvent, 'at'>,
  o: { create?: boolean } = {},
): Promise<void> {
  if (!ctx.dataDir) return;
  await recordGameEvent(ctx.dataDir, gameId, me, ev, o, modeOf(ctx));
}

/** Keep the lobby warapp_join_game joined. Never throws. */
export async function captureJoin(ctx: Ctx, gameId: number, me: number, join: JoinContext): Promise<void> {
  if (!ctx.dataDir) return;
  await recordJoin(ctx.dataDir, gameId, me, join, modeOf(ctx));
}

/** Keep what warapp_scout_player read of an opponent in that game's log, when the game has one. Never throws. */
export async function captureOpponentRead(ctx: Ctx, gameId: number, me: number, player: number, read: OpponentRead): Promise<void> {
  if (!ctx.dataDir) return;
  await recordOpponentRead(ctx.dataDir, gameId, me, player, read, modeOf(ctx));
}

/** Keys in sorted order, so one settings shape always hashes alike. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (rec(v)) return Object.fromEntries(Object.keys(v as Rec).sort().map((k) => [k, stable((v as Rec)[k])]));
  return v;
}

/** `sha256:<16 hex>` of a game's name-free settings shape (`nameFreeSettings`); `null` without settings. */
export function settingsKey(game: Pick<Game, 'settings' | 'players' | 'name'>): string | null {
  const s = nameFreeSettings(game);
  return s ? `sha256:${createHash('sha256').update(JSON.stringify(stable(s))).digest('hex').slice(0, 16)}` : null;
}

/**
 * The join context (#437): the lobby's settings key and readable flags (the open-games record's format,
 * seats, pace and boot time; GameFeed's Local Deployment, Commanders, kill rates, luck, fog and cards when it
 * read the lobby) and the joining policy's checks by code. Name-free. Pure but for the clock.
 */
export function joinContextLog(listed: OpenGame, feed: Pick<Game, 'settings' | 'players' | 'name'> | undefined, screen: JoinScreen | null | undefined, now: number = Date.now()): JoinContext {
  const s = feed?.settings;
  const policy = policyChecks(listed, screen);
  const seats = listed.maxPlayers ?? listed.seats;
  return {
    at: new Date(now).toISOString(),
    settingsKey: feed ? settingsKey(feed) : null,
    flags: {
      format: listed.teamGame ? 'team' : seats <= 2 ? '1v1' : 'ffa',
      seats,
      ...(listed.pace ? { pace: String(listed.pace) } : {}),
      ...(listed.bootTimeMinutes !== undefined ? { bootMinutes: listed.bootTimeMinutes } : {}),
      ...(s
        ? {
            ...(s.localDeployments !== undefined ? { localDeployments: s.localDeployments } : {}),
            ...(s.commanders !== undefined ? { commanders: s.commanders } : {}),
            killRates: { offence: s.offensiveKillRate ?? null, defence: s.defensiveKillRate ?? null },
            ...(s.luckModifier !== undefined ? { luck: s.luckModifier } : {}),
            ...(s.fog !== undefined ? { fog: s.fog } : {}),
            cards: [...s.cards].sort(),
          }
        : {}),
    },
    policy: { passes: policy.passes, broke: policy.broke as PolicyCheck[], passed: policy.passed, unchecked: policy.unchecked },
    ...(listed.lottery !== undefined ? { lottery: listed.lottery } : {}),
  };
}

/**
 * My surrender's detail (#437) from the outlook log's latest turn: my income and the strongest opponent's
 * in its evidence, its state and turn (all `null` when nothing was logged).
 */
export function mySurrenderDetail(status: MySurrenderDetail['status'], log: Pick<OutlookLog, 'latest'> | undefined): MySurrenderDetail {
  const l = log?.latest;
  const ev = l?.evidence;
  const top = [...(ev?.opponents ?? [])].sort((a, b) => b.income - a.income || a.playerId - b.playerId)[0];
  return {
    status,
    income: ev?.incomes?.mine ?? null,
    strongest: top ? { player: top.playerId, income: top.income, source: top.source, thin: top.thin } : null,
    outlook: l?.state ?? null,
    // #454: the income lean beside an even state (additive).
    ...(l?.lean ? { outlookLean: l.lean } : {}),
    outlookTurn: l?.turn ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// #437 task 3: the picks phase

/** Picks whose score the advice log keeps, from the top of the list. */
export const LOGGED_PICK_SCORES = 10;

/** The pick advisor's warnings (and its tool's) by the start of their wording; anything else is `other`. */
const PICK_WARNING_CODES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Ignored pickable ids not on the map/, 'unknown-pickable'],
  [/^Starting armies per picked territory missing/, 'assumed-pick-armies'],
  [/^Base income missing/, 'assumed-base-income'],
  [/^Kill rates missing/, 'assumed-kill-rates'],
  [/^Neutral size of unpicked pickable territories missing/, 'assumed-neutrals-in'],
  [/^Neutral size of territories outside the distribution missing/, 'assumed-neutrals-out'],
  [/^Luck is /, 'luck'],
  [/^Capture costs assume straight rounding/, 'rounding'],
  [/^Local deployments are on/, 'local-deployments'],
  [/^No compact /, 'not-compact'],
  [/^In a 1v1 the best /, 'spread-relaxed'],
  [/^Only \d+ pickable territor/, 'short-pickable'],
  [/^The fallback group scores more than the primary/, 'fallback-outscores'],
  [/^Territory limit missing/, 'assumed-territory-limit'],
  [/^Full distribution \(DistributionMode 0/, 'full-distribution'],
  [/^Could not tell which seat is yours/, 'team-seat-unknown'],
];

/** A pick warning's code (never its prose, which may carry ids and figures). */
export function pickWarningCode(w: string): string {
  return PICK_WARNING_CODES.find(([re]) => re.test(w))?.[1] ?? 'other';
}

/**
 * The pick advisor's plan as the decision log keeps it (#437 task 3): ids, the top scores, the warnings by
 * code (the tool's own first, each once), the award orders judged with the worst outcome, coverage and any
 * alternative. No reason, rationale or name. Pure but for the clock.
 */
export function picksAdviceLog(
  plan: Pick<PickPlan, 'picks' | 'groups' | 'award' | 'coverage' | 'alternative' | 'warnings'>,
  a: {
    players: number;
    territoryLimit: number;
    maxPicks: number;
    spread: boolean;
    /** The tool's own warnings, before the plan's. */
    warnings: readonly string[];
    team?: PicksAdvice['team'];
    now?: number;
  },
): PicksAdvice {
  const cov = (c: { share: number; covered: number; reasonable: number }) => ({ share: c.share, covered: c.covered, reasonable: c.reasonable });
  const alt = plan.alternative;
  return {
    at: new Date(a.now ?? Date.now()).toISOString(),
    players: a.players,
    territoryLimit: a.territoryLimit,
    maxPicks: a.maxPicks,
    spread: a.spread,
    list: plan.picks.map((p) => p.territoryId),
    primary: [...plan.groups.primary.territoryIds],
    fallback: [...plan.groups.fallback.territoryIds],
    scores: plan.picks.slice(0, LOGGED_PICK_SCORES).map((p) => ({ territory: p.territoryId, score: p.score })),
    groupScores: { primary: plan.groups.primary.score, fallback: plan.groups.fallback.score },
    warnings: [...new Set([...a.warnings, ...plan.warnings].map(pickWarningCode))],
    award: plan.award
      ? {
          outcomes: plan.award.outcomes,
          // A free-for-all or 1v1 is judged by the reversing order alone (planPicks names the orders only in a team game).
          orders: plan.award.orders ? [...plan.award.orders] : ['reversing'],
          worst: { territories: [...plan.award.worst.territoryIds], score: plan.award.worst.score, opponentStarts: [...plan.award.worst.opponentStarts] },
          reordered: plan.award.reordered,
        }
      : null,
    coverage: cov(plan.coverage),
    ...(alt ? { alternative: { territories: [...alt.group.territoryIds], fallback: [...alt.fallback], score: alt.group.score, coverage: cov(alt.coverage) } } : {}),
    ...(a.team ? { team: a.team } : {}),
  };
}

/**
 * Keep warapp_plan_picks' summary (a re-plan replaces it), starting a log, as the account the game's log
 * belongs to when it is seated, else the signed-in account when seated (`myInviteToken`: cached for a while,
 * so usually no request; the advisor is read-only and plans for that seat). Nothing when neither is seated,
 * the log is off or there is no data dir. Never throws.
 */
export async function capturePicksAdvice(
  ctx: Ctx & Partial<Pick<LiveContext, 'myInviteToken'>>,
  game: Pick<Game, 'id' | 'players'>,
  advice: PicksAdvice,
): Promise<void> {
  try {
    if (!ctx.dataDir || offMode(ctx)) return;
    const seated = (id: number | undefined) => (id !== undefined && game.players.some((p) => p.id === id) ? id : undefined);
    const owner = await decisionLogOwner(decisionLogPath(ctx.dataDir, game.id), game.id);
    const me = owner !== undefined ? seated(owner) : seated(await ctx.myInviteToken?.());
    if (me === undefined) return;
    await recordPicksAdvice(ctx.dataDir, game.id, me, advice, modeOf(ctx));
  } catch {
    // Best effort.
  }
}

/** Keep the list warapp_submit_picks sent and read back (the latest send wins), starting a log. Never throws. */
export async function capturePicksSent(ctx: Ctx, gameId: number, me: number, sent: Omit<PicksSent, 'at'>): Promise<void> {
  if (!ctx.dataDir) return;
  await recordPicksSent(ctx.dataDir, gameId, me, sent, modeOf(ctx));
}

/**
 * Keep the award `loadAward` read on turn 1 (`null`: nothing could be read), once, starting a log. Takes the
 * data dir and mode rather than a context (loadAward has no context). Never throws.
 */
export async function capturePicksAward(
  dataDir: string | undefined,
  mode: DecisionLogMode | undefined,
  gameId: number,
  me: number,
  turn: number,
  reading: AwardReading | null,
): Promise<void> {
  if (!dataDir) return;
  await recordPicksAward(dataDir, gameId, me, { turn, reading: reading ? { ...reading } : null }, mode ? { mode } : {});
}
