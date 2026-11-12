import { describe, expect, it } from 'vitest';
import { ProtocolError, Reader, toHex, Writer } from '../../src/protocol/codec.js';
import {
  CHAT_CHANNEL_PUBLIC,
  readTerritoryPicks,
  writeGetLatestGameInfoParams,
  writeSendChatParams,
  writeAttackTransferOrder,
  writeDeployOrder,
  writeSendOrdersParams,
  writeSendTerritoryPicksParams,
} from '../../src/protocol/methods.js';

const hex = (write: (w: Writer) => void) => {
  const w = new Writer();
  write(w);
  return toHex(w.bytes());
};

describe('GetLatestGameInfo params', () => {
  it('is the game id alone', () => {
    expect(hex((w) => writeGetLatestGameInfoParams(w, 0x01020304))).toBe('04030201');
  });
});

describe('SendTerritoryPicks params', () => {
  it('writes the game id, a present int list in priority order, then two false bools', () => {
    expect(hex((w) => writeSendTerritoryPicksParams(w, 7, [9, 12, 3]))).toBe(
      '07000000' + '01' + '03000000' + '09000000' + '0C000000' + '03000000' + '00' + '00',
    );
  });

  it('writes an empty list as present with count 0', () => {
    expect(hex((w) => writeSendTerritoryPicksParams(w, 7, []))).toBe('07000000' + '01' + '00000000' + '0000');
  });
});

describe('readTerritoryPicks', () => {
  const body = (write: (w: Writer) => void) => {
    const w = new Writer();
    write(w);
    return new Reader(w.bytes());
  };

  it('reads the result-present flag and the int list', () => {
    const r = body((w) => w.bool(true).list([43, 9, 12], (ww, id) => ww.int32(id)));
    expect(readTerritoryPicks(r)).toEqual([43, 9, 12]);
    expect(r.remaining).toBe(0);
  });

  it('an absent result, or a null list, is no picks', () => {
    expect(readTerritoryPicks(body((w) => w.bool(false)))).toEqual([]);
    expect(readTerritoryPicks(body((w) => w.bool(true).int32(-1)))).toEqual([]);
  });

  it('rejects a truncated list', () => {
    expect(() => readTerritoryPicks(body((w) => w.bool(true).int32(2).int32(5)))).toThrow(ProtocolError);
  });
});

describe('SendChat params', () => {
  const str = (s: string) => {
    const w = new Writer();
    w.string(s);
    return toHex(w.bytes());
  };

  it('public: game id, text, channel -1, no recipient, no group, empty markers, no last-seen dicts', () => {
    expect(CHAT_CHANNEL_PUBLIC).toBe(-1);
    expect(hex((w) => writeSendChatParams(w, { gameId: 5, text: 'gg' }))).toBe(
      '05000000' + str('gg') + 'FFFFFFFF' + '00' + '00' + '00' + '00' + '00' + '00',
    );
  });

  it('private: the recipient is a present int32', () => {
    expect(hex((w) => writeSendChatParams(w, { gameId: 5, text: 'hi', recipient: 1234567 }))).toBe(
      '05000000' + str('hi') + 'FFFFFFFF' + '01' + '87D61200' + '00' + '00' + '00' + '00' + '00',
    );
  });
});

// Golden bytes from the prototype encoder whose output matched a live client turn commit
// byte for byte (docs/WEB-PROTOCOL.md, Orders). Synthetic ids: player 777, territories 4–10.
describe('order encoders match the live-verified layout', () => {
  it('Deploy', () => {
    expect(hex((w) => writeDeployOrder(w, { playerId: 777, territoryId: 9, armies: 5 }))).toBe(
      '02090000000005000000090300000000',
    );
  });
  it('AttackTransfer (attack)', () => {
    expect(hex((w) => writeAttackTransferOrder(w, { playerId: 777, from: 9, to: 10, armies: 3 }))).toBe(
      '01000300090000000003000000000A000000090300000000',
    );
  });
  it('AttackTransfer (1-army transfer)', () => {
    expect(hex((w) => writeAttackTransferOrder(w, { playerId: 777, from: 6, to: 4, armies: 1 }))).toBe(
      '010003000600000000010000000004000000090300000000',
    );
  });
});

describe('SendOrders params', () => {
  // Golden bytes from the encoder that matched a live client turn commit byte for byte.
  // Synthetic: game 12345, player 777, turn 2.
  it('writes deploys first, then moves in the given order, then the turn number', () => {
    expect(
      hex((w) =>
        writeSendOrdersParams(
          w,
          12345,
          777,
          [
            { kind: 'move', from: 9, to: 10, armies: 3 },
            { kind: 'deploy', territoryId: 9, armies: 5 },
            { kind: 'move', from: 6, to: 4, armies: 1 },
          ],
          2,
        ),
      ),
    ).toBe(
      '39300000010300000001020900000000050000000903000000000101000300090000000003000000000A00000009030000000001010003000600000000010000000004000000090300000000020000000000',
    );
  });

  it('writes an empty order list', () => {
    expect(hex((w) => writeSendOrdersParams(w, 1, 777, [], 0))).toBe('01000000' + '01' + '00000000' + '00000000' + '0000');
  });
});
