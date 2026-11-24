// Local-time rendering (WARAPP_TIMEZONE): every absolute timestamp a tool answers with gains a sibling in the
// owner's zone, e.g. `time` → `localTime: "Tue 24 Nov, 6:14 am EST"`. Applied once, at the output layer
// (`withLocalTimes` wraps every registered tool's handler), so no tool formats a time itself. The UTC fields are
// never changed; with the setting unset (or invalid) nothing is touched and every answer is byte-identical.
import type { EnvSource } from '@chrischall/mcp-utils';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { parseFeedTime } from './normalize.js';

let noted = false;

/** The IANA zone WARAPP_TIMEZONE names, or undefined when unset or not a zone (noted once per process). */
export function readTimezone(env: EnvSource = process.env, note: (line: string) => void = (l) => console.error(l)): string | undefined {
  const raw = env.WARAPP_TIMEZONE?.trim();
  if (!raw) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
    return raw;
  } catch {
    if (!noted) {
      noted = true;
      note(`warapp-mcp: WARAPP_TIMEZONE "${raw}" is not an IANA time zone (e.g. America/New_York); ignored, times stay UTC only.`);
    }
    return undefined;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** An ISO (or GameFeed US-format, UTC) timestamp as "Tue 24 Nov, 6:14 am EST" in `timeZone`; undefined if not one. */
export function formatLocalTime(value: string, timeZone: string): string | undefined {
  const ms = parseFeedTime(value);
  if (ms === undefined) return undefined;
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    });
    formatters.set(timeZone, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute} ${(p.dayPeriod ?? '').toLowerCase()} ${p.timeZoneName}`;
}

/** Keys that may carry an absolute timestamp (the value must also parse as one). */
const TIME_KEY = /(?:time|at|created|since)$/i;

/** The sibling's name: `time` → `localTime`, `lastTurnTime` → `lastTurnLocalTime`, `created` → `createdLocalTime`. */
const siblingOf = (key: string): string =>
  key === 'time' ? 'localTime' : /Time$/.test(key) ? `${key.slice(0, -4)}LocalTime` : `${key}LocalTime`;

/** `data` with a local-time sibling beside every timestamp field (a new value when anything was added, else `data`). */
export function addLocalTimes(data: unknown, timeZone: string): unknown {
  if (Array.isArray(data)) {
    let changed = false;
    const out = data.map((v) => {
      const n = addLocalTimes(v, timeZone);
      if (n !== v) changed = true;
      return n;
    });
    return changed ? out : data;
  }
  if (data === null || typeof data !== 'object') return data;
  let changed = false;
  const out: Record<string, unknown> = {};
  const src = data as Record<string, unknown>;
  for (const [key, value] of Object.entries(src)) {
    const n = addLocalTimes(value, timeZone);
    if (n !== value) changed = true;
    out[key] = n;
    if (typeof value === 'string' && TIME_KEY.test(key) && !/local/i.test(key)) {
      const sibling = siblingOf(key);
      if (sibling in src) continue;
      const local = formatLocalTime(value, timeZone);
      if (local !== undefined) {
        out[sibling] = local;
        changed = true;
      }
    }
  }
  return changed ? out : data;
}

/** A tool result with local times added to its JSON text, indentation kept; the same object when nothing changes. */
export function localizeResult<T extends CallToolResult>(result: T, timeZone: string): T {
  if (!result || !Array.isArray(result.content)) return result;
  let changed = false;
  const content = result.content.map((c) => {
    if (c.type !== 'text' || !/^\s*[[{]/.test(c.text)) return c;
    let parsed: unknown;
    try {
      parsed = JSON.parse(c.text);
    } catch {
      return c;
    }
    const next = addLocalTimes(parsed, timeZone);
    if (next === parsed) return c;
    changed = true;
    const indented = /^[[{]\n/.test(c.text);
    return { ...c, text: indented ? JSON.stringify(next, null, 2) : JSON.stringify(next) };
  });
  return changed ? { ...result, content } : result;
}

/**
 * Run `register` with every tool it registers answering with local times in `timeZone` (none: `register` runs
 * untouched). The same server object is patched and restored afterwards, as `withToolConfig` does.
 */
export function withLocalTimes(server: McpServer, timeZone: string | undefined, register: () => void): void {
  if (!timeZone) {
    register();
    return;
  }
  const target = server as unknown as { registerTool: (...args: unknown[]) => unknown };
  const hadOwn = Object.hasOwn(target, 'registerTool');
  const original = target.registerTool;
  target.registerTool = (...args: unknown[]) => {
    const last = args.length - 1;
    const handler = args[last];
    if (typeof handler === 'function') {
      args[last] = async (...callArgs: unknown[]) =>
        localizeResult((await (handler as (...a: unknown[]) => Promise<CallToolResult>)(...callArgs)) as CallToolResult, timeZone);
    }
    return original.apply(server, args);
  };
  try {
    register();
  } finally {
    if (hadOwn) target.registerTool = original;
    else delete (target as { registerTool?: unknown }).registerTool;
  }
}
