import { describe, expect, it } from 'vitest';
import { ProtocolError, Reader, toHex, Writer } from '../../src/protocol/codec.js';
import {
  CHAT_CHANNEL_PUBLIC,
  readTerritoryPicks,
  writeGetLatestGameInfoParams,
  writeSendChatParams,
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
