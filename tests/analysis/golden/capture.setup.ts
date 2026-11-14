// Capture every planTurn input the test suite makes (the golden corpus, #133). Not part of the normal
// run: `capture.config.ts` adds it as a setup file. It wraps planTurn so each call appends its input and
// its plan's hash to one NDJSON file per worker under
// GOLDEN_CAPTURE_DIR; `GOLDEN_UPDATE=1` (planner-golden.test.ts) folds them into the committed corpus.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import type * as Planner from '../../../src/analysis/planner.js';
import { encode } from './codec.js';
import { planHash } from './hash.js';

vi.mock('../../../src/analysis/planner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Planner>();
  const dir = process.env.GOLDEN_CAPTURE_DIR;
  if (!dir) throw new Error('GOLDEN_CAPTURE_DIR is not set');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `inputs-${process.pid}-${process.env.VITEST_POOL_ID ?? '0'}.ndjson`);
  return {
    ...actual,
    planTurn(input: Planner.PlanInput): Planner.TurnPlan {
      // Encoded before the call (planTurn could mutate it); the plan's hash lets the corpus build
      // check that the decoded input plans the same turn as the original did.
      const i = encode(input);
      let plan: Planner.TurnPlan | undefined;
      let thrown: unknown;
      try {
        plan = actual.planTurn(input);
      } catch (e) {
        thrown = e;
      }
      const o = planHash(() => {
        if (thrown !== undefined) throw thrown;
        return plan!;
      }, input);
      appendFileSync(file, JSON.stringify({ i, o }) + '\n');
      if (thrown !== undefined) throw thrown;
      return plan!;
    },
  };
});
