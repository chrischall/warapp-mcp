// The end-game pass: notes on finishing a won game, playing from behind, stand-offs, commanders at
// the end, leavers and AI seats, and the last players of a free-for-all or team game. Every number a
// note states is checked here against the combat model or a turn-by-turn simulation, and each note
// is offered only in the games its condition names.
import { describe, expect, it } from 'vitest';
import { armiesToTake, straightKills } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import type { GameProfile } from '../../src/analysis/profile.js';
import { simulateTurn, type SimTerritory } from '../../src/analysis/turn-sim.js';
import type { BoardState } from '../../src/board.js';
import type { GameMap } from '../../src/normalize.js';
import { type NoteContext, notesFor, STRATEGY_NOTES, STRATEGY_SOURCES } from '../../src/strategy/notes.js';

const profile = (over: Partial<GameProfile> = {}, settings: Partial<GameProfile['settings']> = {}): GameProfile => ({
  format: '1v1',
  opponents: 1,
  phase: 'late',
  standing: 'ahead',
  standingSource: 'visible',
  humansAlive: 2,
  aiOpponents: [],
  endsWith: null,
  notes: [],
  ...over,
  settings: { luck: 0, rounding: 'StraightRound', cards: false, localDeployments: false, noSplit: false, commanders: false, fog: 'Foggy', ...settings },
});
const ids = (p: GameProfile, x: NoteContext = {}) => notesFor(p, undefined, x).map((n) => n.id);
const note = (id: string) => {
  const n = STRATEGY_NOTES.find((x) => x.id === id);
  if (!n) throw new Error(`no note ${id}`);
  return n;
};

/** The notes this pass added. */
const END_GAME_NOTES = [
  'fighting-grind-threshold',
  'fighting-income-lead-clock',
  'fighting-army-lead-expires',
  'fighting-failed-attack-reply',
  'fighting-double-border-safety',
  'fighting-finish-contain',
  'fighting-ahead-stop-expanding',
  'fighting-more-threats-than-deploy',
  'fighting-behind-take-variance',
  'fighting-raid-back-line',
  'fighting-vote-to-end',
  'fighting-not-risk',
  'reading-net-gain',
  'reading-when-lost',
  'reading-surrender-checks',
  'reading-leaver-replan',
  'timing-setup-then-first-order',
  'settings-commander-kill-ends-game',
  'settings-commander-guard-numbers',
  'settings-commander-keep-back',
  'settings-commander-snipe-behind',
  'settings-commander-kill-neutral',
  'cards-priority-catch-runner',
  'cards-bomb-standoff-size',
  'cards-diplomacy-three-sides',
  'cards-sanctions-on-leader',
  '1v1-opponent-replaced-by-ai',
  '1v1-beaten-opponent-chat',
  'ffa-last-human',
  'ffa-coalition-match-commitment',
  'ffa-two-player-moment',
  'ffa-second-needs-third',
  'ffa-leader-combined-holds',
  'ffa-buffer-neighbour',
  'ffa-surrender-veto',
  'ffa-truce-end',
  'ffa-lost-game-exit',
  'ffa-boot-clock',
  'teams-commander-weakest',
  'teams-hand-over-before-leaving',
  'teams-no-march-through',
];

// ---- a one-border war, turn by turn (src/analysis/turn-sim.ts) ----

const map: GameMap = {
  id: 1,
  name: 'Border',
  territories: [
    { id: 1, name: 'Mine', connectedTo: [2] },
    { id: 2, name: 'Theirs', connectedTo: [1] },
  ],
  bonuses: [],
  distributionModes: [],
};
const graph = buildGraph(map);
const board: BoardState = { source: 'gamefeed', verified: true, territories: [] };
const ME = 1;
const THEM = 2;

/**
 * My stack `a` on territory 1 faces their stack `d` on territory 2. Every turn each side deploys its
 * income on its own stack; after `wait` turns of only deploying I attack every turn with all but the
 * army that stands guard, and they only defend. The turn my attack captures (positive), the turn my
 * stack is ground down to its guard (negative), or `null` if neither happens within `horizon` turns.
 */
function grind(a: number, d: number, myIncome: number, theirIncome: number, wait = 0, horizon = 40): number | null {
  let start = new Map<number, SimTerritory>([
    [1, { owner: ME, armies: a }],
    [2, { owner: THEM, armies: d }],
  ]);
  for (let turn = 1; turn <= horizon; turn++) {
    const attacking = turn > wait;
    const sendable = start.get(1)!.armies + myIncome - 1;
    const r = simulateTurn({
      graph,
      board,
      start,
      deploys: [
        { player: ME, territoryId: 1, armies: myIncome },
        { player: THEM, territoryId: 2, armies: theirIncome },
      ],
      orders: attacking ? [{ player: ME, orders: [{ from: 1, to: 2, armies: sendable }] }] : [],
      moveOrder: [ME, THEM],
    });
    expect(r.exact).toBe(true);
    if (r.territories.get(2)!.owner === ME) return turn;
    start = r.territories;
    if (attacking && start.get(1)!.armies <= 1) return -turn;
  }
  return null;
}
const breaks = (a: number, d: number, mine: number, theirs: number, wait = 0) => (grind(a, d, mine, theirs, wait) ?? 0) > 0;
/** The smallest stack that breaks a stack of `d` by attacking every turn, both sides earning `income`. */
const grindThreshold = (d: number, income: number) => {
  let a = d;
  while (!breaks(a, d, income, income)) a++;
  return a;
};
/** The fewest turns from equal stacks to the capture, choosing how long to stack first. */
const fastestBreak = (stack: number, mine: number, theirs: number) => {
  let best: number | null = null;
  for (let wait = 0; wait <= 30; wait++) {
    const t = grind(stack, stack, mine, theirs, wait, 60);
    if (t !== null && t > 0 && (best === null || t < best)) best = t;
  }
  return best;
};

/** I attack `x` from a territory holding x + 1; then their stack of `y`, if not taken, replies with all it can move. Does the reply take my territory? */
function replyTakes(x: number, y: number): boolean {
  const r = simulateTurn({
    graph,
    board,
    start: new Map([
      [1, { owner: ME, armies: x + 1 }],
      [2, { owner: THEM, armies: y }],
    ]),
    deploys: [],
    orders: [
      { player: ME, orders: [{ from: 1, to: 2, armies: x }] },
      { player: THEM, orders: [{ from: 2, to: 1, armies: y - 1 }] },
    ],
    moveOrder: [ME, THEM],
  });
  return r.territories.get(2)!.owner === THEM && r.territories.get(1)!.owner === THEM;
}
const firstReplyThatTakes = (x: number) => {
  let y = x;
  while (!replyTakes(x, y)) y++;
  return y;
};

describe('end-game notes: the numbers they state, at 60/70 with exact results', () => {
  it('the grind: attacking every turn breaks a border from about 1.1 to 1.15 times at 100 or more, 1.2 to 1.3 times at 20', () => {
    expect(note('fighting-grind-threshold').text).toMatch(/1\.1 to 1\.15 times/);
    expect(note('fighting-grind-threshold').text).toMatch(/1\.2 to 1\.3 times at 20/);
    // Equal incomes at the border, each side putting it all there.
    for (const [d, income] of [[100, 10], [100, 20], [200, 10]] as const) {
      const a = grindThreshold(d, income);
      expect(a / d, `${d} at +${income}`).toBeGreaterThanOrEqual(1.09);
      expect(a / d, `${d} at +${income}`).toBeLessThanOrEqual(1.15);
    }
    for (const income of [5, 10]) {
      const a = grindThreshold(20, income);
      expect(a / 20, `20 at +${income}`).toBeGreaterThanOrEqual(1.2);
      expect(a / 20, `20 at +${income}`).toBeLessThanOrEqual(1.3);
    }
    // The exact cases: 112 grinds 100 down (at +10 each), 111 never does; and the first attacks lose more than they kill.
    expect(grindThreshold(100, 10)).toBe(112);
    expect(grind(111, 100, 10, 10)).not.toBeGreaterThan(0);
    expect(straightKills(112 + 10 - 1, 60)).toBeLessThan(straightKills(100 + 10, 70));
    // One blow at once would need five thirds of the defenders after their deployment.
    expect(armiesToTake(110)).toBeGreaterThan(1.6 * 110);
  });

  it('an income lead from equal stacks: a fifth more takes 8 to 12 turns, half as much again 4 or 5, double 3, a tenth more may never', () => {
    const text = note('fighting-income-lead-clock').text;
    expect(text).toMatch(/12 against 10/);
    expect(text).toMatch(/8 to 12 turns/);
    expect(text).toMatch(/4 or 5/);
    expect(text).toMatch(/double 3/);
    for (const stack of [50, 100]) {
      const fifth = fastestBreak(stack, 12, 10)!;
      expect(fifth, `${stack}`).toBeGreaterThanOrEqual(8);
      expect(fifth, `${stack}`).toBeLessThanOrEqual(12);
      expect([4, 5], `${stack}`).toContain(fastestBreak(stack, 15, 10));
      expect(fastestBreak(stack, 20, 10), `${stack}`).toBe(3);
    }
    // A tenth more income: 100 against 100 does not break in 60 turns however long it stacks first.
    expect(fastestBreak(100, 11, 10)).toBeNull();
  });

  it('an army lead with the lower income expires: 40 against 20 at 7 against 10 breaks now, not after waiting 2 turns', () => {
    expect(note('fighting-army-lead-expires').text).toMatch(/40 against 20 with 7 income against 10/);
    expect(grind(40, 20, 7, 10, 0)).toBe(2);
    expect(grind(40, 20, 7, 10, 2)).toBeLessThan(0);
  });

  it('a failed attack loses its own territory to the reply from about 1.06 times at 100 armies to 1.2 times at 10', () => {
    expect(note('fighting-failed-attack-reply').text).toMatch(/1\.06 times at 100 armies/);
    expect(note('fighting-failed-attack-reply').text).toMatch(/1\.2 times at 10/);
    expect(firstReplyThatTakes(100)).toBe(106);
    expect(firstReplyThatTakes(50)).toBe(54);
    expect(firstReplyThatTakes(20)).toBe(23);
    expect(firstReplyThatTakes(10)).toBe(12);
  });

  it('a territory survives an attack of A with round(0.6 A) + 1 armies: 61 against 100; two borders 1.2 A, three 1.8 A', () => {
    const text = note('fighting-double-border-safety').text;
    expect(text).toMatch(/61 against 100/);
    expect(text).toMatch(/1\.2 × A/);
    expect(text).toMatch(/1\.8 × A/);
    for (const A of [20, 50, 100, 200]) {
      const hold = straightKills(A, 60) + 1;
      expect(armiesToTake(hold), `${A}`).toBeGreaterThan(A);
      expect(armiesToTake(hold - 1), `${A}`).toBeLessThanOrEqual(A);
    }
    expect(straightKills(100, 60) + 1).toBe(61);
    expect((2 * 61) / 100).toBeCloseTo(1.2, 1);
    expect((3 * 61) / 100).toBeCloseTo(1.8, 1);
  });

  it('a commander with g armies falls to the attack that takes g + 7: 11, 20, 28, 45; to stop A it needs round(0.6 A) − 6', () => {
    const text = note('settings-commander-guard-numbers').text;
    for (const [g, falls] of [[0, 11], [5, 20], [10, 28], [20, 45]] as const) {
      expect(armiesToTake(g + 7), `${g}`).toBe(falls);
    }
    expect(text).toMatch(/alone 11, with 5 armies 20, with 10 28, with 20 45/);
    expect(text).toMatch(/6 against 20, 54 against 100/);
    for (const A of [20, 40, 100]) {
      const g = straightKills(A, 60) - 6;
      expect(armiesToTake(g + 7), `${A}`).toBeGreaterThan(A);
      expect(armiesToTake(g - 1 + 7), `${A}`).toBeLessThanOrEqual(A);
    }
    expect([straightKills(20, 60) - 6, straightKills(100, 60) - 6]).toEqual([6, 54]);
  });

  it('a Bomb halves the stack, so the capture drops from five thirds to about five sixths: 83 instead of 166 against 100', () => {
    expect(note('cards-bomb-standoff-size').text).toMatch(/83 instead of 166 against 100/);
    expect(armiesToTake(100)).toBe(166);
    expect(armiesToTake(Math.floor(100 / 2))).toBe(83);
    expect(armiesToTake(Math.floor(20 / 2))! / 20).toBeCloseTo(5 / 6, 1);
  });

  it('a note with numbers is offered only with exact results at the default kill rates', () => {
    const numeric = [
      'fighting-grind-threshold',
      'fighting-income-lead-clock',
      'fighting-army-lead-expires',
      'fighting-failed-attack-reply',
      'fighting-double-border-safety',
      'settings-commander-guard-numbers',
      'cards-bomb-standoff-size',
    ];
    const games: Array<[GameProfile, NoteContext]> = [
      [profile({ standing: 'ahead', phase: 'contact' }, { commanders: true, cards: true }), { cardsInPlay: ['Bomb'] }],
      [profile({ standing: 'behind', phase: 'late' }, { commanders: true, cards: true }), { cardsInPlay: ['Bomb'] }],
    ];
    const reached = new Set(games.flatMap(([p, x]) => ids(p, x)));
    for (const id of numeric) expect(reached.has(id), id).toBe(true);
    for (const [p, x] of games) {
      const lucky = ids({ ...p, settings: { ...p.settings, luck: 16 } }, x);
      const weighted = ids({ ...p, settings: { ...p.settings, rounding: 'WeightedRandom' } }, x);
      const rates = ids(p, { ...x, offensiveKillRate: 50, defensiveKillRate: 50 });
      for (const id of numeric) {
        expect(lucky, id).not.toContain(id);
        expect(weighted, id).not.toContain(id);
        expect(rates, id).not.toContain(id);
      }
    }
  });
});

describe('end-game notes: each is offered only where it applies', () => {
  const FINISHING = ['fighting-finish-contain', 'fighting-ahead-stop-expanding', '1v1-beaten-opponent-chat', 'fighting-more-threats-than-deploy'];
  const COMEBACK = ['fighting-behind-take-variance', 'reading-when-lost', 'reading-surrender-checks'];

  it('a late 1v1 I am winning gets the finishing notes, not the comeback ones', () => {
    const got = ids(profile({ phase: 'late', standing: 'ahead' }));
    expect(got).toEqual(expect.arrayContaining(FINISHING));
    for (const id of COMEBACK) expect(got, id).not.toContain(id);
    // And the other way round.
    const losing = ids(profile({ phase: 'late', standing: 'behind' }));
    expect(losing).toEqual(expect.arrayContaining(COMEBACK));
    for (const id of FINISHING) expect(losing, id).not.toContain(id);
    // Before the fronts meet, no end-game fighting note at all.
    const expanding = ids(profile({ phase: 'expansion', standing: 'ahead' }));
    for (const id of END_GAME_NOTES.filter((x) => x.startsWith('fighting-'))) expect(expanding, id).not.toContain(id);
  });

  it('a free-for-all gets the free-for-all end-game notes, and a 1v1 none of them', () => {
    const ffaAhead = ids(profile({ format: 'ffa', opponents: 3, phase: 'contact', standing: 'ahead' }));
    const ffaBehind = ids(profile({ format: 'ffa', opponents: 2, phase: 'late', standing: 'behind' }));
    expect(ffaAhead).toEqual(
      expect.arrayContaining(['ffa-leader-combined-holds', 'ffa-two-player-moment', 'ffa-truce-end', 'ffa-buffer-neighbour', 'ffa-last-human', 'ffa-surrender-veto', 'ffa-boot-clock', 'reading-leaver-replan']),
    );
    expect(ffaAhead).not.toContain('ffa-coalition-match-commitment');
    expect(ffaBehind).toEqual(expect.arrayContaining(['ffa-coalition-match-commitment', 'ffa-second-needs-third', 'ffa-lost-game-exit']));
    expect(ffaBehind).not.toContain('ffa-leader-combined-holds');
    // The two-player end-game notes are not for a free-for-all.
    for (const id of ['1v1-opponent-replaced-by-ai', '1v1-beaten-opponent-chat', 'reading-when-lost', 'fighting-behind-take-variance', 'timing-setup-then-first-order']) {
      expect([...ffaAhead, ...ffaBehind], id).not.toContain(id);
    }
    for (const standing of ['ahead', 'behind'] as const) {
      const duel = ids(profile({ standing }), { moveOrder: 'Cycle' });
      expect(duel.filter((id) => id.startsWith('ffa-') || id.startsWith('teams-'))).toEqual([]);
      expect(duel).not.toContain('reading-leaver-replan');
    }
    const teams = ids(profile({ format: 'teams', opponents: 2, phase: 'contact', standing: 'behind' }));
    expect(teams).toEqual(expect.arrayContaining(['teams-hand-over-before-leaving', 'teams-no-march-through', 'ffa-last-human', 'reading-leaver-replan']));
    expect(teams.filter((id) => id.startsWith('1v1-'))).toEqual([]);
  });

  it('a commander game gets the commander notes, a game without commanders none of them', () => {
    const commanders = ['settings-commander-kill-ends-game', 'settings-commander-guard-numbers', 'settings-commander-keep-back'];
    expect(ids(profile({}, { commanders: true }))).toEqual(expect.arrayContaining(commanders));
    expect(ids(profile({ standing: 'behind', phase: 'contact' }, { commanders: true }))).toContain('settings-commander-snipe-behind');
    expect(ids(profile({ standing: 'ahead' }, { commanders: true }))).not.toContain('settings-commander-snipe-behind');
    // The kill ends a two-player game; with more sides the land turns neutral; in a team only one player goes.
    expect(ids(profile({ format: 'ffa', opponents: 3 }, { commanders: true }))).toContain('settings-commander-kill-neutral');
    expect(ids(profile({ format: 'ffa', opponents: 3 }, { commanders: true }))).not.toContain('settings-commander-kill-ends-game');
    expect(ids(profile({}, { commanders: true }))).not.toContain('settings-commander-kill-neutral');
    expect(ids(profile({ format: 'teams', opponents: 2 }, { commanders: true }))).toContain('teams-commander-weakest');
    const none = [...ids(profile()), ...ids(profile({ standing: 'behind' })), ...ids(profile({ format: 'ffa' })), ...ids(profile({ format: 'teams' }))];
    for (const id of [...commanders, 'settings-commander-snipe-behind', 'settings-commander-kill-neutral', 'teams-commander-weakest']) expect(none, id).not.toContain(id);
  });

  it('a card-conditioned note shows only with that card', () => {
    const cases: Array<[string, string, Partial<GameProfile>]> = [
      ['cards-priority-catch-runner', 'Order Priority', { standing: 'ahead', phase: 'late' }],
      ['cards-bomb-standoff-size', 'Bomb', { phase: 'contact' }],
      ['cards-diplomacy-three-sides', 'Diplomacy', { format: 'ffa', opponents: 2 }],
      ['cards-sanctions-on-leader', 'Sanctions', { format: 'ffa', opponents: 3 }],
    ];
    for (const [id, card, over] of cases) {
      const p = profile(over, { cards: true });
      expect(ids(p, { cardsInPlay: [card] }), id).toContain(id);
      expect(ids(p, { cardsInPlay: ['Reinforcement'] }), id).not.toContain(id);
      expect(ids({ ...p, settings: { ...p.settings, cards: false } }, { cardsInPlay: [] }), id).not.toContain(id);
    }
    // Catching a runner by move order ("an even chance", "certain") is a two-player statement.
    expect(ids(profile({ format: 'ffa', opponents: 2 }, { cards: true }), { cardsInPlay: ['Order Priority'] })).not.toContain('cards-priority-catch-runner');
  });

  it('the setup-then-strike pair needs a move order that alternates', () => {
    expect(ids(profile(), { moveOrder: 'Cycle' })).toContain('timing-setup-then-first-order');
    expect(ids(profile(), { moveOrder: 'NoLuckCycle' })).toContain('timing-setup-then-first-order');
    expect(ids(profile(), { moveOrder: 'Random' })).not.toContain('timing-setup-then-first-order');
  });

  it('Risk habits are flagged only where defence out-kills attack and armies cannot chain', () => {
    expect(ids(profile())).toContain('fighting-not-risk');
    expect(ids(profile(), { multiAttack: true })).not.toContain('fighting-not-risk');
    expect(ids(profile(), { offensiveKillRate: 70, defensiveKillRate: 60 })).not.toContain('fighting-not-risk');
  });
});

describe('end-game notes: the data', () => {
  it('every note of this pass exists, once, with a source from the researched pages', () => {
    const sources = new Set<string>(Object.values(STRATEGY_SOURCES));
    for (const id of END_GAME_NOTES) {
      expect(STRATEGY_NOTES.filter((n) => n.id === id), id).toHaveLength(1);
      expect(sources.has(note(id).source), id).toBe(true);
    }
  });

  it('a note that tells of something this server cannot send says to do it in the game client', () => {
    // warapp_submit_turn sends deploys, attack/transfer orders (with a commander, Transfer Only, Attack
    // Only, by percentage or attacking teammates, #185) and Reinforcement, Order Priority, Order Delay and
    // Blockade cards; it never plays Bomb, Diplomacy or Sanctions, accepts a surrender, boots a player or
    // votes to end.
    for (const id of [
      'cards-bomb-standoff-size',
      'cards-diplomacy-three-sides',
      'cards-sanctions-on-leader',
      'ffa-surrender-veto',
      'ffa-boot-clock',
      'fighting-vote-to-end',
    ]) {
      expect(note(id).text, id).toMatch(/game client/);
    }
    // Moving the commander is sent with the move's `commander` option, not yet verified live.
    expect(note('settings-commander-keep-back').text).toMatch(/`commander` on a move in warapp_submit_turn \(not yet verified live\)/);
  });

  it('a rule no page states is told as a report, not as a rule', () => {
    // That an exit shows at once to players who have not committed is the forum's account only.
    expect(note('reading-leaver-replan').text).toMatch(/report/);
    // A booted seat with AIs off turning neutral is the forum's account only.
    expect(note('ffa-boot-clock').text).toMatch(/report/);
    expect(note('ffa-neighbour-leaves').text).toMatch(/report/);
    // The boot rules page is Booting (the digests read /wiki/Booted, which redirects there).
    expect(note('ffa-boot-clock').source).toBe('https://war.app/wiki/Booting');
    // The eliminator's gain beyond the land is stated by no page.
    expect(note('ffa-buffer-neighbour').text).toMatch(/no rule page/);
  });
});

describe('end-game corrections to earlier notes', () => {
  it('Order Priority: when the opponent may play one, yours keeps your first move', () => {
    expect(note('cards-order-priority').text).toMatch(/two cancel/);
    expect(note('cards-order-priority').text).not.toMatch(/wasted/);
  });

  it('a stand-off is run forward before its armies count as surplus', () => {
    expect(note('fighting-standoff-grow-elsewhere').text).toMatch(/count the next turns out/);
    expect(note('fighting-standoff-grow-elsewhere').text).not.toMatch(/change nothing/);
  });

  it('a Reinforcement card may be kept for a border neither side can break', () => {
    expect(note('cards-reinforcement-play-or-hold').text).toMatch(/neither side can break/);
  });

  it('a commander kill with more sides turns the land neutral: see who collects it', () => {
    expect(note('settings-commander-strike').text).toMatch(/neutral/);
    expect(note('settings-commander-strike').text).toMatch(/more sides/);
  });

  it('a leaver: surrender and boot are set apart, and the player may come back', () => {
    expect(note('ffa-neighbour-leaves').text).toMatch(/separately/);
    expect(note('ffa-neighbour-leaves').text).toMatch(/take the seat back/);
    expect(note('ffa-neighbour-leaves').source).toBe(STRATEGY_SOURCES.playersIntoAis);
  });

  it('an AI teammate may play a card when the rules force one for the team', () => {
    expect(note('teams-ai-teammate').text).toMatch(/force a play/);
  });

  it('ahead, an attack at even numbers is not an even trade; behind, waiting helps the richer side', () => {
    expect(note('reading-ahead').text).not.toMatch(/even exchange of armies hurts/);
    expect(note('reading-ahead').text).toMatch(/kill more than you lose/);
    expect(note('reading-behind').text).not.toMatch(/build up/);
    expect(note('reading-behind').text).toMatch(/shrinks every turn/);
  });
});
