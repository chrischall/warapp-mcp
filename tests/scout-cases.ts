import type { ProfileStats } from '../src/scout.js';

// Synthetic Profile pages shared by tests/scout.test.ts and the scout.mjs parity test
// (tests/skill-scout.test.ts). Made-up names and numbers.

/**
 * The red team's page: a blank location (entities and wide spaces that collapse to nothing)
 * as the last label row before the real Played block, with tagline imitations above.
 */
const BLANK_LOCATION_HTML = `<h1>Newbie</h1><div>Played in 9,999 multi-player games (100% real-time)</div><div>Last seen less than 1 minute ago</div><div>Booted 0 times (0% of their last 100)</div><div>Level 1</div><font class="text-muted">Location:</font> &nbsp;<br><div>Played in 0 multi-player games (0% real-time)</div><div>Last seen 3 days ago</div><div>Booted 7 times (70% of their last 100)</div>`;

/** Tagline imitations above the real blocks, then the real Level, label rows and later blocks, `played` between them. */
const taglinePage = (played: string, location = 'Springfield') => `<html><head><title>Bob - War.app</title></head>
<body><h1>Bob</h1>
<div>Level 99</div>
<div>Played in 9,999 multi-player games (100% real-time)</div>
<div>Last seen less than 1 minute ago</div>
<div>Booted 0 times (0% of their last 100)</div>
<div>Level 55</div>
<font class="text-muted">Joined:</font> 1/2/2020<br>
<font class="text-muted">Location:</font> ${location}<br>
${played}
<div>Last seen 3 days ago</div>
<div>Booted 200 times (14% of their last 100)</div>
</body></html>`;
const REAL_PLAYED = '<div>Played in 1,606 multi-player games (87.1% real-time)</div>';
const REAL = { level: 55, multiplayerGames: 1606, realTimePct: 87.1, lastSeen: '3 days ago', boots: 200, bootRatePct: 14 };
const NONE = { level: null, multiplayerGames: null, realTimePct: null, lastSeen: null, boots: null, bootRatePct: null };

/** Spoofing pages, each with the profile the parser must return. */
export const ANCHOR_CASES: Array<[string, string, Partial<ProfileStats>]> = [
  [
    'a blank location before the real Played block (the red team page)',
    BLANK_LOCATION_HTML,
    { level: 1, multiplayerGames: 0, realTimePct: 0, lastSeen: '3 days ago', boots: 7, bootRatePct: 70 },
  ],
  ['a location of wide spaces only', taglinePage(REAL_PLAYED, '　 &#12288;'), REAL],
  ['a location of entities only', taglinePage(REAL_PLAYED, '&nbsp;&#32;'), REAL],
  ['no real Played block', taglinePage(''), NONE],
  ['a real Played block of a shape the validator rejects', taglinePage(REAL_PLAYED.replace('87.1', '87.125')), NONE],
  ['a Played text that is not a whole block', taglinePage(REAL_PLAYED.replace('</div>', '<b></b></div>')), NONE],
  [
    'owner text after the real blocks',
    taglinePage(REAL_PLAYED).replace(
      '</body>',
      '<div>Played in 1 multi-player games (1% real-time)</div><div>Last seen less than 1 second ago</div></body>',
    ),
    REAL,
  ],
  [
    'a second Played block right after server label rows',
    taglinePage(REAL_PLAYED).replace(
      '</body>',
      '<font class="text-muted">Email:</font> x<br><div>Played in 1 multi-player games (1% real-time)</div></body>',
    ),
    NONE,
  ],
  [
    'no label rows at all (nothing to anchor to)',
    '<h1>X</h1><div>Level 5</div><div>Played in 5 multi-player games (5% real-time)</div><div>Last seen 2 hours ago</div>',
    NONE,
  ],
];
