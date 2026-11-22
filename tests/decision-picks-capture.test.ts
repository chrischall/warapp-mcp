// #437 task 3: the pure shapers that turn the pick advisor's plan and the award reading into the decision
// log's name-free picks block. Synthetic ids only.
import { describe, expect, it } from 'vitest';
import type { PickPlan } from '../src/analysis/picks.js';
import { LOGGED_PICK_SCORES, pickWarningCode, picksAdviceLog } from '../src/tools/decision-capture.js';

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
const group = (ids: number[], score: number) => ({ territoryIds: ids, score, maxHops: 1, bonuses: [], twoOrderCaptures: [] });
const cov = { share: 0.5, covered: 2, reasonable: 4, uncovered: [{ bonusId: 7, name: 'Synthetic Bonus' }] };

function plan(over: Partial<PickPlan> = {}): PickPlan {
  const ids = Array.from({ length: 14 }, (_, i) => 100 + i);
  return {
    picks: ids.map((t, i) => ({ territoryId: t, group: i < 3 ? 'primary' : 'fallback', score: 50 - i, reasons: ['prose that is never logged'] })),
    groups: { primary: group(ids.slice(0, 3), 30), fallback: group(ids.slice(3), 12) },
    award: { outcomes: 4, worst: { territoryIds: [100, 103, 104], score: 20, opponentStarts: [101, 102] }, reordered: true },
    side: { known: false, opponentStarts: [], note: 'none' } as unknown as PickPlan['side'],
    coverage: cov,
    warnings: [
      'Luck is 16%: capture costs carry a margin and can still fail.',
      'Kill rates missing from settings; assumed 60/70 (offence/defence).',
      'Luck is 16%: capture costs carry a margin and can still fail.',
      'Something new the advisor says.',
    ],
    rationale: ['never logged'],
    ...over,
  };
}

describe('pickWarningCode', () => {
  it('names every warning the advisor and its tool give by a code, anything else as other', () => {
    const cases: [string, string][] = [
      ['Ignored pickable ids not on the map: 4, 5.', 'unknown-pickable'],
      ['Starting armies per picked territory missing from settings; assumed 5.', 'assumed-pick-armies'],
      ['Base income missing from settings; assumed 5.', 'assumed-base-income'],
      ['Kill rates missing from settings; assumed 60/70 (offence/defence).', 'assumed-kill-rates'],
      ['Neutral size of unpicked pickable territories missing from settings; assumed 4.', 'assumed-neutrals-in'],
      ['Neutral size of territories outside the distribution missing from settings (and not on the board); assumed 2.', 'assumed-neutrals-out'],
      ['Luck is 16%: capture costs carry a margin and can still fail.', 'luck'],
      ['Capture costs assume straight rounding; this game uses WeightedRandom.', 'rounding'],
      ['Local deployments are on: bonus income must be deployed inside its bonus, and the opening simulation deploys it only there.', 'local-deployments'],
      ['No compact primary group of 3 picks (each within 2 hops of another) exists among the pickable territories; relaxed to within 3 hops.', 'not-compact'],
      ['In a 1v1 the best primary group within 4 hops scores 3, but one spread to any distance scores 9 (at least 1.5× as much): …', 'spread-relaxed'],
      ['Only 2 pickable territories for a limit of 3: the list has no full fallback.', 'short-pickable'],
      ['The fallback group scores more than the primary (12 vs 10; …). Weigh the trade before submitting.', 'fallback-outscores'],
      ['Primary pick 2 is T3, not T9: in the 1 award outcomes … (#429). The primary’s joint score is 17; weigh it before submitting.', 'primary-answered'],
      ['Territory limit missing from settings; assumed 4.', 'assumed-territory-limit'],
      ['Full distribution (DistributionMode 0, no territory limit): every territory is dealt, so each of the 2 players gets about 5 of the 10 pickable; the list only says which you would rather hold.', 'full-distribution'],
      ['Could not tell which seat is yours in this team game: every other player is treated as an opponent.', 'team-seat-unknown'],
      ['Anything else at all', 'other'],
    ];
    for (const [w, code] of cases) expect(pickWarningCode(w), w).toBe(code);
  });
});

describe('picksAdviceLog', () => {
  it('keeps ids, the top scores, warning codes once each and the award judged; never prose or names', () => {
    const log = picksAdviceLog(plan(), { players: 2, territoryLimit: 3, maxPicks: 14, spread: false, warnings: ['Territory limit missing from settings; assumed 4.'], now: T0 });
    expect(log).toEqual({
      at: new Date(T0).toISOString(),
      players: 2,
      territoryLimit: 3,
      maxPicks: 14,
      spread: false,
      list: Array.from({ length: 14 }, (_, i) => 100 + i),
      primary: [100, 101, 102],
      fallback: Array.from({ length: 11 }, (_, i) => 103 + i),
      scores: Array.from({ length: LOGGED_PICK_SCORES }, (_, i) => ({ territory: 100 + i, score: 50 - i })),
      groupScores: { primary: 30, fallback: 12 },
      warnings: ['assumed-territory-limit', 'luck', 'assumed-kill-rates', 'other'],
      award: { outcomes: 4, orders: ['reversing'], worst: { territories: [100, 103, 104], score: 20, opponentStarts: [101, 102] }, reordered: true },
      coverage: { share: 0.5, covered: 2, reasonable: 4 },
    });
    expect(JSON.stringify(log)).not.toMatch(/Synthetic Bonus|prose|never logged/);
  });

  it('keeps both award orders of a team game, the alternative and the team block', () => {
    const p = plan({
      award: { outcomes: 2, orders: ['reversing', 'repeating'], worst: { territoryIds: [100], score: 1, opponentStarts: [] }, reordered: false },
      alternative: { group: group([105, 106, 107], 25), coverage: { ...cov, share: 0.75, covered: 3 }, fallback: [108], submitPicks: [105, 106, 107, 108] },
    });
    const log = picksAdviceLog(p, { players: 4, territoryLimit: 3, maxPicks: 14, spread: false, warnings: [], team: { teammates: [55], listsRead: 1, mirrored: true } });
    expect(log.award!.orders).toEqual(['reversing', 'repeating']);
    expect(log.alternative).toEqual({ territories: [105, 106, 107], fallback: [108], score: 25, coverage: { share: 0.75, covered: 3, reasonable: 4 } });
    expect(log.team).toEqual({ teammates: [55], listsRead: 1, mirrored: true });
  });

  it('logs the award as null when the plan could not judge it', () => {
    const { award, ...rest } = plan();
    void award;
    expect(picksAdviceLog(rest, { players: 2, territoryLimit: 3, maxPicks: 14, spread: true, warnings: [] }).award).toBeNull();
  });
});
