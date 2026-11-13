import { describe, expect, it, vi } from 'vitest';

// Every acorn parse the dialect check starts is recorded: the text it was handed past the start
// position (`room`) and the text it read before it finished or failed (`read`) are host work the step
// budget cannot see while acorn runs.
const parses = vi.hoisted(() => [] as { pos: number; room: number; read: number; brace: boolean }[]);
vi.mock('acorn', async (importOriginal) => {
  const acorn = await importOriginal<typeof import('acorn')>();
  return {
    ...acorn,
    parseExpressionAt: (input: string, pos: number, opts: Parameters<typeof acorn.parseExpressionAt>[2]) => {
      const entry = { pos, room: input.length - pos, read: input.length - pos, brace: input[pos] === '{' };
      parses.push(entry);
      try {
        const node = acorn.parseExpressionAt(input, pos, opts);
        entry.read = node.end - pos;
        return node;
      } catch (e) {
        const at = (e as { raisedAt?: unknown }).raisedAt;
        if (typeof at === 'number') entry.read = at - pos;
        throw e;
      }
    },
  };
});

const { BundleInterpreter, MAX_LITERAL_SITES, parseBundle } = await import('../../src/protocol/interp.js');

const HELPERS = 'var W={};var P={};P.Ya=function(a){return a.Og()};P.uq=function(a){return a.bc()};';

describe('the object-literal scan of the dialect check is bounded (#148, the #152 bounds)', () => {
  const MAX = 50_000;
  const literalParses = () => parses.filter((p) => p.brace);
  /** No parse was handed more than one read's worth of text, and all of them together read no more. */
  const bounded = () => {
    expect(literalParses().every((p) => p.room <= MAX)).toBe(true);
    expect(literalParses().reduce((n, p) => n + p.read, 0)).toBeLessThanOrEqual(MAX);
  };

  it('many unparseable literal sites: few parses, their text bounded by one read, and the helpers unverified', () => {
    // Each site, parsed against the whole source, runs into the next one and fails at the end:
    // before the bound this took about a minute on a 1 MB source.
    parses.length = 0;
    const src = HELPERS + 'P={a:['.repeat(500) + '1,'.repeat(500_000);
    const check = new BundleInterpreter(parseBundle(src), { maxSteps: MAX }).verifyDialect();
    const lits = literalParses();
    expect(lits.length).toBeGreaterThan(0);
    expect(lits.length).toBeLessThanOrEqual(MAX_LITERAL_SITES);
    bounded();
    // The scan stopped short, so a literal past it could define any helper: none is verified.
    expect(check.verified).toEqual([]);
    expect(check.unverified).toEqual(expect.arrayContaining(['P.Ya', 'P.uq']));
    expect(check.reasons?.['P.Ya']).toMatch(/object literal/);
    expect(check.mismatched).toEqual([]);
  });

  it('many small literal sites stop at the site cap, failing closed', () => {
    parses.length = 0;
    const src = HELPERS + 'P={x:1};'.repeat(MAX_LITERAL_SITES * 4);
    const check = new BundleInterpreter(parseBundle(src), { maxSteps: MAX }).verifyDialect();
    expect(literalParses().length).toBe(MAX_LITERAL_SITES);
    expect(check.verified).toEqual([]);
    expect(check.unverified).toEqual(expect.arrayContaining(['P.Ya', 'P.uq']));
  });

  it('deeply nested literals are bounded the same way', () => {
    parses.length = 0;
    const src = HELPERS + 'P={a:'.repeat(8000);
    const check = new BundleInterpreter(parseBundle(src), { maxSteps: MAX }).verifyDialect();
    expect(literalParses().length).toBeLessThanOrEqual(MAX_LITERAL_SITES);
    bounded();
    expect(check.verified).toEqual([]);
  });

  it('a few ordinary literals are read in full and do not disturb the check', () => {
    parses.length = 0;
    const src = HELPERS + 'P={x:1};P={y:[1,2,3]};';
    const check = new BundleInterpreter(parseBundle(src), { maxSteps: MAX }).verifyDialect();
    expect(literalParses().length).toBe(3); // var P={} too
    expect(check.verified).toEqual(['P.Ya', 'P.uq']);
  });
});
