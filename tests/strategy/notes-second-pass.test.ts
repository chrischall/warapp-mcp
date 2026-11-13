// The second research pass: notes on cards, settings, the opening, order timing, fighting, fog
// and team play. Their numbers are checked against the combat model, and each is offered only in
// the games its condition names.
import { describe, expect, it } from 'vitest';
import { armiesToTake, straightKills } from '../../src/analysis/combat.js';
import type { GameProfile } from '../../src/analysis/profile.js';
import { type NoteContext, NOTE_TOPICS, notesFor, STRATEGY_NOTES } from '../../src/strategy/notes.js';

const profile = (over: Partial<GameProfile> = {}, settings: Partial<GameProfile['settings']> = {}): GameProfile => ({
  format: '1v1',
  opponents: 1,
  phase: 'contact',
  standing: 'even',
  standingSource: 'visible',
  notes: [],
  ...over,
  settings: { luck: 0, rounding: 'StraightRound', cards: false, localDeployments: false, noSplit: false, commanders: false, fog: 'Foggy', ...settings },
});
const ids = (p: GameProfile, x: NoteContext = {}) => notesFor(p, undefined, x).map((n) => n.id);
const note = (id: string) => STRATEGY_NOTES.find((n) => n.id === id)!;
const withCards = (...cardsInPlay: string[]): [GameProfile, NoteContext] => [profile({}, { cards: true }), { cardsInPlay }];

describe('second-pass notes: the numbers they state', () => {
  it('the smallest sure captures and their survivors, at 60/70', () => {
    // "3 take a 2 and 2 move in; 5 take a 3 (3); 6 take a 4 (3); 8 take a 5 (4); 16 take a 10 (9)"
    const text = note('opening-capture-survivors').text;
    for (const [attackers, defenders, moveIn] of [[3, 2, 2], [5, 3, 3], [6, 4, 3], [8, 5, 4], [16, 10, 9]] as const) {
      expect(armiesToTake(defenders), `${defenders}`).toBe(attackers);
      expect(attackers - straightKills(defenders, 70), `${defenders}`).toBe(moveIn);
      expect(text, `${attackers} take a ${defenders}`).toMatch(new RegExp(`\\b${attackers} (armies )?take a ${defenders}\\b`));
    }
  });

  it('a one-army attack first makes the capture behind it cheaper: 1 then 3 for a 3, 1 then 6 for a 5', () => {
    expect(note('opening-tap-then-capture').text).toMatch(/1 then 3 instead of 5/);
    expect(note('opening-tap-then-capture').text).toMatch(/1 then 6 instead of 8/);
    expect(straightKills(1, 60)).toBe(1);
    expect([armiesToTake(3), armiesToTake(3 - 1)]).toEqual([5, 3]);
    expect([armiesToTake(5), armiesToTake(5 - 1)]).toEqual([8, 6]);
  });

  it('the trade zones: below seven sixths the attacker loses more than it kills, from five thirds it captures', () => {
    expect(note('fighting-trade-zones').text).toMatch(/seven sixths/);
    expect(note('fighting-trade-zones').text).toMatch(/five thirds/);
    // 60 defenders: 69 attackers (below 70 = 7/6) kill 41 and lose 42; 71 kill 43 and lose 42; 100 (5/3) capture.
    expect(straightKills(69, 60)).toBeLessThan(straightKills(60, 70));
    expect(straightKills(71, 60)).toBeGreaterThan(straightKills(60, 70));
    expect(armiesToTake(60)).toBe(100);
  });
});

describe('second-pass notes: each is offered only where it applies', () => {
  it('a card\'s notes need that card in the game', () => {
    expect(ids(...withCards('Reinforcement'))).not.toContain('cards-bomb-hold');
    expect(ids(...withCards('Bomb'))).toEqual(expect.arrayContaining(['cards-bomb-hold', 'cards-bomb-target', 'cards-bomb-split-stacks']));
    expect(ids(...withCards('Airlift'))).toEqual(expect.arrayContaining(['cards-airlift-defend', 'cards-airlift-opponent']));
    expect(ids(...withCards('Emergency Blockade'))).toContain('cards-emergency-blockade-trap');
    expect(ids(...withCards('Blockade'))).not.toContain('cards-emergency-blockade-trap');
    expect(ids(...withCards('Sanctions'))).toContain('cards-sanctions-sign-and-timing');
    expect(ids(...withCards('Surveillance'))).toContain('cards-spy-turn-ahead');
    expect(ids(...withCards('Reinforcement'))).toEqual(expect.arrayContaining(['cards-count-arrival', 'cards-opponent-reinforcement-due', 'cards-reinforcement-play-or-hold']));
    // Order Delay and Order Priority notes follow their own cards, old and new.
    expect(ids(...withCards('Reinforcement'))).not.toContain('cards-order-delay');
    expect(ids(...withCards('Order Delay'))).toEqual(expect.arrayContaining(['cards-order-delay', 'cards-delay-keep-threat', 'cards-delay-opponent-holds']));
    expect(ids(...withCards('Order Priority'))).toContain('cards-order-priority');
    // No card at all: no card note.
    expect(notesFor(profile(), 'cards', { cardsInPlay: [] })).toEqual([]);
  });

  it('cards that need company: Diplomacy with several enemies, Gift with teams, a bomb on a commander', () => {
    const diplomacy: NoteContext = { cardsInPlay: ['Diplomacy'] };
    expect(ids(profile({}, { cards: true }), diplomacy)).toContain('cards-diplomacy-starts-next-turn');
    expect(ids(profile({}, { cards: true }), diplomacy)).not.toContain('cards-diplomacy-target');
    expect(ids(profile({ format: 'ffa', opponents: 3 }, { cards: true }), diplomacy)).toContain('cards-diplomacy-target');
    expect(ids(profile({ format: 'teams' }, { cards: true }), { cardsInPlay: ['Gift'] })).toContain('cards-gift-enemy-teammate');
    expect(ids(profile({}, { cards: true }), { cardsInPlay: ['Gift'] })).not.toContain('cards-gift-enemy-teammate');
    expect(ids(profile({}, { cards: true, commanders: true }), { cardsInPlay: ['Bomb'] })).toContain('cards-bomb-commander');
    expect(ids(profile({}, { cards: true }), { cardsInPlay: ['Bomb'] })).not.toContain('cards-bomb-commander');
    expect(ids(profile({}, { cards: true, commanders: true }), { cardsInPlay: ['Blockade'] })).toContain('cards-blockade-commander');
  });

  it('commander, guard, territory-income, negative-bonus and commerce notes follow the settings', () => {
    expect(ids(profile())).not.toContain('settings-commander-protect');
    expect(ids(profile({}, { commanders: true }))).toEqual(expect.arrayContaining(['settings-commander-protect', 'settings-commander-strike']));
    expect(ids(profile({ phase: 'expansion' }, { commanders: true }))).toContain('settings-commander-free-captures');
    expect(ids(profile({ phase: 'late' }, { commanders: true }))).not.toContain('settings-commander-free-captures');
    expect(ids(profile())).not.toContain('settings-guard-off-taps');
    expect(ids(profile(), { oneArmyStandsGuard: false })).toContain('settings-guard-off-taps');
    expect(ids(profile(), { bonusArmyPer: 6 })).toContain('settings-territory-income-threshold');
    expect(ids(profile(), { bonusArmyPer: 0 })).not.toContain('settings-territory-income-threshold');
    expect(ids(profile(), { negativeBonus: true })).toContain('settings-negative-bonus');
    expect(ids(profile())).not.toContain('settings-negative-bonus');
    expect(ids(profile(), { commerce: true })).toEqual(expect.arrayContaining(['settings-commerce-army-price', 'settings-commerce-cities']));
    expect(ids(profile(), { commerce: false })).not.toContain('settings-commerce-cities');
  });

  it('fog notes follow what the fog level shows', () => {
    // Light and Dense fog show every owner: income is read, not assumed or inferred.
    for (const fog of ['LightFog', 'ModerateFog']) {
      const got = ids(profile({}, { fog }));
      expect(got, fog).toContain('reading-fog-owners-shown');
      expect(got, fog).not.toContain('reading-unseen-opponent');
      expect(got, fog).not.toContain('reading-infer-bonuses');
    }
    for (const fog of ['Foggy', 'VeryFoggy', 'ExtremeFog']) {
      const got = ids(profile({}, { fog }));
      expect(got, fog).not.toContain('reading-fog-owners-shown');
      expect(got, fog).toEqual(expect.arrayContaining(['reading-unseen-opponent', 'reading-fog-attacks-reveal']));
    }
    // Inferring bonuses from deploys needs the deploys in view: normal fog (or a fog level not known).
    expect(ids(profile({}, { fog: 'Foggy' }))).toContain('reading-infer-bonuses');
    expect(ids(profile({}, { fog: null }))).toContain('reading-infer-bonuses');
    expect(ids(profile({}, { fog: 'VeryFoggy' }))).not.toContain('reading-infer-bonuses');
    // Dense and Heavy fog hide the armies next to you.
    expect(ids(profile({}, { fog: 'ModerateFog' }))).toContain('reading-fog-border-armies-hidden');
    expect(ids(profile({}, { fog: 'VeryFoggy' }))).toContain('reading-fog-border-armies-hidden');
    expect(ids(profile({}, { fog: 'Foggy' }))).not.toContain('reading-fog-border-armies-hidden');
    // With no fog nothing is hidden.
    const open = ids(profile({}, { fog: 'NoFog' }));
    for (const id of ['reading-fog-attacks-reveal', 'reading-stack-arrival', 'reading-deploy-order-leak', 'reading-unseen-opponent', 'fighting-hidden-stack']) {
      expect(open, id).not.toContain(id);
    }
    // Hiding your expansion works where the opponent sees armies only next to its own land: normal fog.
    expect(ids(profile({ phase: 'expansion' }, { fog: 'Foggy' }))).toContain('opening-hide-expansion');
    expect(ids(profile({ phase: 'expansion' }, { fog: 'ModerateFog' }))).not.toContain('opening-hide-expansion');
    expect(ids(profile({ phase: 'expansion' }, { fog: 'VeryFoggy' }))).not.toContain('opening-hide-expansion');
    // Pricing the opponent's best start is for fog that hides owners.
    const manual: NoteContext = { distribution: 'manual' };
    expect(ids(profile({ phase: 'opening' }, { fog: 'Foggy' }), manual)).toContain('reading-opponent-opening-pace');
    expect(ids(profile({ phase: 'opening' }, { fog: 'LightFog' }), manual)).not.toContain('reading-opponent-opening-pace');
  });

  it('pick notes need ranked picks, and the opening', () => {
    const manual: NoteContext = { distribution: 'manual', moveOrder: 'Cycle' };
    const opening = profile({ phase: 'opening' });
    expect(ids(opening, manual)).toEqual(
      expect.arrayContaining(['opening-pick-guarantees', 'opening-safe-with-neighbour', 'opening-pair-order', 'opening-counter-stands-alone', 'reading-pick-move-order', 'reading-pick-zigzag']),
    );
    const dealt = ids(opening, { distribution: 'automatic', moveOrder: 'Cycle' });
    for (const id of ['opening-pick-guarantees', 'opening-safe-with-neighbour', 'reading-pick-move-order', 'reading-pick-zigzag', 'reading-unpicked-starts']) {
      expect(dealt, id).not.toContain(id);
    }
    expect(dealt).toContain('opening-automatic-no-intel');
    expect(ids(profile({ phase: 'contact' }), manual)).not.toContain('opening-pick-guarantees');
    // What the award revealed stays useful while expanding; ranking a pair is not for commander games.
    expect(ids(profile({ phase: 'expansion' }), manual)).toContain('reading-pick-zigzag');
    expect(ids(profile({ phase: 'contact' }), manual)).not.toContain('reading-pick-zigzag');
    expect(ids(profile({ phase: 'opening' }, { commanders: true }), manual)).not.toContain('opening-pair-order');
    // Committing speed matters only under no-luck cycle; the pick award shows the move order only when it cycles.
    expect(ids(opening, manual)).not.toContain('opening-commit-speed');
    expect(ids(opening, { distribution: 'manual', moveOrder: 'NoLuckCycle' })).toContain('opening-commit-speed');
    expect(ids(opening, { distribution: 'manual', moveOrder: 'Random' })).not.toContain('reading-pick-move-order');
    // A wasteland note only in a game that has wastelands.
    expect(ids(opening, { wastelands: true })).toContain('opening-wastelands');
    expect(ids(opening, { wastelands: false })).not.toContain('opening-wastelands');
  });

  it('expansion arithmetic is offered while expanding, at the default rates with exact results', () => {
    const expanding = profile({ phase: 'expansion' });
    expect(ids(expanding)).toEqual(expect.arrayContaining(['opening-capture-survivors', 'opening-chain-captures', 'opening-tap-then-capture', 'opening-one-bonus-at-a-time']));
    expect(ids(expanding, { offensiveKillRate: 20, defensiveKillRate: 80 })).not.toContain('opening-capture-survivors');
    expect(ids(profile({ phase: 'expansion' }, { luck: 16 }))).not.toContain('opening-tap-then-capture');
    // Under No-Split a territory cannot send a one-army attack and then the capture.
    expect(ids(profile({ phase: 'expansion' }, { noSplit: true }))).not.toContain('opening-tap-then-capture');
    expect(ids(profile({ phase: 'expansion' }, { localDeployments: true }))).not.toContain('opening-one-bonus-at-a-time');
    expect(ids(profile({ phase: 'late' }))).not.toContain('opening-chain-captures');
  });

  it('timing notes: the conditional orders need their setting, the first order a known move order', () => {
    expect(ids(profile())).toEqual(expect.arrayContaining(['timing-dummy-must-move', 'timing-reinforce-first', 'timing-delay-pairs', 'timing-deploy-border-first']));
    expect(ids(profile())).not.toContain('timing-transfer-only-reinforce');
    expect(ids(profile(), { transferOnlyAllowed: true })).toContain('timing-transfer-only-reinforce');
    expect(ids(profile(), { attackOnlyAllowed: true })).toContain('timing-attack-only-retake');
    expect(ids(profile(), { percentageAllowed: true })).toContain('timing-percentage-remainder');
    expect(ids(profile(), { moveOrder: 'Cycle' })).toContain('timing-first-order-certain');
    expect(ids(profile(), { moveOrder: 'Random' })).not.toContain('timing-first-order-certain');
    expect(ids(profile({ format: 'ffa', opponents: 3 }))).not.toContain('timing-delay-pairs');
  });

  it('a note that tells of something this server cannot send says so', () => {
    // An Order Delay above other orders is still sent only from the game client.
    for (const id of ['cards-order-delay']) expect(note(id).text, id).toMatch(/game client/);
  });

  it('a note on an order option names the warapp_submit_turn field that sends it (#165)', () => {
    const fields: Record<string, RegExp> = {
      'timing-attack-only-retake': /mode "attack-only"/,
      'timing-transfer-only-reinforce': /mode "transfer-only"/,
      'teams-reinforce-capture': /mode "transfer-only"/,
      'timing-percentage-remainder': /`percent`/,
      'teams-one-owner-per-bonus': /`attack_teammates`/,
      'cards-gift-enemy-teammate': /`attack_teammates`/,
      'settings-commander-free-captures': /`commander`/,
    };
    for (const [id, field] of Object.entries(fields)) {
      expect(note(id).text, id).toMatch(field);
      expect(note(id).text, id).not.toMatch(/game client|this server cannot|never include/);
    }
    expect(note('settings-commander-protect').text).toMatch(/moves only when an order sets `commander`/);
  });

  it('a stack that dies on defence kills fewer than it loses only below a 100% defensive kill rate', () => {
    expect(ids(profile())).toContain('fighting-doomed-stack');
    expect(ids(profile(), { offensiveKillRate: 60, defensiveKillRate: 100 })).not.toContain('fighting-doomed-stack');
  });

  it('fighting notes are for contact and after, and follow the standing', () => {
    expect(ids(profile({ phase: 'expansion' })).filter((id) => id.startsWith('fighting-'))).toEqual([]);
    expect(ids(profile())).toEqual(expect.arrayContaining(['fighting-trade-zones', 'fighting-doomed-stack', 'fighting-pin', 'fighting-standoff-grow-elsewhere', 'fighting-go-round']));
    expect(ids(profile({ standing: 'ahead' }))).toContain('fighting-ahead-worst-case');
    expect(ids(profile({ standing: 'behind' }))).not.toContain('fighting-ahead-worst-case');
    expect(ids(profile({ standing: 'ahead' }))).not.toContain('fighting-trade-bonus-up');
    expect(ids(profile({ standing: 'behind' }))).toContain('fighting-trade-bonus-up');
    expect(ids(profile(), { offensiveKillRate: 30, defensiveKillRate: 75 })).not.toContain('fighting-trade-zones');
  });

  it('free-for-all and team notes follow the format', () => {
    const ffa = ids(profile({ format: 'ffa', opponents: 4 }));
    expect(ffa).toEqual(expect.arrayContaining(['ffa-leader-only', 'ffa-hide-strength', 'ffa-peaceful-stacker', 'ffa-finish-or-spare', 'ffa-neighbour-leaves']));
    // "Attack only the leader" is not advice for the leader.
    expect(ids(profile({ format: 'ffa', opponents: 4, standing: 'ahead' }))).not.toContain('ffa-leader-only');
    expect(ffa.filter((id) => id.startsWith('teams-'))).toEqual([]);
    const teams = ids(profile({ format: 'teams' }, { cards: true }), { transferOnlyAllowed: true, cardsInPlay: ['Reinforcement'] });
    expect(teams).toEqual(
      expect.arrayContaining(['teams-focus', 'teams-score-team', 'teams-one-owner-per-bonus', 'teams-transfer-not-deploy', 'teams-shared-hand', 'teams-reinforce-capture', 'teams-ai-teammate']),
    );
    expect(ids(profile()).filter((id) => id.startsWith('teams-') || id.startsWith('ffa-'))).toEqual([]);
  });

  it('every note can be reached: some game selects it', () => {
    const reached = new Set<string>();
    const cardNames = ['Reinforcement', 'Spy', 'Emergency Blockade', 'Order Priority', 'Order Delay', 'Airlift', 'Gift', 'Diplomacy', 'Sanctions', 'Reconnaissance', 'Surveillance', 'Blockade', 'Bomb'];
    for (const format of ['1v1', 'ffa', 'teams'] as const) {
      for (const phase of ['opening', 'expansion', 'contact', 'late'] as const) {
        for (const standing of ['ahead', 'behind'] as const) {
          for (const fog of ['NoFog', 'LightFog', 'Foggy', 'ModerateFog']) {
            for (const distribution of ['manual', 'automatic'] as const) {
              for (const flip of [false, true]) {
                const p = profile({ format, phase, standing }, { fog, cards: true, commanders: !flip, luck: flip ? 16 : 0, rounding: flip ? 'WeightedRandom' : 'StraightRound', localDeployments: flip, noSplit: flip });
                const x: NoteContext = {
                  cardsInPlay: cardNames,
                  distribution,
                  moveOrder: flip ? 'Random' : 'NoLuckCycle',
                  oneArmyStandsGuard: !flip,
                  multiAttack: flip,
                  armyCap: flip ? 3 : null,
                  bonusArmyPer: 6,
                  attackOnlyAllowed: true,
                  transferOnlyAllowed: true,
                  percentageAllowed: true,
                  commerce: true,
                  wastelands: true,
                  negativeBonus: true,
                };
                for (const id of ids(p, x)) reached.add(id);
              }
            }
          }
        }
      }
    }
    expect(STRATEGY_NOTES.map((n) => n.id).filter((id) => !reached.has(id))).toEqual([]);
  });

  it('the three new topics each hold notes, and no id repeats a topic prefix wrongly', () => {
    for (const t of ['opening', 'timing', 'fighting'] as const) expect(STRATEGY_NOTES.filter((n) => n.topic === t).length, t).toBeGreaterThan(5);
    for (const n of STRATEGY_NOTES.filter((x) => (['opening', 'timing', 'fighting'] as string[]).includes(x.topic))) expect(n.id.startsWith(`${n.topic}-`), n.id).toBe(true);
    expect(NOTE_TOPICS).toContain('fighting');
  });
});
