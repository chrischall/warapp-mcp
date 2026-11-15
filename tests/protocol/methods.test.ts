import { describe, expect, it } from 'vitest';
import { ProtocolError, Reader, toHex, Writer } from '../../src/protocol/codec.js';
import {
  CHAT_CHANNEL_PUBLIC,
  readTerritoryPicks,
  writeGetLatestGameInfoParams,
  writeSendChatParams,
  writeGameRefreshParams,
  writeAttackTransferOrder,
  writeDeployOrder,
  writeCardPlayOrder,
  writeDiscardOrder,
  turnPhaseOf,
  TurnPhase,
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

  it('team: the channel is the team number', () => {
    expect(hex((w) => writeSendChatParams(w, { gameId: 5, text: 'go', channel: 2 }))).toBe(
      '05000000' + str('go') + '02000000' + '00' + '00' + '00' + '00' + '00' + '00',
    );
  });

  it('private: the recipient is a present int32', () => {
    expect(hex((w) => writeSendChatParams(w, { gameId: 5, text: 'hi', recipient: 1234567 }))).toBe(
      '05000000' + str('hi') + 'FFFFFFFF' + '01' + '87D61200' + '00' + '00' + '00' + '00' + '00',
    );
  });
});

describe('GameRefresh params (UNVERIFIED live, from the client serializer)', () => {
  const str = (s: string) => {
    const w = new Writer();
    w.string(s);
    return toHex(w.bytes());
  };

  it('chat only, in a game being played: game id, chat, no details, two -1 markers, not a lobby, no group dicts', () => {
    expect(hex((w) => writeGameRefreshParams(w, { gameId: 5, chat: true, nonChat: false, lobby: false }))).toBe(
      '05000000' + '01' + '00' + str('-1') + str('-1') + '00' + '00' + '00',
    );
    expect(str('-1')).toBe('01022D31');
  });

  it('a lobby sets the lobby flag', () => {
    expect(hex((w) => writeGameRefreshParams(w, { gameId: 5, chat: true, nonChat: false, lobby: true }))).toBe(
      '05000000' + '01' + '00' + '01022D31' + '01022D31' + '01' + '00' + '00',
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

// #165: the order options. The layout is the live-verified one above; the option bytes are the
// client bundle's writer (GameOrderAttackTransfer: tag, attackTeammates, mode, byPercent, from,
// Armies, to; Armies: fogged, count, unit count, units; Commander: tag 1, GUID, owner). UNVERIFIED
// against a live commit that sets them.
describe('AttackTransfer order options (#165)', () => {
  it('Transfer Only is mode 2', () => {
    expect(hex((w) => writeAttackTransferOrder(w, { playerId: 777, from: 6, to: 4, armies: 1, mode: 2 }))).toBe(
      '01' + '00' + '02' + '00' + '06000000' + '00' + '01000000' + '00' + '04000000' + '090300000000',
    );
  });
  it('Attack Only is mode 1', () => {
    expect(hex((w) => writeAttackTransferOrder(w, { playerId: 777, from: 9, to: 10, armies: 3, mode: 1 }))).toBe(
      '01' + '00' + '01' + '00' + '09000000' + '00' + '03000000' + '00' + '0A000000' + '090300000000',
    );
  });
  it('a percentage order sets byPercent and carries the percentage as its count', () => {
    expect(hex((w) => writeAttackTransferOrder(w, { playerId: 777, from: 9, to: 10, armies: 50, byPercent: true }))).toBe(
      '01' + '00' + '03' + '01' + '09000000' + '00' + '32000000' + '00' + '0A000000' + '090300000000',
    );
  });
  it('attack teammates sets the first flag', () => {
    expect(hex((w) => writeAttackTransferOrder(w, { playerId: 777, from: 9, to: 10, armies: 3, attackTeammates: true }))).toBe(
      '01' + '01' + '03' + '00' + '09000000' + '00' + '03000000' + '00' + '0A000000' + '090300000000',
    );
  });
  it('a commander goes in the armies as one special unit: tag 1, its GUID (.NET order), its owner', () => {
    const cmdr = { id: '00112233445566778899aabbccddeeff', owner: 777 };
    expect(hex((w) => writeAttackTransferOrder(w, { playerId: 777, from: 9, to: 10, armies: 2, commander: cmdr }))).toBe(
      '01' + '00' + '03' + '00' + '09000000' +
        '00' + '02000000' + '01' + '01' + '33221100554477668899AABBCCDDEEFF' + '09030000' +
        '0A000000' + '090300000000',
    );
    // A commander alone: no armies.
    expect(hex((w) => writeAttackTransferOrder(w, { playerId: 777, from: 9, to: 10, armies: 0, commander: cmdr }))).toBe(
      '01' + '00' + '03' + '00' + '09000000' +
        '00' + '00000000' + '01' + '01' + '33221100554477668899AABBCCDDEEFF' + '09030000' +
        '0A000000' + '090300000000',
    );
  });
  it('SendOrders passes every option of a move through', () => {
    const cmdr = { id: '00112233445566778899aabbccddeeff', owner: 777 };
    const w1 = new Writer();
    writeSendOrdersParams(
      w1,
      12345,
      777,
      [{ kind: 'move', from: 9, to: 10, armies: 50, mode: 1, byPercent: true, attackTeammates: true, commander: cmdr }],
      2,
    );
    const w2 = new Writer();
    writeAttackTransferOrder(w2, { playerId: 777, from: 9, to: 10, armies: 50, mode: 1, byPercent: true, attackTeammates: true, commander: cmdr });
    expect(toHex(w1.bytes())).toBe('39300000' + '01' + '01000000' + '01' + toHex(w2.bytes()) + '02000000' + '0000');
    expect(toHex(w2.bytes())).toBe(
      '01' + '01' + '01' + '01' + '09000000' + '00' + '32000000' + '01' + '01' + '33221100554477668899AABBCCDDEEFF' + '09030000' + '0A000000' + '090300000000',
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

  it('writes card plays first, then deploys, then moves', () => {
    const card = '00112233445566778899aabbccddeeff';
    const play = '0533221100554477668899AABBCCDDEEFF090300000000';
    const deploy = '0209000000000500000009030000' + '0000';
    expect(
      hex((w) =>
        writeSendOrdersParams(
          w,
          12345,
          777,
          [
            { kind: 'deploy', territoryId: 9, armies: 5 },
            { kind: 'card', card: 'Reinforcement', cardId: card },
          ],
          2,
        ),
      ),
    ).toBe('39300000' + '01' + '02000000' + '01' + play + '01' + deploy + '02000000' + '0000');
  });

  it('sorts card plays into turn-phase order: Order Priority before Reinforcement', () => {
    const r = '00112233445566778899aabbccddeeff';
    const op = '0a0b0c0d0e0f10111213141516171819';
    const playR = '0533221100554477668899AABBCCDDEEFF090300000000';
    const playOp = '0A' + '0D0C0B0A0F0E1110' + '1213141516171819' + '090300000000';
    const deploy = '0209000000000500000009030000' + '0000';
    expect(
      hex((w) =>
        writeSendOrdersParams(
          w,
          12345,
          777,
          [
            { kind: 'card', card: 'Reinforcement', cardId: r },
            { kind: 'deploy', territoryId: 9, armies: 5 },
            { kind: 'card', card: 'OrderPriority', cardId: op },
          ],
          2,
        ),
      ),
    ).toBe('39300000' + '01' + '03000000' + '01' + playOp + '01' + playR + '01' + deploy + '02000000' + '0000');
  });

  it('writes a Blockade (phase 60) after deploys and moves', () => {
    const bl = '00112233445566778899aabbccddeeff';
    const deploy = '0209000000000500000009030000' + '0000';
    const move = '010003000600000000010000000004000000090300000000';
    const blockade = '12' + '9F000000' + '33221100554477668899AABBCCDDEEFF090300000000';
    expect(
      hex((w) =>
        writeSendOrdersParams(
          w,
          12345,
          777,
          [
            { kind: 'card', card: 'Blockade', cardId: bl, target: 159 },
            { kind: 'move', from: 6, to: 4, armies: 1 },
            { kind: 'deploy', territoryId: 9, armies: 5 },
          ],
          2,
        ),
      ),
    ).toBe('39300000' + '01' + '03000000' + '01' + deploy + '01' + move + '01' + blockade + '02000000' + '0000');
  });

  it('writes an Order Delay (phase 50) after every move, Order Priority still first', () => {
    // Live 2026-11-12: Order Delay placed with Order Priority (phase 12) was refused with error 10.
    const od = 'ffeeddccbbaa99887766554433221100';
    const r = '00112233445566778899aabbccddeeff';
    const op = '0a0b0c0d0e0f10111213141516171819';
    const playOd = '0B' + 'CCDDEEFF' + 'AABB' + '8899' + '7766554433221100' + '090300000000';
    const playR = '0533221100554477668899AABBCCDDEEFF090300000000';
    const playOp = '0A' + '0D0C0B0A0F0E1110' + '1213141516171819' + '090300000000';
    const deploy = '0209000000000500000009030000' + '0000';
    const attack = '01000300090000000003000000000A000000090300000000';
    const transfer = '010003000600000000010000000004000000090300000000';
    expect(
      hex((w) =>
        writeSendOrdersParams(
          w,
          12345,
          777,
          [
            { kind: 'card', card: 'OrderDelay', cardId: od },
            { kind: 'card', card: 'Reinforcement', cardId: r },
            { kind: 'deploy', territoryId: 9, armies: 5 },
            { kind: 'move', from: 9, to: 10, armies: 3 },
          ],
          2,
        ),
      ),
    ).toBe('39300000' + '01' + '04000000' + '01' + playR + '01' + deploy + '01' + attack + '01' + playOd + '02000000' + '0000');
    expect(
      hex((w) =>
        writeSendOrdersParams(
          w,
          12345,
          777,
          [
            { kind: 'card', card: 'OrderDelay', cardId: od },
            { kind: 'move', from: 9, to: 10, armies: 3 },
            { kind: 'card', card: 'OrderPriority', cardId: op },
            { kind: 'deploy', territoryId: 9, armies: 5 },
            { kind: 'move', from: 6, to: 4, armies: 1 },
          ],
          2,
        ),
      ),
    ).toBe(
      '39300000' + '01' + '05000000' + '01' + playOp + '01' + deploy + '01' + attack + '01' + transfer + '01' + playOd + '02000000' + '0000',
    );
  });

  it('writes an Order Delay listed between moves after them all: the live-verified shape (#127 review)', () => {
    // warapp_submit_turn sends card plays ahead of the moves, so a position "among the moves" is
    // never one the user chose; until a live commit verifies another position, card plays close
    // their phase, as in the 2026-11-12 commit.
    const od = 'ffeeddccbbaa99887766554433221100';
    const playOd = '0B' + 'CCDDEEFF' + 'AABB' + '8899' + '7766554433221100' + '090300000000';
    const attack = '01000300090000000003000000000A000000090300000000';
    const transfer = '010003000600000000010000000004000000090300000000';
    const deploy = '0209000000000500000009030000' + '0000';
    expect(
      hex((w) =>
        writeSendOrdersParams(
          w,
          12345,
          777,
          [
            { kind: 'move', from: 9, to: 10, armies: 3 },
            { kind: 'card', card: 'OrderDelay', cardId: od },
            { kind: 'move', from: 6, to: 4, armies: 1 },
            { kind: 'deploy', territoryId: 9, armies: 5 },
          ],
          2,
        ),
      ),
    ).toBe('39300000' + '01' + '04000000' + '01' + deploy + '01' + attack + '01' + transfer + '01' + playOd + '02000000' + '0000');
  });

  describe('an Order Delay placed among the moves (#186, UNVERIFIED live)', () => {
    // The bundle's GameOrderPlayCardOrderDelay writes tag 11, the GUID and the base — no position
    // field — so where the card sits in the order list is its position; its phase is 50, the moves'.
    const od = 'ffeeddccbbaa99887766554433221100';
    const playOd = '0B' + 'CCDDEEFF' + 'AABB' + '8899' + '7766554433221100' + '090300000000';
    const attack = '01000300090000000003000000000A000000090300000000';
    const transfer = '010003000600000000010000000004000000090300000000';
    const deploy = '0209000000000500000009030000' + '0000';
    const send = (beforeMove: number | undefined, card: 'OrderDelay' | 'OrderPriority' = 'OrderDelay') =>
      hex((w) =>
        writeSendOrdersParams(
          w,
          12345,
          777,
          [
            { kind: 'card', card, cardId: od, ...(beforeMove !== undefined ? { beforeMove } : {}) },
            { kind: 'deploy', territoryId: 9, armies: 5 },
            { kind: 'move', from: 9, to: 10, armies: 3 },
            { kind: 'move', from: 6, to: 4, armies: 1 },
          ],
          2,
        ),
      );
    const frame = (...orders: string[]) =>
      '39300000' + '01' + '04000000' + orders.map((o) => '01' + o).join('') + '02000000' + '0000';

    it('writes the card above the second move (beforeMove 1): deploy, attack, Order Delay, transfer', () => {
      expect(send(1)).toBe(frame(deploy, attack, playOd, transfer));
    });

    it('writes the card above the first move (beforeMove 0), still after the deploys', () => {
      expect(send(0)).toBe(frame(deploy, playOd, attack, transfer));
    });

    it('writes it after every move when beforeMove is the move count: the verified default', () => {
      expect(send(2)).toBe(send(undefined));
      expect(send(2)).toBe(frame(deploy, attack, transfer, playOd));
    });

    it('refuses a position past the moves, a negative one, and a position on any other card', () => {
      expect(() => send(3)).toThrow(/beforeMove 3 .*2 moves/);
      expect(() => send(-1)).toThrow(/beforeMove/);
      expect(() => send(1, 'OrderPriority')).toThrow(/Only an Order Delay/);
    });
  });

  it('writes discards (phase 10) before everything else, Order Priority next', () => {
    // Bundle: GameOrderDiscard.Vd() is TurnPhase 10 (Discards), ahead of Order Priority (12).
    const d = '00112233445566778899aabbccddeeff';
    const op = '0a0b0c0d0e0f10111213141516171819';
    const discard = '09' + '33221100554477668899AABBCCDDEEFF' + '090300000000';
    const playOp = '0A' + '0D0C0B0A0F0E1110' + '1213141516171819' + '090300000000';
    const deploy = '0209000000000500000009030000' + '0000';
    const move = '010003000600000000010000000004000000090300000000';
    expect(
      hex((w) =>
        writeSendOrdersParams(
          w,
          12345,
          777,
          [
            { kind: 'deploy', territoryId: 9, armies: 5 },
            { kind: 'move', from: 6, to: 4, armies: 1 },
            { kind: 'card', card: 'OrderPriority', cardId: op },
            { kind: 'discard', cardId: d },
          ],
          2,
        ),
      ),
    ).toBe('39300000' + '01' + '04000000' + '01' + discard + '01' + playOp + '01' + deploy + '01' + move + '02000000' + '0000');
  });

  it('keeps several discards in their given order', () => {
    const a = '00112233445566778899aabbccddeeff';
    const b = 'ffeeddccbbaa99887766554433221100';
    const da = '09' + '33221100554477668899AABBCCDDEEFF' + '090300000000';
    const db = '09' + 'CCDDEEFFAABB88997766554433221100' + '090300000000';
    const deploy = '0209000000000500000009030000' + '0000';
    expect(
      hex((w) =>
        writeSendOrdersParams(
          w,
          12345,
          777,
          [
            { kind: 'discard', cardId: b },
            { kind: 'deploy', territoryId: 9, armies: 5 },
            { kind: 'discard', cardId: a },
          ],
          2,
        ),
      ),
    ).toBe('39300000' + '01' + '03000000' + '01' + db + '01' + da + '01' + deploy + '02000000' + '0000');
  });

  it('writes an empty order list', () => {
    expect(hex((w) => writeSendOrdersParams(w, 1, 777, [], 0))).toBe('01000000' + '01' + '00000000' + '00000000' + '0000');
  });
});

describe('card play orders', () => {
  const card = '00112233445566778899aabbccddeeff';

  it('Reinforcement matches the live-verified golden bytes', () => {
    // Live 2026-11-12: tag 5, the card GUID in .NET order, player id, two false bools.
    expect(hex((w) => writeCardPlayOrder(w, { card: 'Reinforcement', cardId: card, playerId: 777 }))).toBe(
      '0533221100554477668899AABBCCDDEEFF090300000000',
    );
  });

  it('accepts a dashed, upper-case GUID', () => {
    expect(
      hex((w) =>
        writeCardPlayOrder(w, { card: 'Reinforcement', cardId: '00112233-4455-6677-8899-AABBCCDDEEFF', playerId: 777 }),
      ),
    ).toBe('0533221100554477668899AABBCCDDEEFF090300000000');
  });

  it('Order Priority (10) and Order Delay (11) carry no fields', () => {
    expect(hex((w) => writeCardPlayOrder(w, { card: 'OrderPriority', cardId: card, playerId: 777 }))).toBe(
      '0A33221100554477668899AABBCCDDEEFF090300000000',
    );
    expect(hex((w) => writeCardPlayOrder(w, { card: 'OrderDelay', cardId: card, playerId: 777 }))).toBe(
      '0B33221100554477668899AABBCCDDEEFF090300000000',
    );
  });

  it('Blockade (18) writes its target territory before the GUID', () => {
    expect(hex((w) => writeCardPlayOrder(w, { card: 'Blockade', cardId: card, playerId: 777, target: 42 }))).toBe(
      '122A00000033221100554477668899AABBCCDDEEFF090300000000',
    );
  });

  it('Blockade without a target is refused', () => {
    expect(() => hex((w) => writeCardPlayOrder(w, { card: 'Blockade', cardId: card, playerId: 777 }))).toThrow(/target/);
  });
});

describe('Subscribe (push socket)', () => {
  it('writes a present topic list then a null string', async () => {
    const { writeSubscribeParams, gameTopic } = await import('../../src/protocol/methods.js');
    const w = new Writer();
    writeSubscribeParams(w, [gameTopic(42)]);
    // 01 present, count 1, string "Game.42" (present, len 7), null string
    expect(toHex(w.bytes())).toBe('0101000000' + '0107' + '47616D652E3432' + '00');
  });

  it('reads the refused-topic dict; absent or null is "all accepted"', async () => {
    const { readSubscribeResult } = await import('../../src/protocol/methods.js');
    const w = new Writer().bool(true).dict(
      new Map([['Game.7', 12]]),
      (ww, k) => ww.string(k),
      (ww, v) => ww.int32(v),
    );
    expect([...readSubscribeResult(new Reader(w.bytes()))]).toEqual([['Game.7', 12]]);
    expect(readSubscribeResult(new Reader(new Writer().bool(false).bytes())).size).toBe(0);
    expect(readSubscribeResult(new Reader(new Writer().bool(true).int32(-1).bytes())).size).toBe(0);
  });
});

describe('AcceptOpenSeat (join an open game)', () => {
  it('has the client method-table ids for the lobby methods', async () => {
    const { Method } = await import('../../src/protocol/methods.js');
    expect(Method).toMatchObject({
      GetOpenGames: 10,
      GetGameDetails: 38,
      GetGameSettings: 48,
      AcceptGame: 60,
      AcceptOpenSeat: 61,
      AcceptOpenAutoGame: 62,
      GetOpenAutoGame: 63,
      DeclineGame: 64,
    });
  });

  it('writes game id, a present GameColor, the seat team, no start slot, then the mod-hook flag false (golden)', async () => {
    const { writeAcceptOpenSeatParams } = await import('../../src/protocol/methods.js');
    // war.app refuses an absent colour (server error 1, "color is null"): the colour is a
    // present flag then the GameColor record, one int32 colour index.
    expect(hex((w) => writeAcceptOpenSeatParams(w, { gameId: 0x00bc614e, team: -1, color: 3 }))).toBe(
      '4E61BC00' + '01' + '03000000' + 'FFFFFFFF' + '00' + '00',
    );
    expect(hex((w) => writeAcceptOpenSeatParams(w, { gameId: 7, team: 2, color: 0x01b3 }))).toBe(
      '07000000' + '01' + 'B3010000' + '02000000' + '0000',
    );
  });

  it('a chosen team (C4) is the same int32: the team picker passes the chosen team where a lone seat passes its own (golden, UNVERIFIED live)', async () => {
    const { writeAcceptOpenSeatParams } = await import('../../src/protocol/methods.js');
    expect(hex((w) => writeAcceptOpenSeatParams(w, { gameId: 3007, team: 1, color: 5 }))).toBe(
      'BF0B0000' + '01' + '05000000' + '01000000' + '00' + '00',
    );
  });

  it('refuses a colour index outside war.app\'s colour list', async () => {
    const { writeAcceptOpenSeatParams } = await import('../../src/protocol/methods.js');
    expect(() => hex((w) => writeAcceptOpenSeatParams(w, { gameId: 7, team: -1, color: 436 }))).toThrow(/colour/i);
    expect(() => hex((w) => writeAcceptOpenSeatParams(w, { gameId: 7, team: -1, color: -1 }))).toThrow(/colour/i);
  });

  it('reads AcceptOpenSeatReturn: the vacation-ended flag and an optional game id', async () => {
    const { readAcceptOpenSeatReturn } = await import('../../src/protocol/methods.js');
    const read = (write: (w: Writer) => void) => {
      const w = new Writer();
      write(w);
      return readAcceptOpenSeatReturn(new Reader(w.bytes()));
    };
    expect(read((w) => w.bool(false))).toBeUndefined();
    expect(read((w) => w.bool(true).bool(false).bool(false))).toEqual({ vacationEnded: false });
    expect(read((w) => w.bool(true).bool(true).bool(true).int32(42))).toEqual({ vacationEnded: true, otherGameId: 42 });
  });
});

describe('Surrender (method 67)', () => {
  it('has the client method-table id', async () => {
    const { Method } = await import('../../src/protocol/methods.js');
    expect(Method.Surrender).toBe(67);
  });

  // Hand-built: int32 LE game id 0x00BC614E = 4E 61 BC 00; bool surrender
  // (01 = surrender, 00 = take back); then the trailing "ends vacation" bool 00.
  it('writes game id, surrender=true, then the trailing flag false (golden)', async () => {
    const { writeSurrenderParams } = await import('../../src/protocol/methods.js');
    expect(hex((w) => writeSurrenderParams(w, { gameId: 0x00bc614e, surrender: true }))).toBe('4E61BC00' + '01' + '00');
  });

  it('writes game id, surrender=false (take back), then the trailing flag false (golden)', async () => {
    const { writeSurrenderParams } = await import('../../src/protocol/methods.js');
    expect(hex((w) => writeSurrenderParams(w, { gameId: 0x00bc614e, surrender: false }))).toBe('4E61BC00' + '00' + '00');
    expect(hex((w) => writeSurrenderParams(w, { gameId: 7, surrender: false }))).toBe('07000000' + '0000');
  });
});

describe('UnCommit (method 80)', () => {
  it('has the client method-table id', async () => {
    const { Method } = await import('../../src/protocol/methods.js');
    expect(Method.UnCommit).toBe(80);
  });

  // From the client bundle's writer (not yet a live capture): after the auth block,
  // only the int32 LE game id — 0x00BC614E = 4E 61 BC 00 — and no trailing bools.
  it('writes only the game id (golden)', async () => {
    const { writeUnCommitParams } = await import('../../src/protocol/methods.js');
    expect(hex((w) => writeUnCommitParams(w, 0x00bc614e))).toBe('4E61BC00');
    expect(hex((w) => writeUnCommitParams(w, 7))).toBe('07000000');
  });
});

describe('discard orders', () => {
  it('match the bundle writer: tag 9, the GUID in .NET order, then the order base', () => {
    // From the bundle's GameOrderDiscard writer: tag 9, the GUID, the order base (playerId, no result, no updates).
    expect(hex((w) => writeDiscardOrder(w, { cardId: '00112233-4455-6677-8899-aabbccddeeff', playerId: 777 }))).toBe(
      '09' + '33221100554477668899AABBCCDDEEFF' + '09030000' + '00' + '00',
    );
  });

  it('run in the Discards phase (10), before Order Priority', () => {
    expect(TurnPhase.Discards).toBe(10);
    expect(turnPhaseOf({ kind: 'discard', cardId: '00112233445566778899aabbccddeeff' })).toBe(10);
    expect(TurnPhase.Discards).toBeLessThan(TurnPhase.OrderPriorityCards);
  });
});

describe('BeginFirstTurn (method 78)', () => {
  it('has the client method-table id and takes the auth block', async () => {
    const { Method, methodName } = await import('../../src/protocol/methods.js');
    const { methodTakesAuth } = await import('../../src/protocol/rpc.js');
    expect(Method.BeginFirstTurn).toBe(78);
    expect(methodName(78)).toBe('BeginFirstTurn');
    expect(methodTakesAuth(Method.BeginFirstTurn)).toBe(true);
  });

  // Read from the client's writer (not verified live): after the auth block the
  // client writes the game id alone (int32 LE) — no trailing bools.
  // 0x00BC614E = 4E 61 BC 00.
  it('writes the game id alone (golden, from the bundle)', async () => {
    const { writeBeginFirstTurnParams } = await import('../../src/protocol/methods.js');
    expect(hex((w) => writeBeginFirstTurnParams(w, 0x00bc614e))).toBe('4E61BC00');
    expect(hex((w) => writeBeginFirstTurnParams(w, 7))).toBe('07000000');
  });

  it('round-trips through a request frame as method 78 with the game id after the auth block', async () => {
    const { Method, writeBeginFirstTurnParams } = await import('../../src/protocol/methods.js');
    const { decodeRequest, encodeRequest } = await import('../../src/protocol/codec.js');
    const bytes = encodeRequest({
      msgNum: 3,
      method: Method.BeginFirstTurn,
      extras: { dict: null, client: 'v0', serverInfoVersionA: 1, serverInfoVersionB: 2, fDb: null, kFa: null, platform: 15 },
      email: 'test@example.com',
      params: (w) => writeBeginFirstTurnParams(w, 4001),
    });
    const req = decodeRequest(bytes, { hasAuth: true });
    expect(req.method).toBe(78);
    expect(req.email).toBe('test@example.com');
    expect(req.body.int32()).toBe(4001);
    expect(req.body.remaining).toBe(0);
  });
});

describe('DeclineGame (method 64): leaving a lobby (#217)', () => {
  it('has the client method-table id and takes the auth block', async () => {
    const { Method, methodName } = await import('../../src/protocol/methods.js');
    const { methodTakesAuth } = await import('../../src/protocol/rpc.js');
    expect(Method.DeclineGame).toBe(64);
    expect(methodName(64)).toBe('DeclineGame');
    expect(methodTakesAuth(Method.DeclineGame)).toBe(true);
  });

  // Read from the client's writer (not verified live): after the auth block the int32 LE game id,
  // then one bool — whether a mod hooks the decline — sent false. 0x00BC614E = 4E 61 BC 00.
  it('writes the game id, then the mod-hook flag false (golden, from the bundle)', async () => {
    const { writeDeclineGameParams } = await import('../../src/protocol/methods.js');
    expect(hex((w) => writeDeclineGameParams(w, 0x00bc614e))).toBe('4E61BC00' + '00');
    expect(hex((w) => writeDeclineGameParams(w, 7))).toBe('07000000' + '00');
  });

  it('reads the reply: one bool, "your chat messages were removed"; an empty body is undefined', async () => {
    const { readDeclineGameReturn } = await import('../../src/protocol/methods.js');
    const read = (write: (w: Writer) => void) => {
      const w = new Writer();
      write(w);
      return readDeclineGameReturn(new Reader(w.bytes()));
    };
    expect(read((w) => w.bool(true))).toBe(true);
    expect(read((w) => w.bool(false))).toBe(false);
    expect(read(() => {})).toBeUndefined();
  });
});

// Part D (PLAN-TEAMS): the targeted card plays. Each layout is read from the client bundle's
// writer for its `GameOrderPlayCard<X>` class (the tag, the card's own fields in write order, the
// card GUID, the order base) and its phase from the class's TurnPhase; UNVERIFIED live (V9).
describe('targeted card play orders (bundle writers, UNVERIFIED live)', () => {
  const card = '00112233445566778899aabbccddeeff';
  const guid = '33221100554477668899AABBCCDDEEFF';
  const base = '09030000' + '00' + '00';

  it('Spy (6) writes the target player', () => {
    expect(hex((w) => writeCardPlayOrder(w, { card: 'Spy', cardId: card, playerId: 777, player: 1234 }))).toBe(
      '06' + 'D2040000' + guid + base,
    );
  });

  it('Spy on the neutral writes target 0 (GameOrderPlayCardSpy; CardGameSpy.CanSpyOnNeutral, UNVERIFIED live)', () => {
    expect(hex((w) => writeCardPlayOrder(w, { card: 'Spy', cardId: card, playerId: 777, player: 0 }))).toBe('06' + '00000000' + guid + base);
  });

  it('Reconnaissance (16) writes the target territory', () => {
    expect(hex((w) => writeCardPlayOrder(w, { card: 'Reconnaissance', cardId: card, playerId: 777, target: 42 }))).toBe(
      '10' + '2A000000' + guid + base,
    );
  });

  it('Surveillance (17) writes the target bonus', () => {
    expect(hex((w) => writeCardPlayOrder(w, { card: 'Surveillance', cardId: card, playerId: 777, bonus: 7 }))).toBe(
      '11' + '07000000' + guid + base,
    );
  });

  it('Gift (13) writes the recipient, then the territory', () => {
    expect(hex((w) => writeCardPlayOrder(w, { card: 'Gift', cardId: card, playerId: 777, player: 1234, target: 42 }))).toBe(
      '0D' + 'D2040000' + '2A000000' + guid + base,
    );
  });

  it('Diplomacy (14) writes the two players', () => {
    expect(
      hex((w) => writeCardPlayOrder(w, { card: 'Diplomacy', cardId: card, playerId: 777, players: [777, 1234] })),
    ).toBe('0E' + '09030000' + 'D2040000' + guid + base);
  });

  it('Sanctions (15) writes the sanctioned player', () => {
    expect(hex((w) => writeCardPlayOrder(w, { card: 'Sanctions', cardId: card, playerId: 777, player: 1234 }))).toBe(
      '0F' + 'D2040000' + guid + base,
    );
  });

  it('Bomb (20) writes the target territory (GameOrderPlayCardBomb, UNVERIFIED live)', () => {
    expect(hex((w) => writeCardPlayOrder(w, { card: 'Bomb', cardId: card, playerId: 777, target: 42 }))).toBe(
      '14' + '2A000000' + guid + base,
    );
  });

  it('Emergency Blockade (8) writes the target territory (GameOrderPlayCardAbandon, UNVERIFIED live)', () => {
    expect(hex((w) => writeCardPlayOrder(w, { card: 'EmergencyBlockade', cardId: card, playerId: 777, target: 42 }))).toBe(
      '08' + '2A000000' + guid + base,
    );
  });

  it('Airlift (12) writes a present Armies (not fogged, the count, no special units), from, a legacy 0 count, to', () => {
    expect(
      hex((w) => writeCardPlayOrder(w, { card: 'Airlift', cardId: card, playerId: 777, from: 6, to: 4, armies: 9 })),
    ).toBe('0C' + '01' + '00' + '09000000' + '00' + '06000000' + '00000000' + '04000000' + guid + base);
  });

  it('Airlift carries a commander as one special unit in its Armies, as an AttackTransfer does', () => {
    const unit = 'ffeeddccbbaa99887766554433221100';
    expect(
      hex((w) =>
        writeCardPlayOrder(w, {
          card: 'Airlift',
          cardId: card,
          playerId: 777,
          from: 6,
          to: 4,
          armies: 0,
          commander: { id: unit, owner: 777 },
        }),
      ),
    ).toBe(
      '0C' + '01' + '00' + '00000000' + '01' + '01' + 'CCDDEEFFAABB88997766554433221100' + '09030000' +
        '06000000' + '00000000' + '04000000' + guid + base,
    );
  });

  it('refuses a play missing its fields', () => {
    const play = (o: Partial<Parameters<typeof writeCardPlayOrder>[1]> & { card: Parameters<typeof writeCardPlayOrder>[1]['card'] }) =>
      hex((w) => writeCardPlayOrder(w, { cardId: card, playerId: 777, ...o }));
    expect(() => play({ card: 'Spy' })).toThrow(/Spy.*player/);
    expect(() => play({ card: 'Sanctions' })).toThrow(/Sanctions.*player/);
    expect(() => play({ card: 'Gift', target: 42 })).toThrow(/Gift.*player/);
    expect(() => play({ card: 'Gift', player: 1234 })).toThrow(/Gift.*territory/);
    expect(() => play({ card: 'Reconnaissance' })).toThrow(/Reconnaissance.*territory/);
    expect(() => play({ card: 'Bomb' })).toThrow(/Bomb.*territory/);
    expect(() => play({ card: 'EmergencyBlockade' })).toThrow(/EmergencyBlockade.*territory/);
    expect(() => play({ card: 'Surveillance' })).toThrow(/Surveillance.*bonus/);
    expect(() => play({ card: 'Diplomacy' })).toThrow(/Diplomacy.*two players/);
    expect(() => play({ card: 'Airlift', from: 6, to: 4 })).toThrow(/Airlift.*from, to and armies/);
  });

  it('run in the bundle phases: Spy-type 15, Airlift 43, Gift 47, Diplomacy 75, Sanctions 80', () => {
    const phase = (c: Parameters<typeof writeCardPlayOrder>[1]['card']) => turnPhaseOf({ kind: 'card', card: c, cardId: card });
    expect([phase('Spy'), phase('Reconnaissance'), phase('Surveillance')]).toEqual([15, 15, 15]);
    expect(phase('Airlift')).toBe(43);
    expect(phase('Gift')).toBe(47);
    expect(phase('Diplomacy')).toBe(75);
    expect(phase('Sanctions')).toBe(80);
  });

  it('run Bomb in phase 30 and Emergency Blockade in phase 37: after the deploys, before Airlift and the attacks', () => {
    const phase = (c: Parameters<typeof writeCardPlayOrder>[1]['card']) => turnPhaseOf({ kind: 'card', card: c, cardId: card });
    expect(phase('Bomb')).toBe(30);
    expect(phase('EmergencyBlockade')).toBe(37);
    const c = (n: number) => `${n.toString(16).padStart(2, '0')}112233445566778899aabbccddeeff`;
    const g = (n: number) => `332211${n.toString(16).padStart(2, '0').toUpperCase()}554477668899AABBCCDDEEFF`;
    const deploy = '0209000000000500000009030000' + '0000';
    const move = '010003000600000000010000000004000000090300000000';
    const airlift = '0C' + '01' + '00' + '09000000' + '00' + '06000000' + '00000000' + '04000000' + g(1) + base;
    const wall = '08' + '09000000' + g(2) + base;
    const bomb = '14' + '2A000000' + g(3) + base;
    expect(
      hex((w) =>
        writeSendOrdersParams(
          w,
          12345,
          777,
          [
            { kind: 'move', from: 6, to: 4, armies: 1 },
            { kind: 'card', card: 'Airlift', cardId: c(1), from: 6, to: 4, armies: 9 },
            { kind: 'card', card: 'EmergencyBlockade', cardId: c(2), target: 9 },
            { kind: 'card', card: 'Bomb', cardId: c(3), target: 42 },
            { kind: 'deploy', territoryId: 9, armies: 5 },
          ],
          2,
        ),
      ),
    ).toBe('39300000' + '01' + '05000000' + [deploy, bomb, wall, airlift, move].map((o) => '01' + o).join('') + '02000000' + '0000');
  });

  it('writeSendOrdersParams orders them by phase among the other orders', () => {
    const c = (n: number) => `${n.toString(16).padStart(2, '0')}112233445566778899aabbccddeeff`;
    // A GUID's first four bytes are written reversed (.NET order), so the varying first byte lands fourth.
    const g = (n: number) => `332211${n.toString(16).padStart(2, '0').toUpperCase()}554477668899AABBCCDDEEFF`;
    const deploy = '0209000000000500000009030000' + '0000';
    const move = '010003000600000000010000000004000000090300000000';
    const sanctions = '0F' + 'D2040000' + g(1) + base;
    const diplomacy = '0E' + '09030000' + 'D2040000' + g(2) + base;
    const blockade = '12' + '9F000000' + g(3) + base;
    const gift = '0D' + 'D2040000' + '2A000000' + g(4) + base;
    const airlift = '0C' + '01' + '00' + '09000000' + '00' + '06000000' + '00000000' + '04000000' + g(5) + base;
    const spy = '06' + 'D2040000' + g(6) + base;
    const reinforcement = '05' + g(7) + base;
    expect(
      hex((w) =>
        writeSendOrdersParams(
          w,
          12345,
          777,
          [
            { kind: 'card', card: 'Sanctions', cardId: c(1), player: 1234 },
            { kind: 'card', card: 'Diplomacy', cardId: c(2), players: [777, 1234] },
            { kind: 'card', card: 'Blockade', cardId: c(3), target: 159 },
            { kind: 'card', card: 'Gift', cardId: c(4), player: 1234, target: 42 },
            { kind: 'move', from: 6, to: 4, armies: 1 },
            { kind: 'card', card: 'Airlift', cardId: c(5), from: 6, to: 4, armies: 9 },
            { kind: 'deploy', territoryId: 9, armies: 5 },
            { kind: 'card', card: 'Spy', cardId: c(6), player: 1234 },
            { kind: 'card', card: 'Reinforcement', cardId: c(7) },
          ],
          2,
        ),
      ),
    ).toBe(
      '39300000' + '01' + '09000000' +
        [spy, reinforcement, deploy, airlift, gift, move, blockade, diplomacy, sanctions].map((o) => '01' + o).join('') +
        '02000000' + '0000',
    );
  });
});
