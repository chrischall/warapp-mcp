// Who moved first, kept between turns (#127): under a cyclic move order the first mover of a
// two-player game alternates every turn, so one known turn gives every other. Ids are made up;
// files live in a temp dir.
import { existsSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FIRST_MOVER_MAX_AGE_MS,
  inferFirstMover,
  firstMoverPath,
  projectFirstMover,
  readFirstMover,
  resolveFirstMover,
  verifiedFirstMover,
  writeFirstMover,
} from '../src/move-order.js';
import { firstMoverFor } from '../src/tools/award.js';

const dir = () => mkdtempSync(join(tmpdir(), 'warapp-mcp-move-order-'));
const GAME = 4101;
const ME = 5500000011;

describe('projectFirstMover', () => {
  it('alternates by turn, both ways', () => {
    const seen = { turn: 3, firstMover: 'me' as const };
    expect(projectFirstMover(seen, 3)).toBe('me');
    expect(projectFirstMover(seen, 4)).toBe('opponent');
    expect(projectFirstMover(seen, 5)).toBe('me');
    expect(projectFirstMover(seen, 2)).toBe('opponent');
    expect(projectFirstMover({ turn: 2, firstMover: 'opponent' }, 7)).toBe('me');
  });
});

describe('resolveFirstMover', () => {
  const base = { turn: 5, cyclicDuel: true, award: null } as const;

  it('knows nothing with nothing to go on', () => {
    expect(resolveFirstMover(base)).toEqual({ resolved: null, warnings: [] });
  });

  it('takes an explicit first mover and remembers it', () => {
    expect(resolveFirstMover({ ...base, explicit: 'opponent' })).toEqual({
      resolved: { firstMover: 'opponent', source: 'explicit' },
      record: { turn: 5, firstMover: 'opponent', source: 'explicit' },
      warnings: [],
    });
  });

  it('takes the award on the turn and remembers it', () => {
    expect(resolveFirstMover({ ...base, award: 'me' })).toEqual({
      resolved: { firstMover: 'me', source: 'award' },
      record: { turn: 5, firstMover: 'me', source: 'award' },
      warnings: [],
    });
  });

  it('alternates a remembered turn when nothing else says', () => {
    const r = resolveFirstMover({ ...base, remembered: { turn: 2, firstMover: 'me', source: 'explicit' } });
    expect(r.resolved).toEqual({ firstMover: 'opponent', source: 'remembered', from: { turn: 2, source: 'explicit' } });
    // Nothing new is known: nothing to write.
    expect(r.record).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });

  it('prefers a remembered explicit turn over the award, and says they disagree', () => {
    const r = resolveFirstMover({ ...base, award: 'me', remembered: { turn: 4, firstMover: 'me', source: 'explicit' } });
    expect(r.resolved).toEqual({ firstMover: 'opponent', source: 'remembered', from: { turn: 4, source: 'explicit' } });
    expect(r.record).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/award of picks says you move first on turn 5/);
  });

  it('prefers the award over a remembered award turn (they agree when the reading is the same)', () => {
    const r = resolveFirstMover({ ...base, award: 'me', remembered: { turn: 3, firstMover: 'me', source: 'award' } });
    expect(r.resolved).toEqual({ firstMover: 'me', source: 'award' });
    expect(r.record).toEqual({ turn: 5, firstMover: 'me', source: 'award' });
    expect(r.warnings).toEqual([]);
  });

  it('an explicit first mover beats everything, and a disagreement is a warning', () => {
    const r = resolveFirstMover({ ...base, explicit: 'me', award: 'opponent', remembered: { turn: 4, firstMover: 'me', source: 'explicit' } });
    expect(r.resolved).toEqual({ firstMover: 'me', source: 'explicit' });
    expect(r.record).toEqual({ turn: 5, firstMover: 'me', source: 'explicit' });
    const w = r.warnings.join(' ');
    expect(w).toMatch(/the award of picks says the opponent moves first on turn 5/);
    expect(w).toMatch(/first_mover given on turn 4 says the opponent moves first on turn 5/);
    expect(w).toMatch(/Order Priority/);
  });

  it('outside a two-player cyclic order uses an explicit first mover for this turn only', () => {
    const r = resolveFirstMover({ ...base, cyclicDuel: false, explicit: 'me', remembered: { turn: 4, firstMover: 'me', source: 'explicit' } });
    expect(r).toEqual({ resolved: { firstMover: 'me', source: 'explicit' }, warnings: [] });
    expect(resolveFirstMover({ ...base, cyclicDuel: false, remembered: { turn: 4, firstMover: 'me', source: 'explicit' } }).resolved).toBeNull();
  });

  it('without a turn uses an explicit first mover only', () => {
    expect(resolveFirstMover({ ...base, turn: null, explicit: 'opponent' })).toEqual({
      resolved: { firstMover: 'opponent', source: 'explicit' },
      warnings: [],
    });
    expect(resolveFirstMover({ ...base, turn: null, award: 'me' }).resolved).toBeNull();
  });
});

describe('verifiedFirstMover (#215 review)', () => {
  it('counts only a first mover given explicitly, now or on a remembered turn', () => {
    expect(verifiedFirstMover({ firstMover: 'me', source: 'explicit' })).toBe(true);
    expect(verifiedFirstMover({ firstMover: 'me', source: 'remembered', from: { turn: 3, source: 'explicit' } })).toBe(true);
    // The award's move order is the wiki's rule, not verified live.
    expect(verifiedFirstMover({ firstMover: 'me', source: 'award' })).toBe(false);
    expect(verifiedFirstMover({ firstMover: 'me', source: 'remembered', from: { turn: 3, source: 'award' } })).toBe(false);
    expect(verifiedFirstMover({ firstMover: 'me', source: 'remembered' })).toBe(false);
  });
});

describe('firstMoverFor marks what holds may trust (#215 review)', () => {
  const game = { id: GAME, players: [{ id: ME }, { id: 7700000022 }], settings: { moveOrder: 'Cycle' } } as never;
  const me = { id: ME } as never;
  it('a first mover from the award is not verified; one the user gave is', async () => {
    const award = await firstMoverFor(undefined, game, me, 4, undefined, { firstMover: 'me' } as never);
    expect(award).toMatchObject({ firstMover: 'me', verified: false });
    const told = await firstMoverFor(undefined, game, me, 4, 'me', { firstMover: 'opponent' } as never);
    expect(told).toMatchObject({ firstMover: 'me', verified: true });
  });
});

describe('the stored first mover', () => {
  it('round-trips, private to the user', async () => {
    const d = dir();
    expect(await readFirstMover(d, GAME, ME)).toBeUndefined();
    expect(await writeFirstMover(d, GAME, ME, { turn: 3, firstMover: 'me', source: 'explicit' })).toBe(true);
    expect(await readFirstMover(d, GAME, ME)).toEqual({ turn: 3, firstMover: 'me', source: 'explicit' });
    expect(statSync(firstMoverPath(d, GAME)).mode & 0o777).toBe(0o600);
    expect(statSync(join(d, 'move-order')).mode & 0o777).toBe(0o700);
  });

  it("is nobody else's: another player or game reads nothing", async () => {
    const d = dir();
    await writeFirstMover(d, GAME, ME, { turn: 3, firstMover: 'me', source: 'award' });
    expect(await readFirstMover(d, GAME, ME + 1)).toBeUndefined();
    expect(await readFirstMover(d, GAME + 1, ME)).toBeUndefined();
  });

  it('reads an unusable file as nothing, never throwing', async () => {
    const d = dir();
    mkdirSync(join(d, 'move-order'), { recursive: true });
    for (const body of [
      'not json',
      JSON.stringify({ gameId: GAME, playerId: ME, turn: 0, firstMover: 'me', source: 'explicit' }),
      JSON.stringify({ gameId: GAME, playerId: ME, turn: 2, firstMover: 'both', source: 'explicit' }),
      JSON.stringify({ gameId: GAME, playerId: ME, turn: 2, firstMover: 'me', source: 'guess' }),
    ]) {
      writeFileSync(firstMoverPath(d, GAME), body);
      expect(await readFirstMover(d, GAME, ME)).toBeUndefined();
    }
  });

  it('refuses a malformed record and never throws on an unwritable directory', async () => {
    const d = dir();
    expect(await writeFirstMover(d, GAME, ME, { turn: 0, firstMover: 'me', source: 'explicit' })).toBe(false);
    writeFileSync(join(d, 'blocked'), '');
    expect(await writeFirstMover(join(d, 'blocked'), GAME, ME, { turn: 2, firstMover: 'me', source: 'explicit' })).toBe(false);
  });

  it('deletes the files of games not written for a long time', async () => {
    const d = dir();
    mkdirSync(join(d, 'move-order'), { recursive: true });
    const old = firstMoverPath(d, GAME + 1);
    writeFileSync(old, '{}');
    const past = (Date.now() - FIRST_MOVER_MAX_AGE_MS - 86_400_000) / 1000;
    utimesSync(old, past, past);
    await writeFirstMover(d, GAME, ME, { turn: 2, firstMover: 'me', source: 'explicit' });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(firstMoverPath(d, GAME))).toBe(true);
  });
});

describe('inferFirstMover (#299)', () => {
  const OPP = 7700000022;
  const t = (territoryId: number, owner: number, armies: number) => ({ territoryId, owner: { kind: 'player' as const, playerId: owner }, armies });
  const board = (...territories: ReturnType<typeof t>[]) => ({ source: 'browser' as const, verified: true, territories });
  // My first order sent 10 from territory 1 at his territory 2, which held 20: it cannot take 20
  // moving first, yet territory 2 is mine afterwards — his stack had left first.
  const before = board(t(1, ME, 12), t(2, OPP, 20));
  const after = board(t(1, ME, 2), t(2, ME, 8));
  const orders = { deploys: [], moves: [{ from: 1, to: 2, armies: 10 }], cards: [] };
  const base = { turn: 6, before, after, orders, me: ME, opponent: OPP, orderPriorityPossible: false };

  it('reads the opponent first when my first order took what it could not have taken moving first', () => {
    expect(inferFirstMover(base)).toEqual({ turn: 6, firstMover: 'opponent', source: 'inferred' });
  });
  it('proves nothing when the capture was possible, failed, luck was on, or a card could explain it', () => {
    expect(inferFirstMover({ ...base, before: board(t(1, ME, 12), t(2, OPP, 5)) })).toBeNull();
    expect(inferFirstMover({ ...base, after: board(t(1, ME, 2), t(2, OPP, 8)) })).toBeNull();
    expect(inferFirstMover({ ...base, rates: { luckModifier: 0.16 } })).toBeNull();
    expect(inferFirstMover({ ...base, orderPriorityPossible: true })).toBeNull();
    expect(inferFirstMover({ ...base, orders: { ...orders, cards: undefined } as never })).toBeNull();
    expect(inferFirstMover({ ...base, orders: { ...orders, moves: [...orders.moves, { from: 3, to: 2, armies: 30 }] } })).toBeNull();
  });
  it('is kept as its own source, alternated, and never verified', () => {
    const inferred = { turn: 6, firstMover: 'opponent' as const, source: 'inferred' as const };
    const r = resolveFirstMover({ turn: 7, cyclicDuel: true, award: 'opponent', inferred });
    expect(r.resolved).toEqual({ firstMover: 'me', source: 'remembered', from: { turn: 6, source: 'inferred' } });
    expect(r.record).toEqual(inferred);
    expect(r.warnings[0]).toMatch(/award of picks says the opponent moves first/);
    expect(verifiedFirstMover(r.resolved!)).toBe(false);
  });
  it('says who moves first this turn in the plan', async () => {
    const game = { id: GAME, players: [{ id: ME }, { id: OPP }], settings: { moveOrder: 'Cycle' } } as never;
    const r = await firstMoverFor(undefined, game, { id: ME } as never, 7, undefined, undefined, {
      inferred: { turn: 6, firstMover: 'opponent', source: 'inferred' },
    });
    expect(r).toMatchObject({ firstMover: 'me', verified: false });
    expect(r.view?.line).toBe('You move first on turn 7 (alternated from turn 6: inferred from my first order there, not verified).');
  });
});
