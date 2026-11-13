import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_PAGE_CHARS, parseCommonGames, parseProfile } from '../src/scout.js';

/**
 * skills/warapp-api/references/scout.mjs — the dependency-free twin of
 * src/scout.ts for the shell skill: HTML on stdin, the same allowlisted JSON
 * on stdout. Parity with the server's parser is pinned here, so the skill and
 * warapp_scout_player never disagree (or leak a field one of them drops).
 * All inputs are synthetic.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCOUT = join(ROOT, 'skills', 'warapp-api', 'references', 'scout.mjs');
const PROFILE = readFileSync(join(ROOT, 'tests', 'fixtures', 'scout-profile.html'), 'utf8');
const COMMON = readFileSync(join(ROOT, 'tests', 'fixtures', 'scout-common.html'), 'utf8');

function scout(args: string[], input: string) {
  const r = spawnSync(process.execPath, [SCOUT, ...args], { input, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const NEW_PLAYER = `<html><head><title>Newbie - War.app</title></head><body>
<div>Level 1</div><font class="text-muted">Location:</font> Springfield<br>
<div>Played in 0 multi-player games (0% real-time)</div></body></html>`;

const ODD_PROFILE = `<html><head><title>  Z&#233;ro &#x26; &quot;Q&quot; - War.app</title></head><body>
Level 1,234 <span>Played in 12,345 multi-player games (5.5% real-time)</span>
Last seen 3 days ago</div> Booted 1 time (1% of their last 100)
<font class="text-muted">Completed</font> 2,000 ranked games (1,000 / 2,000)<br>
<font class='text-muted'> Teams 3v3 :</font> 1,000 / 2,000 ( 50 % )</body></html>`;

/** Owner-written text (name, tagline, location) imitating stat blocks before the real ones. */
const SPOOF = `<html><head><title>Level 99 - War.app</title></head><body><h1>Level 99</h1>
<div>Level 99</div><div>Last seen less than 1 minute ago</div><div>Booted 0 times (0% of their last 100)</div>
<div>Level 55</div><font class="text-muted">Location:</font> Level 98<br>
<div>Played in 1,606 multi-player games (87.1% real-time)</div><div>Last seen 3 days ago</div></body></html>`;

const NO_HEADER_COMMON = `<table><tr><td><a href='MultiPlayer?GameID=9'>Solo</a></td><td>x</td><td>y</td><td>Declined</td></tr></table>`;

describe('scout.mjs profile', () => {
  it.each([
    ['the full fixture', PROFILE],
    ['a new player (missing blocks)', NEW_PLAYER],
    ['odd spacing, entities and thousands separators', ODD_PROFILE],
    ['an unrelated page (a sign-in form)', '<html><title>Sign in</title><body><form></form></body></html>'],
    ['a page whose owner-written text imitates the stat blocks', SPOOF],
    ['a page larger than the size cap', `${PROFILE}<!-- ${'x'.repeat(MAX_PAGE_CHARS)} -->`],
  ])('matches the server parser on %s', (_what, html) => {
    const r = scout(['profile'], html);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(parseProfile(html));
  });

  it('never prints location, email or any other personal field', () => {
    const r = scout(['profile'], PROFILE);
    expect(r.stdout).not.toMatch(/Springfield|Nowhereland|Location|Joined|example\.com/i);
    expect(JSON.parse(r.stdout)).toMatchObject({ name: 'Bob & Co', level: 55, bootRatePct: 14 });
  });

  it('reads the real blocks, never an imitation written by the profile owner', () => {
    const r = scout(['profile'], SPOOF);
    expect(JSON.parse(r.stdout)).toMatchObject({ level: 55, multiplayerGames: 1606, lastSeen: '3 days ago', boots: null });
  });
});

describe('scout.mjs common', () => {
  it.each([
    ['the full fixture', COMMON],
    ['a table without its header', NO_HEADER_COMMON],
    ['a page with no games', '<html><h1>0 Common Games with Nobody</h1></html>'],
    ['an unrelated page', '<html><body>hi</body></html>'],
    ['a page larger than the size cap', `${COMMON}<!-- ${'x'.repeat(MAX_PAGE_CHARS)} -->`],
    ['unterminated rows', '<a href="MultiPlayer?GameID=1">'.repeat(2_000) + '</a>'.repeat(2_000)],
  ])('matches the server parser on %s', (_what, html) => {
    const r = scout(['common'], html);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(parseCommonGames(html));
  });

  it('tallies my results', () => {
    expect(JSON.parse(scout(['common'], COMMON).stdout)).toMatchObject({ count: 4, wins: 1, losses: 1, inProgress: 1, teamGames: 1 });
  });
});

describe('scout.mjs usage', () => {
  it.each([[[]], [['nope']], [['profile', 'extra']]])('rejects arguments %j with exit 1', (args) => {
    const r = scout(args, PROFILE);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/usage/i);
  });

  it('exits 2 on empty input (the fetch before it failed)', () => {
    const r = scout(['profile'], ' \n');
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/no HTML/i);
  });

  it('is EPIPE-safe: a reader that stops early is not an error', () => {
    const rows = Array.from(
      { length: 4000 },
      (_, i) => `<tr><td><a href="MultiPlayer?GameID=${i + 1}">Game ${i}</a></td><td>1/1/2026</td><td>1v1</td><td>Won</td></tr>`,
    ).join('\n');
    const r = spawnSync('bash', ['-c', 'set -o pipefail; "$0" "$1" common | head -c 10 >/dev/null', process.execPath, SCOUT], {
      input: `<table>${rows}</table>`,
      encoding: 'utf8',
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
