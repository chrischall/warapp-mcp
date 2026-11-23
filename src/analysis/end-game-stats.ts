// Per-player end-of-game stats (#523), as the client's end-of-game screen shows them, computed from the one
// GameFeed history read the end-of-game pass makes: its `standing<N>` boards and the `turn<N>` orders between
// them (`turn<N>` leads from `standing<N>` to `standing<N+1>`, so it is turn N+1 being played).
//
// Definitions (matched against the client's Defeat screen for game 45682542, my seat: produced 2,748, lost 625,
// killed 641, highest income 152 — all four equal; the screen's own computation is not in the bundle, which only
// lays out the rows `ArmiesProducedRow` / `ArmiesLostRow` / `ArmiesKilledRow` / `HighestIncomeRow`):
// - produced: every army the player deployed (`GameOrderDeploy`, Reinforcement-card armies included, since they
//   are deployed too);
// - lost: its armies killed in attacks — `attackingArmiesKilled` of its own attacks and `defendingArmiesKilled`
//   of attacks on its territories;
// - killed: the armies it killed — `defendingArmiesKilled` of its attacks (neutral defenders included) and
//   `attackingArmiesKilled` of attacks on its territories;
// - highest income: the most income it had on a history board (the record's board income, `turns[].income`,
//   given by the caller: cards and the army cap aside).
// An attack's defender is the territory's owner when the attack runs: the turn's starting board, updated by the
// successful attacks before it in the turn. A territory changing hands by a card (Gift, Abandon…) mid-turn is
// not followed (no such card was in play in the reference game). Pure; never throws.
import type { Player } from '../normalize.js';
import { playersByInGameId } from '../live.js';

/** One player's end-of-game stats. */
export interface PlayerEndStats {
  produced: number;
  lost: number;
  killed: number;
  /** Of `killed`: neutral armies. */
  killedNeutral: number;
  /** Cards played (`GameOrderPlayCard*`) and whole cards received (`GameOrderReceiveCard`'s `cardsMadeWhole`). */
  cardsPlayed: number;
  cardsReceived: number;
  /** The turn being played (1-based) and the state its seat entered there (`GameOrderStateTransition`), when it left. */
  left?: { turn: number; state: string };
  /**
   * The client's "All Graphs" series that come from the orders (`warlight.unity.live.Statistics`): `deployed`, the
   * armies it deployed each turn read (metric 3, "Armies actually deployed each turn"; up to the turn it left), and
   * the cumulative luck (metrics 4–6) — `luck` over all its attacks and defences, `offensiveLuck` as attacker
   * (offenseLuck − defenseLuck), `defensiveLuck` as defender (defenseLuck − offenseLuck) — from 0 before the first
   * turn, then after each turn read (every turn, as the client draws them). Rounded to 0.01.
   */
  deployed: number[];
  luck: number[];
  offensiveLuck: number[];
  defensiveLuck: number[];
}

export interface EndGameStatsResult {
  /** By GameFeed player id. */
  players: Map<number, PlayerEndStats>;
  /** Turns whose orders were read. */
  turnsRead: number;
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
};
const yes = (v: unknown): boolean => v === true || (typeof v === 'string' && v.toLowerCase() === 'true');
const SAFE_STATE = /^[A-Za-z]{1,40}$/;

/**
 * The stats from a GameFeed history (the gathered `standing<N>` / `turn<N>` object, or a `history` wrapper of
 * it), `undefined` when no turn's orders read. `players`: the game's players (owners may be in-game ids).
 */
export function endGameStats(history: unknown, players: readonly Pick<Player, 'id' | 'feedId'>[]): EndGameStatsResult | undefined {
  try {
    const h = unwrap(history);
    if (!h) return undefined;
    const byInGame = playersByInGameId(players as Player[]);
    const feedIds = new Set(players.map((p) => p.id));
    const feedOf = (raw: unknown): number | undefined => {
      const n = num(raw);
      if (!Number.isInteger(n) || n <= 0) return undefined;
      if (feedIds.has(n)) return n;
      return byInGame.get(n)?.id;
    };
    const out = new Map<number, PlayerEndStats>(
      players.map((p) => [p.id, { produced: 0, lost: 0, killed: 0, killedNeutral: 0, cardsPlayed: 0, cardsReceived: 0, deployed: [], luck: [0], offensiveLuck: [0], defensiveLuck: [0] }]),
    );
    const off = new Map<number, number>();
    const def = new Map<number, number>();
    const add = (m: Map<number, number>, p: number, v: number) => m.set(p, (m.get(p) ?? 0) + v);
    let turnsRead = 0;
    const turns = Object.keys(h)
      .map((k) => /^turn_?(\d+)$/i.exec(k))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ n: Number(m[1]), key: m[0] }))
      .sort((a, b) => a.n - b.n);
    for (const { n, key } of turns) {
      const t = h[key];
      const orders = isRec(t) ? t.orders : Array.isArray(t) ? t : undefined;
      if (!Array.isArray(orders)) continue;
      turnsRead++;
      const owner = ownersOf(h[`standing${n}`] ?? h[`standing_${n}`], feedOf);
      const deployed = new Map<number, number>();
      for (const o of orders) {
        if (!isRec(o) || typeof o.type !== 'string') continue;
        const p = feedOf(o.playerID);
        const s = p === undefined ? undefined : out.get(p);
        if (o.type === 'GameOrderDeploy') {
          if (s && p !== undefined) {
            s.produced += num(o.armies);
            add(deployed, p, num(o.armies));
          }
        } else if (o.type === 'GameOrderAttackTransfer') {
          const r = o.result;
          if (!isRec(r) || !yes(r.isAttack)) continue;
          const to = String(o.to);
          const attackersDied = num(r.attackingArmiesKilled);
          const defendersDied = num(r.defendingArmiesKilled);
          const holder = owner.get(to);
          // The client's luck (Statistics metrics 4–6): the attacker's offense less defense luck, the defender's the reverse.
          const luck = num(r.offenseLuck) - num(r.defenseLuck);
          if (s && p !== undefined) {
            s.lost += attackersDied;
            s.killed += defendersDied;
            if (holder === 'neutral') s.killedNeutral += defendersDied;
            add(off, p, luck);
          }
          const d = typeof holder === 'number' ? out.get(holder) : undefined;
          if (d && holder !== p) {
            d.lost += defendersDied;
            d.killed += attackersDied;
            add(def, holder as number, -luck);
          }
          if (yes(r.isSuccessful) && p !== undefined) owner.set(to, p);
        } else if (o.type.startsWith('GameOrderPlayCard')) {
          if (s) s.cardsPlayed++;
        } else if (o.type === 'GameOrderReceiveCard') {
          if (s && Array.isArray(o.cardsMadeWhole)) s.cardsReceived += o.cardsMadeWhole.length;
        } else if (o.type === 'GameOrderStateTransition') {
          const state = typeof o.newState === 'string' && SAFE_STATE.test(o.newState) ? o.newState : 'unknown';
          if (s) s.left = { turn: n + 1, state };
        }
      }
      const r2 = (v: number) => Math.round(v * 100) / 100;
      for (const [id, s] of out) {
        // The client adds a turn's deploy point only while the seat is still in after it.
        if (!s.left || n + 1 < s.left.turn) s.deployed.push(deployed.get(id) ?? 0);
        const o = off.get(id) ?? 0;
        const d = def.get(id) ?? 0;
        s.offensiveLuck.push(r2(o));
        s.defensiveLuck.push(r2(d));
        s.luck.push(r2(o + d));
      }
    }
    return turnsRead ? { players: out, turnsRead } : undefined;
  } catch {
    return undefined;
  }
}

/** The gathered history object (a `history` / `History` wrapper opened). */
function unwrap(history: unknown): Record<string, unknown> | undefined {
  if (!isRec(history)) return undefined;
  for (const k of ['history', 'History']) if (isRec(history[k])) return history[k] as Record<string, unknown>;
  return history;
}

/** A raw standing's owners by territory id: a player's GameFeed id, `neutral`, or absent (unknown). */
function ownersOf(standing: unknown, feedOf: (raw: unknown) => number | undefined): Map<string, number | 'neutral'> {
  const out = new Map<string, number | 'neutral'>();
  const rows = Array.isArray(standing) ? standing : isRec(standing) ? Object.values(standing) : [];
  for (const t of rows) {
    if (!isRec(t) || t.terrID === undefined) continue;
    const id = String(t.terrID);
    if (typeof t.ownedBy === 'string' && t.ownedBy.toLowerCase() === 'neutral') out.set(id, 'neutral');
    else {
      const p = feedOf(t.ownedBy);
      if (p !== undefined) out.set(id, p);
    }
  }
  return out;
}

/** The most income each player had on the history boards (`turns[].players.<id>.income`), by id. */
export function highestIncomes<K>(turns: readonly { players: ReadonlyMap<K, { income: number }> }[]): Map<K, number> {
  const out = new Map<K, number>();
  for (const t of turns) for (const [id, pt] of t.players) out.set(id, Math.max(out.get(id) ?? 0, pt.income));
  return out;
}
