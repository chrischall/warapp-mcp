import { describe, expect, it } from 'vitest';
import { WarappBundle } from '../src/protocol/bundle.js';
import { Reader, Writer } from '../src/protocol/codec.js';
import { luaArray, parseModTable } from '../src/mod-data.js';
import {
  allyAttacksIn,
  breakAlerts,
  breaksInOrders,
  diplomacy2From,
  DIPLOMACY2_MOD_ID,
  modPairs,
  myAllies,
  readModData,
  runsDiplomacy2,
} from '../src/mod-alliances.js';
import { CHAT_BUNDLE, writeGameDetailsAndChat } from './protocol/chat-bundle.js';

const bundle = new WarappBundle(CHAT_BUNDLE, 'test');
const bytes = (fill: (w: Writer) => void) => {
  const w = new Writer();
  fill(w);
  return new Reader(w.bytes());
};

/** A Lua array of records in the client's mod-table XML (numbers as the server writes them: `d|n.0`). */
const arr = (key: string, rows: Record<string, number | string>[]) =>
  `<e k="s|${key}"><v>${rows
    .map(
      (r, i) =>
        `<e k="d|${i + 1}.0"><v>${Object.entries(r)
          .map(([k, v]) => `<e k="s|${k}" v="${typeof v === 'number' ? `d|${v}.0` : `s|${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}`}" />`)
          .join('')}</v></e>`,
    )
    .join('')}</v></e>`;
const doc = (...entries: string[]) => `<?xml version="1.0" encoding="UTF-8"?> <m>${entries.join('')}</m>`;

describe('parseModTable', () => {
  it('reads scalars and nested tables in the client format', () => {
    const t = parseModTable(doc('<e k="s|ModVersion" v="s|3.0" />', '<e k="s|N" v="i|4" />', '<e k="s|On" v="b|1" />', '<e k="s|X" v="null" />', '<e k="s|Map"><v><e k="d|2.0" v="d|665.0" /></v></e>'))!;
    expect(t.get('ModVersion')).toBe('3.0');
    expect(t.get('N')).toBe(4);
    expect(t.get('On')).toBe(true);
    expect(t.get('X')).toBeNull();
    expect((t.get('Map') as Map<number, number>).get(2)).toBe(665);
  });

  it('reads a Lua array as a list and rejects what it does not understand', () => {
    const t = parseModTable(doc(arr('A', [{ ID: 1 }, { ID: 2 }])))!;
    expect(luaArray(t.get('A'))?.length).toBe(2);
    expect(parseModTable('<m><e k="s|a" v="z|1" /></m>')).toBeUndefined();
    expect(parseModTable('<m><e k="s|a" v="s|1"></m>')).toBeUndefined();
    expect(parseModTable('<x></x>')).toBeUndefined();
    expect(parseModTable('<m><e k="s|a&b" v="s|1" /></m>')).toBeUndefined();
    expect(parseModTable('not xml')).toBeUndefined();
    expect(parseModTable('<m><e k="s|q" v="s|a &quot;b&quot; &amp; &#65;" /></m>')!.get('q')).toBe('a "b" & A');
  });
});

describe('readModData + diplomacy2From', () => {
  const pub = doc('<e k="s|Identity" v="d|5.0" />', arr('Alliances', [{ ID: 2, PlayerOne: 11, PlayerTwo: 22 }, { ID: 4, PlayerOne: 33, PlayerTwo: 44 }]));
  const mine = doc(arr('PendingProposals', [{ ID: 3, PlayerOne: 33, PlayerTwo: 11 }]), arr('Alerts', [{ ID: 5, Message: 'Somebody has broken their alliance with you' }]));
  const read = (p: Map<number, string> | null, m: Map<number, string> | null) =>
    readModData(bundle, bytes((w) => writeGameDetailsAndChat(w, null, null, { public: p, mine: m })));

  it('finds the public data in the game and my data in the details, by mod id', () => {
    const r = read(new Map([[336, doc()], [DIPLOMACY2_MOD_ID, pub]]), new Map([[DIPLOMACY2_MOD_ID, mine]]))!;
    expect([...r.public.keys()]).toEqual([336, DIPLOMACY2_MOD_ID]);
    const st = diplomacy2From(r)!;
    expect(st.alliances).toEqual([
      { id: 2, proposer: 11, accepter: 22 },
      { id: 4, proposer: 33, accepter: 44 },
    ]);
    expect(st.proposalsToMe).toEqual([{ id: 3, from: 33 }]);
    expect(breakAlerts(st)).toEqual([{ id: 5, message: 'Somebody has broken their alliance with you' }]);
    expect(myAllies(st, 11)).toEqual([22]);
    expect(myAllies(st, 22)).toEqual([11]);
    expect(myAllies(st, 99)).toEqual([]);
  });

  it('reads no data for the mod as nothing stored yet (a lobby: verified shape)', () => {
    const st = diplomacy2From(read(new Map([[336, doc()]]), null)!)!;
    expect(st).toEqual({ alliances: [], proposalsToMe: [], alerts: [] });
  });

  it('is unknown on a reply it cannot read or a table it does not understand', () => {
    expect(readModData(bundle, bytes((w) => w.bool(false)))).toBeUndefined();
    expect(readModData(bundle, bytes((w) => w.bool(true).bool(false).bool(false).int32(0)))).toBeUndefined();
    const bad = read(new Map([[DIPLOMACY2_MOD_ID, doc(arr('Alliances', [{ ID: 1, PlayerOne: 2 }]))]]), null)!;
    expect(diplomacy2From(bad)).toBeUndefined();
    expect(diplomacy2From(read(new Map([[DIPLOMACY2_MOD_ID, 'garbage']]), null)!)).toBeUndefined();
  });
});

describe('modPairs and my breaks', () => {
  const st = { alliances: [{ id: 4, proposer: 33, accepter: 11 }, { id: 2, proposer: 11, accepter: 22 }], proposalsToMe: [{ id: 5, from: 44 }], alerts: [] };

  it('lists alliances by id, then proposals to me; my break order makes a pair breaking until next turn', () => {
    expect(modPairs(st, 11, 7, [33])).toEqual([
      { players: [11, 22], state: 'allied', proposer: 11, id: 2 },
      { players: [33, 11], state: 'breaking', proposer: 33, id: 4, endsTurn: 8 },
      { players: [44, 11], state: 'pending', proposer: 44, id: 5 },
    ]);
  });

  it('reads the break payload from a custom order, whatever its field layout', () => {
    const orders = [
      { $type: 'warlight.shared.orders.GameOrderCustom', a: 11, b: 'Breaking alliance with x', c: 'Diplomacy2_BreakAlliance_33' },
      { $type: 'warlight.shared.orders.GameOrderDeploy', a: 'Diplomacy2_BreakAlliance_44' },
      { $type: 'warlight.shared.orders.GameOrderCustom', c: 'Diplomacy2_BreakAlliance_x' },
    ];
    expect(breaksInOrders(orders)).toEqual([33]);
  });

  it('names the attacks on an ally; a transfer-only move attacks nothing', () => {
    const owner = new Map([[5, 22], [6, 99]]);
    const moves = [{ from: 1, to: 5 }, { from: 1, to: 6 }, { from: 2, to: 5, mode: 'transfer-only' }, { from: 3, to: 7 }];
    expect(allyAttacksIn(moves, new Set([22]), (t) => owner.get(t))).toEqual([{ index: 0, from: 1, to: 5, ally: 22 }]);
    expect(allyAttacksIn(moves, new Set(), (t) => owner.get(t))).toEqual([]);
  });

  it('knows whether a game runs the mod', () => {
    expect(runsDiplomacy2([336, 191])).toBe(true);
    expect(runsDiplomacy2([336])).toBe(false);
    expect(runsDiplomacy2(undefined)).toBe(false);
  });
});

describe('game 45736172 settings (fixture, names replaced)', async () => {
  const { readFileSync } = await import('node:fs');
  const { normalizeGame } = await import('../src/normalize.js');
  const raw = JSON.parse(readFileSync(new URL('./fixtures/gamefeed-settings-45736172.json', import.meta.url), 'utf8'));
  const game = normalizeGame(raw);

  it('reads the mod ids: Local Deployment Helper (336) and Diplomacy 2 (191)', () => {
    expect(game.settings?.mods).toBe(2);
    expect(game.settings?.modIds).toEqual([191, 336]);
    expect(runsDiplomacy2(game.settings?.modIds)).toBe(true);
    expect(game.settings?.localDeployments).toBe(true);
    expect(game.players.length).toBe(97);
  });

  it('keeps modIds unknown when an entry has no id, and empty for no mods', () => {
    const odd = normalizeGame({ ...raw, settings: { ...raw.settings, Mods: [{ Name: 'x' }] } });
    expect(odd.settings?.modIds).toBeUndefined();
    const none = normalizeGame({ ...raw, settings: { ...raw.settings, Mods: [] } });
    expect(none.settings?.modIds).toEqual([]);
  });
});

describe('allianceMismatches', async () => {
  const { allianceMismatches } = await import('../src/mod-alliances.js');
  it('flags an ally with no live agreement and a live agreement with no alliance', () => {
    expect(allianceMismatches([5, 7], [{ id: 'a1', with: 7 }, { id: 'a2', with: 9 }])).toEqual([
      { player: 5, kind: 'mod-only' },
      { player: 9, kind: 'ledger-only', agreement: 'a2' },
    ]);
    expect(allianceMismatches([], [])).toEqual([]);
  });
});
