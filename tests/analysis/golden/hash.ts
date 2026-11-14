// The hash of a plan, for the golden corpus (#133). No runtime import from src/, so the capture setup can load
// it inside its planner mock.
import { createHash } from 'node:crypto';
import type { PlanInput, TurnPlan } from '../../../src/analysis/planner.js';

/** Hash length kept per plan (hex chars of the sha256). */
const HASH_HEX = 16;

/** The hash of what planTurn returns for `input` (or of what it throws). */
export function planHash(plan: (input: PlanInput) => TurnPlan, input: PlanInput): string {
  let text: string;
  try {
    text = JSON.stringify(plan(input), (_k, v: unknown) =>
      v instanceof Map ? { $m: [...v] } : v instanceof Set ? { $s: [...v] } : v,
    );
  } catch (e) {
    text = `THROW:${e instanceof Error ? e.message : String(e)}`;
  }
  return createHash('sha256').update(text).digest('hex').slice(0, HASH_HEX);
}

