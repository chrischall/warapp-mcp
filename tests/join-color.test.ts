import { describe, expect, it } from 'vitest';
import { Writer } from '../src/protocol/codec.js';
import { WarappBundle } from '../src/protocol/bundle.js';
import {
  chooseJoinColor,
  decodeStartupBytes,
  encodeStartupBytes,
  readAccountColors,
} from '../src/join-color.js';
import { MY_GAMES_BUNDLE, writeInitParameters, type SyntheticAccount } from './protocol/my-games-bundle.js';

const bundle = new WarappBundle(MY_GAMES_BUNDLE, 'test');

function startup(a: SyntheticAccount = {}): string {
  const w = new Writer();
  writeInitParameters(w, a);
  return encodeStartupBytes(w.bytes());
}

/** A page that starts the client with `encoded` (the call shape is made up; the reader does not depend on it). */
const page = (encoded: string, extra = '') =>
  `<html><head><script>UJS_Init("${encoded}", "wljs.Page");</script></head><body>${extra}</body></html>`;

describe('startup-string bytes', () => {
  it('round-trips every byte value through the client\'s two-characters-per-byte encoding', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const s = encodeStartupBytes(bytes);
    expect(s).toMatch(/^[>-M]+$/);
    expect(s).toHaveLength(512);
    expect(decodeStartupBytes(s)).toEqual(bytes);
  });

  it('interleaves the bits: the first character carries the even bits, the second the odd', () => {
    // 0x01 → even bits 0001, odd bits 0000; 0x02 → even 0000, odd 0001; 0xFF → 1111 / 1111.
    expect(encodeStartupBytes(Uint8Array.of(0x01, 0x02, 0xff))).toBe('?>>?MM');
  });

  it('refuses odd lengths and characters outside the alphabet', () => {
    expect(decodeStartupBytes('>>>')).toBeUndefined();
    expect(decodeStartupBytes('>N')).toBeUndefined();
    expect(decodeStartupBytes('=>')).toBeUndefined();
  });
});

describe('readAccountColors', () => {
  it('reads the signed-in account\'s preferred and secondary colours from the page startup parameters', () => {
    expect(readAccountColors(page(startup({ preferred: 3, secondary: 17 })), bundle)).toEqual({
      preferred: 3,
      secondary: 17,
    });
  });

  it('leaves out a colour the account has not set', () => {
    expect(readAccountColors(page(startup({ preferred: 5 })), bundle)).toEqual({ preferred: 5 });
    expect(readAccountColors(page(startup({ secondary: 9 })), bundle)).toEqual({ secondary: 9 });
    expect(readAccountColors(page(startup({})), bundle)).toEqual({});
  });

  it('never reports anything else the startup parameters carry', () => {
    const colors = readAccountColors(page(startup({ preferred: 2, secret: 'test@example.com|secret' })), bundle);
    expect(JSON.stringify(colors)).not.toContain('secret');
  });

  it('is undefined when the page carries no startup parameters, a signed-out page, or garbage', () => {
    expect(readAccountColors('<html><body>hi</body></html>', bundle)).toBeUndefined();
    expect(readAccountColors(page(startup({ signedOut: true })), bundle)).toBeUndefined();
    expect(readAccountColors(page('>'.repeat(200)), bundle)).toBeUndefined();
    expect(readAccountColors(page(startup({ preferred: 1 }).slice(0, 80)), bundle)).toBeUndefined();
  });

  it('finds the parameters next to other long uppercase runs (the open-games hex has digits)', () => {
    const hex = '<script type="text/plain" id="AllOpenGamesData">0000000A1B2C3D4E5F</script>';
    expect(readAccountColors(page(startup({ preferred: 4 }), hex), bundle)).toEqual({ preferred: 4 });
  });
});

describe('chooseJoinColor', () => {
  it('takes the preferred colour when no lobby player has it', () => {
    expect(chooseJoinColor({ preferred: 30, secondary: 40 }, [1, 2])).toEqual({ color: 30, source: 'preferred' });
  });

  it('falls back to the secondary colour when the preferred one is taken', () => {
    expect(chooseJoinColor({ preferred: 30, secondary: 40 }, [30])).toEqual({ color: 40, source: 'secondary' });
    expect(chooseJoinColor({ secondary: 40 }, [])).toEqual({ color: 40, source: 'secondary' });
  });

  it('else takes the first standard colour (0..23) no lobby player has', () => {
    expect(chooseJoinColor({ preferred: 30, secondary: 40 }, [30, 40])).toEqual({ color: 0, source: 'free' });
    expect(chooseJoinColor(undefined, [0, 1, 3])).toEqual({ color: 2, source: 'free' });
    expect(chooseJoinColor({}, [])).toEqual({ color: 0, source: 'free' });
  });

  it('finds no colour when every standard colour is taken', () => {
    expect(chooseJoinColor(undefined, Array.from({ length: 24 }, (_, i) => i))).toBeUndefined();
  });
});
