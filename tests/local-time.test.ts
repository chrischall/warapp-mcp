import { describe, expect, it, vi } from 'vitest';
import { addLocalTimes, formatLocalTime, localizeResult, readTimezone } from '../src/local-time.js';

describe('readTimezone (WARAPP_TIMEZONE)', () => {
  it('is undefined when unset or blank', () => {
    expect(readTimezone({})).toBeUndefined();
    expect(readTimezone({ WARAPP_TIMEZONE: '  ' })).toBeUndefined();
  });

  it('accepts an IANA zone name', () => {
    expect(readTimezone({ WARAPP_TIMEZONE: 'America/New_York' })).toBe('America/New_York');
    expect(readTimezone({ WARAPP_TIMEZONE: ' Europe/London ' })).toBe('Europe/London');
  });

  it('ignores an invalid zone, with one note however often it is read', () => {
    const note = vi.fn();
    expect(readTimezone({ WARAPP_TIMEZONE: 'Mars/Olympus' }, note)).toBeUndefined();
    expect(readTimezone({ WARAPP_TIMEZONE: 'Mars/Olympus' }, note)).toBeUndefined();
    expect(note).toHaveBeenCalledTimes(1);
    expect(note.mock.calls[0]![0]).toMatch(/WARAPP_TIMEZONE.*Mars\/Olympus.*ignored/);
  });
});

describe('formatLocalTime', () => {
  it('renders an ISO instant in the zone, in standard time', () => {
    expect(formatLocalTime('2026-11-24T11:14:00.000Z', 'America/New_York')).toBe('Tue 24 Nov, 6:14 am EST');
  });

  it('follows daylight saving time', () => {
    expect(formatLocalTime('2026-07-04T18:05:00.000Z', 'America/New_York')).toBe('Sat 4 Jul, 2:05 pm EDT');
  });

  it("reads GameFeed's US-format UTC times, and crosses midnight", () => {
    expect(formatLocalTime('11/11/2026 03:00:00', 'America/Los_Angeles')).toBe('Tue 10 Nov, 7:00 pm PST');
  });

  it('is undefined for anything that is not a timestamp', () => {
    expect(formatLocalTime('5', 'America/New_York')).toBeUndefined();
    expect(formatLocalTime('3 days', 'America/New_York')).toBeUndefined();
  });
});

describe('addLocalTimes', () => {
  const tz = 'America/New_York';

  it('adds a sibling to every timestamp field, keeping the UTC field', () => {
    const data = {
      messages: [{ text: '⟦hi⟧', time: '2026-11-24T11:14:00.000Z' }, { text: '⟦no time⟧' }],
      game: { lastTurnTime: '11/24/2026 11:14:00', created: '2026-11-24T11:14:00Z', bootTime: '2 days' },
      at: '2026-11-24T11:14:00.000Z',
    };
    expect(addLocalTimes(data, tz)).toEqual({
      messages: [
        { text: '⟦hi⟧', time: '2026-11-24T11:14:00.000Z', localTime: 'Tue 24 Nov, 6:14 am EST' },
        { text: '⟦no time⟧' },
      ],
      game: {
        lastTurnTime: '11/24/2026 11:14:00',
        lastTurnLocalTime: 'Tue 24 Nov, 6:14 am EST',
        created: '2026-11-24T11:14:00Z',
        createdLocalTime: 'Tue 24 Nov, 6:14 am EST',
        bootTime: '2 days',
      },
      at: '2026-11-24T11:14:00.000Z',
      atLocalTime: 'Tue 24 Nov, 6:14 am EST',
    });
  });

  it('leaves timestamps under other keys (text) alone', () => {
    expect(addLocalTimes({ text: '2026-11-24T11:14:00.000Z' }, tz)).toEqual({ text: '2026-11-24T11:14:00.000Z' });
  });
});

describe('localizeResult', () => {
  const result = (text: string) => ({ content: [{ type: 'text' as const, text }] });

  it('returns the result untouched when there is nothing to localize', () => {
    const r = result(JSON.stringify({ a: 1 }));
    expect(localizeResult(r, 'America/New_York')).toBe(r);
    const notJson = result('plain words');
    expect(localizeResult(notJson, 'America/New_York')).toBe(notJson);
  });

  it('keeps the indentation of an indented (raw) answer', () => {
    const r = localizeResult(result(JSON.stringify({ time: '2026-11-24T11:14:00Z' }, null, 2)), 'America/New_York');
    expect(r.content[0]).toEqual({
      type: 'text',
      text: JSON.stringify({ time: '2026-11-24T11:14:00Z', localTime: 'Tue 24 Nov, 6:14 am EST' }, null, 2),
    });
  });
});
