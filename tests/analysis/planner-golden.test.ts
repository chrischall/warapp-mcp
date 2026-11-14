// The golden test (#133): planTurn's plan for every input of the golden corpus — seeded synthetic
// boards plus the inputs the rest of the suite makes — hashes to what it did before the split of
// planTurn into phases. A refactor that changes any plan, anywhere, by a byte, fails here.
//
// Default run: every suite input and every DEFAULT_STRIDE-th synthetic board. GOLDEN_FULL=1: all of
// them. Regenerating (only ever against an UNCHANGED planner):
//   GOLDEN_CAPTURE_DIR=<dir> npx vitest run --config tests/analysis/golden/capture.config.ts
//   GOLDEN_CAPTURE_DIR=<dir> GOLDEN_UPDATE=1 npx vitest run tests/analysis/planner-golden.test.ts
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { planTurn, type PlanInput } from '../../src/analysis/planner.js';
import { decode, type Json } from './golden/codec.js';
import {
  DEFAULT_STRIDE,
  HASHES,
  SUITE_INPUTS,
  SYNTHETIC_COUNT,
  suiteInputs,
  syntheticInput,
  type SuiteCapture,
} from './golden/corpus.js';
import { planHash } from './golden/hash.js';

interface Hashes {
  synthetic: string[];
  suite: string[];
}

const FULL = process.env.GOLDEN_FULL === '1';
const UPDATE = process.env.GOLDEN_UPDATE === '1';

/** Fold the capture run's NDJSON into the committed capture: inputs de-duplicated, graphs shared. */
function foldCapture(dir: string): void {
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const graphs: Record<string, Json> = {};
  const inputs: Json[] = [];
  const seen = new Set<string>();
  const lines = readdirSync(dir)
    .filter((f) => f.endsWith('.ndjson'))
    .sort()
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean));
  let mismatched = 0;
  for (const line of lines) {
    const { i, o } = JSON.parse(line) as { i: Record<string, Json>; o: string };
    const graph = JSON.stringify(i.graph);
    const key = sha(graph).slice(0, 16);
    graphs[key] ??= i.graph!;
    const entry = { ...i, graph: key };
    const id = sha(JSON.stringify(entry));
    if (seen.has(id)) continue;
    seen.add(id);
    // The decoded input must plan exactly what the original did.
    if (planHash(planTurn, { ...(decode(i) as object) } as PlanInput) !== o) mismatched++;
    inputs.push(entry);
  }
  expect(mismatched).toBe(0);
  // Sorted, so the file does not depend on which worker ran which test file first.
  inputs.sort((a, b) => {
    const x = JSON.stringify(a);
    const y = JSON.stringify(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const capture: SuiteCapture = { graphs, inputs };
  writeFileSync(SUITE_INPUTS, gzipSync(JSON.stringify(capture), { level: 9 }));
}

describe.runIf(UPDATE)('golden corpus: regenerate', () => {
  it('captures the suite and hashes every plan', () => {
    const dir = process.env.GOLDEN_CAPTURE_DIR;
    if (dir) foldCapture(dir);
    const hashes: Hashes = {
      synthetic: Array.from({ length: SYNTHETIC_COUNT }, (_, i) => planHash(planTurn, syntheticInput(i))),
      suite: suiteInputs().map((input) => planHash(planTurn, input)),
    };
    writeFileSync(HASHES, JSON.stringify(hashes, null, 0) + '\n');
  }, 600_000);
});

describe.skipIf(UPDATE)('golden corpus (#133): every plan is byte-identical', () => {
  let want: Hashes;
  beforeAll(() => {
    want = JSON.parse(readFileSync(HASHES, 'utf8')) as Hashes;
  });

  it('covers the corpus it claims to', () => {
    expect(want.synthetic).toHaveLength(SYNTHETIC_COUNT);
    expect(want.suite.length).toBeGreaterThan(1000);
  });

  it(`synthetic boards (${FULL ? 'all' : `every ${DEFAULT_STRIDE}th`})`, () => {
    const changed: number[] = [];
    for (let i = 0; i < SYNTHETIC_COUNT; i += FULL ? 1 : DEFAULT_STRIDE)
      if (planHash(planTurn, syntheticInput(i)) !== want.synthetic[i]) changed.push(i);
    expect(changed, `changed synthetic plans: ${changed.join(', ')}`).toEqual([]);
  }, 600_000);

  it('the inputs the test suite makes', () => {
    const inputs = suiteInputs();
    expect(inputs).toHaveLength(want.suite.length);
    const changed = inputs.flatMap((input, i) => (planHash(planTurn, input) !== want.suite[i] ? [i] : []));
    expect(changed, `changed suite plans: ${changed.join(', ')}`).toEqual([]);
  }, 600_000);
});
