// Rule 6, the transfers (#121, #124, #125, #128, #172, #179; #133): once every deploy, attack and
// withdrawal is planned, idle armies move one step toward the front — the enemy front first, else
// the nearest territory not mine (a teammate's is no front, C3) — never into or through a conceded border, and keeping what a
// territory beside a pending capture, a stack two steps away or a finished-off player's exit needs.
// First (#125) idle armies facing no visible enemy stage one step toward the source of the step
// the leftover deploy saved toward. planPass runs it where it ran before: after the efficient
// sizes (S2), before Order Priority for a strike (rule 1s).
// #257: before any of that, an idle interior stack beside a conceded border moves into it when that
// transfer (plus what the plan leaves there) makes the border hold; the border is then held, not
// conceded — the conceded border the plan attacks from first, as #121's revival from the leftover.
// #260: when none revives and the enemy front is reached only through a conceded border the plan
// attacks an enemy from (#272: or more nearly so than any other way), an idle stack still heads for
// it — into that border — when the nearest territory not mine is no nearer; never into another conceded border or one a withdrawal leaves,
// and never from a stack beside a visible enemy at the start of the turn (interior only once a
// strike lands).
// When those steps together make the border hold, it is held after all, never left reported conceded.
import { bfsDistances, neighborsOf } from '../graph.js';
import type { Captures } from './captures.js';
import type { Holds } from './holds.js';
import type { Staging } from './leftover.js';
import type { DeployBook } from './orders.js';
import { teammateAt, type PlanCtx, type PlanState } from './state.js';
import type { Threats } from './threats.js';
import { capStepRoom, truceKeep } from './relations.js';

/** The transfers (rule 6), with staging toward `staging` (#125) when the leftover saved toward a step. */
export function transfers(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  threats: Threats,
  hd: Holds,
  caps: Captures,
  staging: Staging | undefined,
): void {
  const { g, me, s, foe, territories: state, label, bonusName, mine, mineSet, unitsAt, toTake, noSplit, myCommanders } = pc;
  const { warnings, rationale, avail, locked, coverKeep, centralKeep, captured, moves } = ps;
  const { guardAt, coverOf, orderOf, warnSplit } = book;
  const { holdArmies, borderAt, ownerOf, borders } = threats;
  const { arrived, conceded, threatened, stayAt, twoStepCite, twoStepHold, twoStepKeep } = hd;
  const { strikes, worstCase } = caps;
  /**
   * #257: a transfer from `from` to `to`, added to one already planned between them (a territory
   * issues each move once; only the largest move into a border lands before the opponent's first).
   */
  const transfer = (from: number, to: number, armies: number, reason: string) => {
    const same = moves.find((m) => m.kind === 'transfer' && m.from === from && m.to === to);
    if (same) same.armies += armies;
    else moves.push({ from, to, armies, kind: 'transfer', reason });
  };
  /**
   * What an idle stack on `t` keeps (rule 6's keeps): #128's hold while an attack on a player beside
   * it may fail, #172's two-step hold, an exit's cover (#179), the leftover kept central (#218) and a
   * truce's hold (B2).
   */
  /**
   * `t`'s keeps. `through`: a conceded border `t` is about to make hold (#257) — a two-step reach through it is cut
   * by that very move (#291: else the gate behind a conceded border would keep its armies from the border itself).
   */
  const keepOf = (t: number, through?: number) => {
    // #128: interior only if this turn's attacks on players beside it land. Until they do, it
    // keeps what holds against the threat there as if they failed (its neighbours' owners'
    // stacks and deploy as they stand): a +12 bonus was left on 1 beside a capture.
    const pending = neighborsOf(g, t).filter((x) => captured.has(x) && state.get(x)?.owner.kind === 'player');
    const ifFail = pending.length ? borderAt(t, () => false) : null;
    const keep128 = ifFail ? Math.max(0, holdArmies(ifFail.threat) - unitsAt(t)) : 0;
    // #172: or it is interior now, but a stack two steps away can take the territory in between
    // this turn and attack it next. The larger hold binds (never the two added together).
    const far = twoStepHold(t, through !== undefined ? (n) => n === through : undefined);
    const twoStep = far !== null && far.stay > keep128 ? far : null;
    const truceHold = truceKeep(pc, threats, t);
    const keep = Math.max(
      keep128,
      twoStep?.stay ?? 0,
      coverKeep.has(t) ? coverKeep.get(t)! + guardAt(t) : 0,
      // #218 (comment): the leftover kept central stays; the armies already there may still go.
      centralKeep.has(t) ? centralKeep.get(t)! + guardAt(t) : 0,
      // B2 (T4): beside a truce's covered territory, what holds it there.
      truceHold,
    );
    return { pending, ifFail, twoStep, truceHold, keep };
  };
  /**
   * #257: an idle interior stack (no enemy beside it, not my commander's, issuing no order under
   * No-Split) moves into a conceded border beside it when that transfer, with what the plan leaves
   * on the border (its deploys included), makes it hold against the threat it was conceded on: the
   * border is then held. Only a conceded border no withdrawal leaves (its armies would be gone);
   * one whose garrison stays (#59) may be. The conceded border the plan attacks from goes first, then
   * worth per army needed, fewest needed, id; from the stack beside it with the most to send (as
   * rule 6 would move it: its keeps stay) it sends what makes it hold (No-Split: the whole stack),
   * so one stack may hold several; rule 6 then moves the rest, a held border being the front.
   */
  function reviveConceded(isEnemy: (id: number) => boolean): void {
    const attacksFrom = (c: number) =>
      moves
        .filter((m) => m.from === c && m.kind === 'attack')
        .map((m) => m.to)
        .sort((a, b) => a - b);
    const need = (c: number, threat: number): number => {
      let k = 0;
      while ((toTake(stayAt(c) + (arrived.get(c) ?? 0) + k + unitsAt(c)) ?? Infinity) <= threat) {
        k++;
        if (k > 10_000) return Infinity;
      }
      return k;
    };
    const candidates = threatened
      .filter((t) => conceded.has(t.id) && mineSet.has(t.id) && borders.has(t.id))
      .filter((t) => !moves.some((m) => m.from === t.id && m.kind === 'transfer'))
      .map((t) => ({ t, threat: borders.get(t.id)!.threat, k: need(t.id, borders.get(t.id)!.threat), from: attacksFrom(t.id) }))
      .filter((c) => c.k > 0 && Number.isFinite(c.k))
      .sort(
        (a, b) =>
          Number(b.from.length > 0) - Number(a.from.length > 0) ||
          b.t.worth / b.k - a.t.worth / a.k ||
          a.k - b.k ||
          a.t.id - b.t.id,
      );
    for (const c of candidates) {
      const id = c.t.id;
      // What each idle stack beside it can send, as rule 6 would move it.
      const sources = neighborsOf(g, id)
        .filter((t) => mineSet.has(t) && !conceded.has(t) && !locked.has(t) && !myCommanders.has(t) && !orderOf(t))
        .filter((t) => !neighborsOf(g, t).some((x) => isEnemy(x)))
        .map((t) => {
          const n = avail.get(t)!;
          const part = Math.min(n, Math.max(0, stayAt(t) - keepOf(t, id).keep), capStepRoom(pc, ps, t, id));
          return { t, n, part: noSplit && part < n ? 0 : part };
        })
        .filter((x) => x.part >= c.k)
        .sort((a, b) => b.part - a.part || a.t - b.t);
      const src = sources[0];
      if (!src) continue;
      // What makes it hold (No-Split: the whole stack); the rest stays idle for the next border and
      // rule 6, which now passes through this one.
      const k = noSplit ? src.part : c.k;
      avail.set(src.t, src.n - k);
      const reason = `holds ${label(id)} after all (not conceded)`;
      transfer(src.t, id, k, reason);
      arrived.set(id, (arrived.get(id) ?? 0) + k);
      conceded.delete(id);
      locked.add(id);
      const conceding = `${label(id)} cannot be held `;
      for (let i = warnings.length - 1; i >= 0; i--)
        if (warnings[i]!.startsWith(conceding) && warnings[i]!.endsWith(': conceded')) warnings.splice(i, 1);
      const total = stayAt(id) + (arrived.get(id) ?? 0) + unitsAt(id);
      rationale.push(
        `Hold ${label(id)} after all (not conceded): transfer ${k} idle armies from ${label(src.t)} into it (${total} armies need ${toTake(total)} to take, above the ~${c.threat} threat; protects +${c.t.value})${
          c.from.length ? `; the border the plan attacks ${c.from.map(label).join(', ')} from` : ''
        }. They land only once the transfer runs, so the border holds only if it runs before the attack on it.`,
      );
    }
  }
  if (s.idleTransfers ?? true) {
    const isEnemy = (id: number) => {
      const st = state.get(id);
      return st?.owner.kind === 'player' && foe(st.owner.playerId) && !pc.truce.noFront(id);
    };
    reviveConceded(isEnemy);
    // #121: a capture counts as held only when it lands for sure — a neutral, or an attack on a
    // player sized for its owner's whole deploy (finishing off, fog pressure, a commander strike).
    // An exact-sized attack on a player fails if the owner reinforces first, and a garrison moved
    // off beside it as "idle interior" would leave its border on the guard.
    const lands = (t: number) =>
      state.get(t)?.owner.kind !== 'player' || worstCase.has(t) || strikes.has(t);
    const held = new Set([...mine, ...[...captured].filter(lands)]);
    // A conceded border is not "the front": the plan gives it up, so armies never flow into it and
    // distances are not measured through it; idle armies concentrate on a front that holds.
    const passable = (id: number) => held.has(id) && !conceded.has(id);
    // B2 (T4): a truce's covered territory is no front (isEnemy, above).
    // Enemy front first (#121): idle armies head for the territories a visible enemy holds; only
    // with no enemy reachable do they head for the nearest territory not mine (neutral or fog).
    // PLAN-TEAMS C3: a teammate's territory is no front either; nothing there is to be taken.
    const ids = [...g.territoryById.keys()];
    const enemyFront = ids.filter((id) => !held.has(id) && isEnemy(id));
    const anyFront = ids.filter((id) => !held.has(id) && !pc.truce.noFront(id) && !teammateAt(pc, id));
    const distEnemy = bfsDistances(g, enemyFront, { passable });
    const distAny = bfsDistances(g, anyFront, { passable });
    // #260: when the enemy front is reached only through a conceded border the plan attacks an
    // enemy from (no revival above made it hold), idle armies still head for it — into that border —
    // rather than to a neutral edge no nearer. Never into any other conceded border (the plan gives
    // it up), nor one a withdrawal leaves.
    const attacksFrom = (x: number) =>
      moves
        .filter((m) => m.from === x && m.kind === 'attack' && isEnemy(m.to))
        .map((m) => m.to)
        .sort((a, b) => a - b);
    const withdrawn = new Set(moves.filter((m) => m.kind === 'transfer' && conceded.has(m.from)).map((m) => m.from));
    const viaOk = (id: number) => !conceded.has(id) || (!withdrawn.has(id) && attacksFrom(id).length > 0);
    const distEnemyVia = bfsDistances(g, enemyFront, { passable: (id) => held.has(id) && viaOk(id) });
    // #125: staging. Idle armies on a territory facing no visible enemy — a border beside neutrals
    // included — walk one step toward the source of the capture the leftover saved toward, when
    // it is no farther than the enemy front; once there they help take it.
    if (staging) {
      const st = staging;
      const distStage = bfsDistances(g, [st.from], { passable });
      for (const t of mine) {
        const n = avail.get(t)!;
        if (n <= 0 || locked.has(t) || t === st.from || conceded.has(t) || myCommanders.has(t)) continue;
        if (neighborsOf(g, t).some((x) => isEnemy(x) || x === st.t)) continue;
        if (moves.some((m) => m.from === t && m.kind === 'attack')) continue;
        const d = distStage.get(t);
        if (d === undefined || d < 1 || d > (distEnemy.get(t) ?? Infinity)) continue;
        // B2 (T5): never onto a truce's capped border past its cap, nor back along a transfer.
        const step = neighborsOf(g, t)
          .filter((x) => mineSet.has(x) && !conceded.has(x) && (distStage.get(x) ?? Infinity) < d && capStepRoom(pc, ps, t, x) > 0)
          .sort((a, b) => distStage.get(a)! - distStage.get(b)! || a - b)[0];
        if (step === undefined) continue;
        // #172: what a stack two steps away needs it to keep stays (the step below says so).
        const far = twoStepHold(t);
        // #179: nor what covers a finished-off player's exit. B2 (T4): nor what holds it beside a truce's covered territory.
        const truceStay = truceKeep(pc, threats, t) - guardAt(t);
        const room = capStepRoom(pc, ps, t, step);
        const k = Math.min(n - Math.max(twoStepKeep(t), coverOf(t), centralKeep.get(t) ?? 0, truceStay), room);
        // No-Split (#124): the whole stack or nothing.
        if (k <= 0 || (noSplit && k < n)) continue;
        if (orderOf(t)) {
          warnSplit(t, `its ${k} idle armies do not stage toward ${label(st.t)}`);
          continue;
        }
        avail.set(t, n - k);
        const reason = `stages toward ${label(st.t)}, the next step of bonus ${bonusName(st.bonusId)}`;
        transfer(t, step, k, reason);
        arrived.set(step, (arrived.get(step) ?? 0) + k);
        rationale.push(
          `Move ${k} from ${label(t)} to ${label(step)}: ${reason} (${st.cost} to take from ${label(st.from)}, not affordable this turn)${
            k < n && k === room
              ? `; the rest stay: a truce caps the armies on ${label(step)} at what this leaves there`
              : k < n && far
              ? twoStepCite(t, far, (c) => `; the rest stay: ${c}`)
              : k < n && truceStay > 0
              ? '; the rest stay: they hold it beside a truce\'s covered territory'
              : ''
          }.`,
        );
      }
    }
    // #260 (review): the via steps into each conceded border, so that one that several steps make
    // hold together (#257 tries one stack at a time) is held after all, not reported conceded.
    const viaInto = new Map<number, { from: number[]; lines: { i: number; front: string }[] }>();
    for (const t of mine) {
      // Only an interior stack: one beside a visible enemy at the start of the turn (interior only
      // once this turn's strike lands) keeps its armies for that strike and its own border, as
      // #257's revival keeps them.
      // #272: or when the via route is strictly nearer than the plain one — live, the plain route
      // reached the front through a neutral captured this turn, one step longer, and the stack went
      // there instead of into the border the plan attacks from.
      const via =
        distEnemyVia.has(t) &&
        distEnemyVia.get(t)! < (distEnemy.get(t) ?? Infinity) &&
        distEnemyVia.get(t)! <= (distAny.get(t) ?? Infinity) &&
        !neighborsOf(g, t).some((x) => isEnemy(x));
      const dist = via ? distEnemyVia : distEnemy.has(t) ? distEnemy : distAny;
      const n = avail.get(t)!;
      if (n <= 0 || locked.has(t)) continue;
      // My commander's territory next to an enemy at the start of the turn keeps its armies,
      // even when this turn's captures make it interior: a capture can still fail. So does one
      // next to a border the plan concedes (#121): the enemy takes it next, and then faces it.
      if (
        myCommanders.has(t) &&
        neighborsOf(g, t).some((x) => (ownerOf(x) ?? me) !== me || conceded.has(x))
      )
        continue;
      const d = dist.get(t);
      if (d === undefined || d <= 1) continue;
      // Only into a territory held at the start of the turn: a planned capture is
      // not mine yet, and a "transfer" into it would execute as an attack.
      // B2 (T5): never onto a truce's capped border past its cap, nor back along a transfer.
      const step = neighborsOf(g, t)
        .filter(
          (x) =>
            mineSet.has(x) &&
            (via ? viaOk(x) : !conceded.has(x)) &&
            (dist.get(x) ?? Infinity) < d &&
            capStepRoom(pc, ps, t, x) > 0,
        )
        .sort((a, b) => dist.get(a)! - dist.get(b)! || a - b)[0];
      if (step === undefined) continue;
      const { pending, ifFail, twoStep, truceHold, keep } = keepOf(t);
      // No-Split (#124): a transfer sends the whole stack, so one that must keep some sends none.
      const room = capStepRoom(pc, ps, t, step);
      const part = Math.min(n, Math.max(0, stayAt(t) - keep), room);
      const k = noSplit && part < n ? 0 : part;
      if (k <= 0) {
        if (twoStep)
          rationale.push(
            twoStepCite(t, twoStep, (c) => `Keep the ${n} idle armies on ${label(t)}: ${c}.`, `Keep the ${n} idle armies on ${label(t)}.`),
          );
        else if (pending.length)
          rationale.push(
            `Keep the ${n} idle armies on ${label(t)}: it is interior only once ${pending.map(label).join(', ')} falls, and until then they hold it against ~${ifFail!.threat}.`,
          );
        continue;
      }
      if (orderOf(t)) {
        warnSplit(t, `its ${k} idle armies are not transferred to ${label(step)}`);
        continue;
      }
      avail.set(t, n - k);
      const reason = 'moves idle interior armies toward the front';
      transfer(t, step, k, reason);
      arrived.set(step, (arrived.get(step) ?? 0) + k);
      // #260: say why a step goes toward a front past a conceded border, and what it heads for.
      let front = '';
      if (via) {
        const targets = attacksFrom(step);
        const beside = neighborsOf(g, step).filter((x) => !held.has(x) && isEnemy(x)).sort((a, b) => a - b);
        // An attack target that lands for sure is held, so it is not the front beside the step.
        const landing = targets.filter((x) => !beside.includes(x));
        front = ` (the enemy front${beside.length ? `, ${beside.map(label).join(', ')},` : ''} is reached ${distEnemy.has(t) ? `soonest (${distEnemyVia.get(t)} steps against ${distEnemy.get(t)} any other way)` : 'only'} through a border the plan concedes, and no farther than the nearest territory not mine${
          conceded.has(step)
            ? `; ${label(step)} is the border the plan attacks ${targets.map(label).join(', ')} from${
                landing.length ? ` (${landing.map(label).join(', ')}, a capture that lands this turn, not the front)` : ''
              }; they are lost with it if it falls`
            : ''
        })`;
      }
      if (via && conceded.has(step)) {
        const v = viaInto.get(step) ?? { from: [], lines: [] };
        v.from.push(t);
        v.lines.push({ i: rationale.length, front });
        viaInto.set(step, v);
      }
      rationale.push(
        `Transfer ${k} from ${label(t)} to ${label(step)}: ${reason}${front}${
          k < n && k === room
            ? ` (the rest stay: a truce caps the armies on ${label(step)} at what this leaves there)`
            : k < n && twoStep
            ? twoStepCite(t, twoStep, (c) => ` (the rest stay: ${c})`)
            : k < n && !ifFail && centralKeep.has(t)
            ? ` (the ${centralKeep.get(t)!} of the leftover kept central stay)`
            : k < n && !ifFail && truceHold > 0
            ? ` (${truceHold} stay: they hold it beside a truce's covered territory)`
            : k < n
            ? ` (${stayAt(t)} stay: it is interior only once ${pending.map(label).join(', ')} falls, and until then they hold it against ~${ifFail!.threat})`
            : ''
        }.`,
      );
    }
    // #260 (review): what the via steps landed may make a conceded border hold — two idle stacks
    // each too small to revive it alone (#257) — and then it is held, not conceded: the plan says
    // so as #257 does, and its "cannot be held" warning goes. One they leave short stays conceded.
    for (const [id, v] of [...viaInto].sort((a, b) => a[0] - b[0])) {
      const threat = borders.get(id)?.threat;
      if (threat === undefined) continue;
      const total = stayAt(id) + (arrived.get(id) ?? 0) + unitsAt(id);
      if ((toTake(total) ?? Infinity) <= threat) continue;
      conceded.delete(id);
      locked.add(id);
      const conceding = `${label(id)} cannot be held `;
      for (let i = warnings.length - 1; i >= 0; i--)
        if (warnings[i]!.startsWith(conceding) && warnings[i]!.endsWith(': conceded')) warnings.splice(i, 1);
      const sent = moves.filter((m) => m.kind === 'transfer' && m.to === id && v.from.includes(m.from)).reduce((n, m) => n + m.armies, 0);
      for (const { i, front } of v.lines)
        rationale[i] = rationale[i]!.replace(front, ` (into ${label(id)}, which these transfers make hold: it is held after all)`);
      const value = threatened.find((x) => x.id === id)?.value ?? 0;
      const from = attacksFrom(id);
      rationale.push(
        `Hold ${label(id)} after all (not conceded): the ${sent} idle armies transferred into it from ${v.from
          .slice()
          .sort((a, b) => a - b)
          .map(label)
          .join(', ')} make it hold together (${total} armies need ${toTake(total)} to take, above the ~${threat} threat; protects +${value})${
          from.length ? `; the border the plan attacks ${from.map(label).join(', ')} from` : ''
        }. They land only once the transfers run, so the border holds only if they run before the attack on it.`,
      );
    }
  }
}
