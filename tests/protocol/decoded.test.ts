import { describe, expect, it } from 'vitest';
import { fields, isObj } from '../../src/protocol/decoded.js';

describe('decoded-record helpers (#133)', () => {
  it('isObj: a plain object, never null or an array', () => {
    expect(isObj({ $type: 'x' })).toBe(true);
    expect(isObj({})).toBe(true);
    expect(isObj(null)).toBe(false);
    expect(isObj([1, 2])).toBe(false);
    expect(isObj('x')).toBe(false);
  });

  it('fields: the values in read order, without the interpreter\'s own $type and $ctorError', () => {
    expect(fields({ $type: 'T', a: 1, $c: 'kept', b: null, $ctorError: 'boom' })).toEqual([1, 'kept', null]);
  });
});
