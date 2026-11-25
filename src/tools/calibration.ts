// warapp_calibration (#569, for #568): the income estimates this server planned with, scored against the
// truth its finished games kept — read-only, from this server's state alone (no war.app request), so an agent
// can run the calibration on a hosted server whose data directory no local script can reach. The pure part is
// src/analysis/income-calibration.ts; `harness: true` adds the #318 harness (src/tools/calibration-harness.ts).
// Name-free: games are numbered by their place in the report, never by id; no player is named or numbered.
import { toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { incomeCalibration, incomeSamples, type CalibrationGame } from '../analysis/income-calibration.js';
import { profileFormatOf } from '../analysis/opponent-profile.js';
import { listDecisionLogs, readDecisionLog, type DecisionLog } from '../decision-log.js';
import { holdsSeat } from '../player-states.js';
import { readGameRecord } from '../replay.js';
import { calibrationHarness, HARNESS_APPROXIMATIONS } from './calibration-harness.js';
import { respond } from './common.js';
import { mintMeta } from './hints.js';
import { refuse } from './write-kit.js';

/** Scored rows returned at most with `samples: true`. */
export const MAX_SAMPLES = 2000;

export const CALIBRATION_NOTE =
  'Each sample is one income estimate a planned turn worked from, against that opponent\'s true income (base plus ' +
  'full bonuses, cards and the army cap aside) on the board the turn was played on, read from the finished game\'s ' +
  'history. ratio = estimate ÷ truth; meanError = estimate − truth in armies. Reported only: nothing plans on it. ' +
  'Only games whose decision log was given the end-of-game truth count (games played on builds with the decision log, ' +
  'finished, their history read); `method` (the tracker\'s, incl. rise-capped) is logged only since #569. The ' +
  'consequences block is a proxy: a lost territory has many causes.';

/** Every finished decision log in `dir` as the scoring reads it, in game-id order; lotteries counted apart. Never throws. */
export async function calibrationGames(dir: string): Promise<{ games: CalibrationGame[]; logs: number; lotteries: number; withoutTruth: number }> {
  const listed = (await listDecisionLogs(dir)).filter((l) => l.status !== 'active');
  const games: CalibrationGame[] = [];
  let lotteries = 0;
  let withoutTruth = 0;
  for (const l of listed) {
    const log = await readDecisionLog(dir, l.gameId, l.playerId);
    if (!log) continue;
    if (log.join?.lottery !== undefined) {
      lotteries++;
      continue;
    }
    if (!Object.values(log.turns).some((e) => e.accuracy?.estimates.length)) {
      withoutTruth++;
      continue;
    }
    games.push({ ...(await formatOf(dir, log)), turns: log.turns });
  }
  return { games, logs: listed.length, lotteries, withoutTruth };
}

async function formatOf(dir: string, log: DecisionLog): Promise<{ format: string; seats: number | null }> {
  const game = await readGameRecord(dir, log.gameId);
  if (game?.players.length) {
    const seated = game.players.filter((p) => holdsSeat(p.state));
    return { format: profileFormatOf(seated), seats: seated.length };
  }
  if (log.join) return { format: log.join.flags.format, seats: log.join.flags.seats };
  const seats = log.seats ? Object.keys(log.seats).length : null;
  return { format: seats === 2 ? '1v1' : 'unknown', seats };
}

export function registerCalibrationTool(server: McpServer, dataDir: () => string | undefined): void {
  server.registerTool(
    'warapp_calibration',
    {
      title: 'Score the income estimates against finished games',
      _meta: mintMeta('lookup', ['how accurate are the income estimates', 'calibrate opponent income', 'estimate accuracy']),
      description:
        'Score the opponent income estimates this server planned with against the truth its finished games kept ' +
        '(the decision log\'s end-of-game truth): each estimate ÷ the true income, and its signed error in armies, ' +
        'overall and by format, seats, phase (turns 1–4, 5–10, 11+), frontier coverage band, estimate source, thin ' +
        'evidence, the tracker\'s income method (rise-capped or not; logged since #569), leader vs trailer, and phase ' +
        'by coverage; the catch-up lag after a true income jump of 1.5× or more (turns until the estimate reaches two ' +
        'thirds of the truth); a consequences proxy (turns that lost a territory the plan did not concede, with an ' +
        'estimate under half the truth vs without); and the largest misses. `samples: true` adds the scored rows ' +
        `(at most ${MAX_SAMPLES}), name-free, as a fixture set; \`harness: true\` also runs the #318 harness over the ` +
        'cached boards (tracker, fog prior and plan estimate by coverage band, and the opening benchmark), which can ' +
        'take a while on many games. Games are numbered by their place in the report, never by id, and no player is ' +
        'named. Makes no war.app request and writes nothing. Read-only.',
      annotations: toolAnnotations({ title: 'Income estimate calibration', readOnly: true, destructive: false, idempotent: true, openWorld: false }),
      inputSchema: z.object({
        samples: z.boolean().optional().describe(`Also return the scored rows, name-free (default false; at most ${MAX_SAMPLES}).`),
        harness: z.boolean().optional().describe('Also run the #318 harness over the cached boards and the opening benchmark (default false).'),
        format: z.enum(['1v1', 'ffa', 'team']).optional().describe('Only games of this format.'),
      }),
    },
    async ({ samples, harness, format }) => {
      const dir = dataDir();
      if (!dir) refuse('This server has no data directory, so there is nothing to score.', 'Nothing to do here.');
      const src = await calibrationGames(dir!);
      const games = format ? src.games.filter((g) => g.format === format) : src.games;
      const report = incomeCalibration(games);
      const rows = samples ? incomeSamples(games) : [];
      const extra = harness ? await calibrationHarness(dir!) : undefined;
      return respond(undefined, ['compact'], () => ({
        readAs: CALIBRATION_NOTE,
        sources: {
          finishedLogs: src.logs,
          scoredGames: report.games,
          lotteriesLeftOut: src.lotteries,
          withoutTruth: src.withoutTruth,
          ...(format ? { format, otherFormats: src.games.length - games.length } : {}),
        },
        ...(report.samples
          ? { report }
          : {
              report: null,
              empty:
                'No finished game with the end-of-game truth in its decision log yet: the truth is written when a finished ' +
                "game's history is read (warapp_backfill_history, warapp_my_games' sweep, warapp_get_game on it).",
            }),
        ...(samples ? { samples: rows.slice(0, MAX_SAMPLES), ...(rows.length > MAX_SAMPLES ? { samplesLeftOut: rows.length - MAX_SAMPLES } : {}) } : {}),
        ...(extra ? { harness: { ...extra, approximations: HARNESS_APPROXIMATIONS } } : {}),
      }));
    },
  );
}
