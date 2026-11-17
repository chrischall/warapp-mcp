import { describe, expect, it } from 'vitest';
import { Reader, toHex, Writer } from '../src/protocol/codec.js';
import { WarappBundle } from '../src/protocol/bundle.js';
import {
  Method,
  methodName,
  writeAcknowledgeInAppNotificationsParams,
  writeDeleteInAppNotificationParams,
  writeGetInAppNotificationsParams,
} from '../src/protocol/methods.js';
import {
  classifyNotification,
  gameIdFromData,
  NotificationsFormatError,
  NOTIFICATIONS_PAGE_SIZE,
  readInAppNotifications,
  type RawNotification,
} from '../src/notifications.js';
import { NOTIFICATIONS_BUNDLE, writeInAppNotificationsReturn, type SyntheticNotification } from './protocol/notifications-bundle.js';

const bundle = new WarappBundle(NOTIFICATIONS_BUNDLE, 'test');
const hex = (write: (w: Writer) => void) => {
  const w = new Writer();
  write(w);
  return toHex(w.bytes());
};
const read = (items: SyntheticNotification[] | null, total?: number) => {
  const w = new Writer();
  writeInAppNotificationsReturn(w, items, total);
  return readInAppNotifications(bundle, new Reader(w.bytes()));
};

const raw = (over: Partial<RawNotification> = {}): RawNotification => ({
  id: '501',
  sent: new Date(Date.UTC(2026, 10, 15, 12)),
  data: '{}',
  n3: 0,
  n4: null,
  title: 'A notification',
  unread: true,
  ...over,
});

describe('notification method ids and encoders (#311, UNVERIFIED live)', () => {
  it('names the methods by their bundle ids', () => {
    expect(Method.GetInAppNotifications).toBe(323);
    expect(Method.DeleteInAppNotification).toBe(324);
    expect(Method.AcknowledgeInAppNotifications).toBe(325);
    expect(methodName(325)).toBe('AcknowledgeInAppNotifications');
  });

  it('GetInAppNotifications is the start index then the page size (the client sends 30)', () => {
    expect(NOTIFICATIONS_PAGE_SIZE).toBe(30);
    expect(hex((w) => writeGetInAppNotificationsParams(w, 0))).toBe('00000000' + '1E000000');
    expect(hex((w) => writeGetInAppNotificationsParams(w, 30, 30))).toBe('1E000000' + '1E000000');
  });

  it('AcknowledgeInAppNotifications is a present list of ids as decimal text', () => {
    // present, count 2, then each string: present, varint length, UTF-8.
    expect(hex((w) => writeAcknowledgeInAppNotificationsParams(w, ['12', '345']))).toBe(
      '01' + '02000000' + '01' + '02' + '3132' + '01' + '03' + '333435',
    );
  });

  it('DeleteInAppNotification is one id as decimal text (the client writes it after the auth block)', () => {
    // A string: present, varint length, UTF-8.
    expect(hex((w) => writeDeleteInAppNotificationParams(w, '12'))).toBe('01' + '02' + '3132');
    expect(hex((w) => writeDeleteInAppNotificationParams(w, '9001'))).toBe('01' + '04' + '39303031');
    expect(() => writeDeleteInAppNotificationParams(new Writer(), '12a')).toThrow();
    expect(() => writeDeleteInAppNotificationParams(new Writer(), '')).toThrow();
    expect(methodName(324)).toBe('DeleteInAppNotification');
  });

  it('refuses an id that is not decimal text', () => {
    expect(() => writeAcknowledgeInAppNotificationsParams(new Writer(), ['12a'])).toThrow();
    expect(() => writeAcknowledgeInAppNotificationsParams(new Writer(), [])).toThrow();
  });
});

describe('readInAppNotifications', () => {
  it('reads each notification by read order, with the total', () => {
    const page = read(
      [
        { id: '9001', title: 'Game over', unread: true, n4: 'GameEnded', n3: 7, data: { Body: 'b' } },
        { id: '9002', unread: false, sent: null },
      ],
      41,
    );
    expect(page.total).toBe(41);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({ id: '9001', title: 'Game over', unread: true, n4: 'GameEnded', n3: 7, data: '{"Body":"b"}' });
    expect(page.items[0]!.sent?.toISOString()).toBe('2026-11-15T12:00:00.000Z');
    expect(page.items[1]).toMatchObject({ id: '9002', unread: false, sent: null });
  });

  it('an absent result or list is an empty page', () => {
    expect(readInAppNotifications(bundle, new Reader(new Uint8Array([0])))).toEqual({ items: [], total: 0 });
    expect(read(null, 0)).toEqual({ items: [], total: 0 });
  });

  it('refuses a record of another shape rather than misreading it', () => {
    const odd = new WarappBundle(NOTIFICATIONS_BUNDLE.replace('b.f6=P.Yc(a);', 'b.f6=P.Yc(a);b.f7=P.Ya(a);'), 'test');
    const w = new Writer();
    writeInAppNotificationsReturn(w, [{ id: '1' }]);
    w.int32(0);
    expect(() => readInAppNotifications(odd, new Reader(w.bytes()))).toThrow(NotificationsFormatError);
  });

  it('refuses an id that is not decimal text', () => {
    expect(() => read([{ id: 'abc' }])).toThrow(NotificationsFormatError);
  });
});

describe('gameIdFromData', () => {
  it('finds the game id in a war.app game link (Url or Urls)', () => {
    expect(gameIdFromData(JSON.stringify({ Url: 'https://war.app/MultiPlayer?GameID=45001234' }))).toBe(45001234);
    expect(gameIdFromData(JSON.stringify({ Urls: [{ Url: 'https://www.warzone.com/MultiPlayer?GameID=77&x=1' }] }))).toBe(77);
    expect(gameIdFromData(JSON.stringify({ Url: '/MultiPlayer?GameID=88' }))).toBe(88);
  });

  it('ignores another host, a body mention, bad JSON and an oversized blob', () => {
    expect(gameIdFromData(JSON.stringify({ Url: 'https://evil.example/MultiPlayer?GameID=5' }))).toBeNull();
    expect(gameIdFromData(JSON.stringify({ Body: 'see GameID=5' }))).toBeNull();
    expect(gameIdFromData('{not json')).toBeNull();
    expect(gameIdFromData(null)).toBeNull();
    expect(gameIdFromData(JSON.stringify({ Url: 'https://war.app/MultiPlayer?GameID=5', pad: 'x'.repeat(70_000) }))).toBeNull();
  });
});

describe('classifyNotification', () => {
  it('reports ids, time, unread and kind only: never the title, the body or the unverified type field', () => {
    const n = classifyNotification(
      raw({ title: 'Player Somebody beat you', data: JSON.stringify({ Body: 'secret words' }), n4: 'Somebody' }),
    );
    expect(n).toEqual({ id: '501', kind: 'other', gameId: null, time: '2026-11-15T12:00:00.000Z', unread: true });
    expect(JSON.stringify(n)).not.toMatch(/Somebody|secret/);
  });

  it("game-ended only on the client's own wording: Game \"<name>\" has ended.", () => {
    const data = JSON.stringify({ Url: 'https://war.app/MultiPlayer?GameID=4017' });
    for (const title of [
      'Game "Bob\'s war" has ended. You can now view its history',
      'Game "x" has ended.',
      'Game "a "quoted" name" has ended. You can now view its history',
    ]) {
      expect(classifyNotification(raw({ title, data })), title).toMatchObject({ kind: 'game-ended', gameId: 4017 });
    }
    for (const title of [
      'It is your turn',
      'You won the game',
      'You lost a game',
      'Your game is over',
      'Game finished',
      'Game has ended',
      'The tournament has ended',
      'Player Somebody wrote: Game "x" has ended.',
      'Game "x" has ended without the period',
    ]) {
      expect(classifyNotification(raw({ title, data })), title).toMatchObject({ kind: 'other', gameId: 4017 });
    }
  });

  it('the unverified type field never marks a notification game-ended', () => {
    const data = JSON.stringify({ Url: 'https://war.app/MultiPlayer?GameID=4017' });
    expect(classifyNotification(raw({ n4: 'GameEnded', title: 'x', data })).kind).toBe('other');
  });

  it('a game-ended title with no game link is game-ended with no game id (nothing to fold)', () => {
    expect(classifyNotification(raw({ title: 'Game "x" has ended.' }))).toMatchObject({ kind: 'game-ended', gameId: null });
  });
});
