// The in-process lock for read-modify-write stores (src/path-lock.ts).
import { describe, expect, it } from 'vitest';
import { withPathLock } from '../src/path-lock.js';

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('withPathLock', () => {
  it('runs one section per path at a time, in arrival order, and a throw releases the lock', async () => {
    let value = 0;
    const log: string[] = [];
    const bump = (name: string) =>
      withPathLock('/x', async () => {
        const read = value;
        await tick();
        value = read + 1;
        log.push(name);
      });
    const failing = () =>
      withPathLock('/x', async () => {
        await tick();
        throw new Error('boom');
      }).catch(() => log.push('failed'));
    await Promise.all([bump('a'), failing(), bump('b'), bump('c')]);
    expect(value).toBe(3);
    expect(log).toEqual(['a', 'failed', 'b', 'c']);
  });

  it('lets other paths run alongside and returns the section result', async () => {
    const order: string[] = [];
    const slow = withPathLock('/a', async () => {
      await tick();
      await tick();
      order.push('a');
      return 1;
    });
    const fast = withPathLock('/b', async () => {
      order.push('b');
      return 2;
    });
    expect(await Promise.all([slow, fast])).toEqual([1, 2]);
    expect(order).toEqual(['b', 'a']);
  });
});
