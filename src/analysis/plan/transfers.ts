// Rule 6, the transfers (#121, #124, #125, #128, #172, #179; #133): once every deploy, attack and
// withdrawal is planned, idle armies move one step toward the front — the enemy front first, else
// the nearest territory not mine — never into or through a conceded border, and keeping what a
// territory beside a pending capture, a stack two steps away or a finished-off player's exit needs.
// First (#125) idle armies facing no visible enemy stage one step toward the source of the step
// the leftover deploy saved toward. planPass runs it where it ran before: after the efficient
// sizes (S2), before Order Priority for a strike (rule 1s).
import { bfsDistances, neighborsOf } from '../graph.js';
import type { Captures } from './captures.js';
import type { Holds } from './holds.js';
import type { Staging } from './leftover.js';
import type { DeployBook } from './orders.js';
import type { PlanCtx, PlanState } from './state.js';
import type { Threats } from './threats.js';
import { truceKeep } from './relations.js';

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
  const { g, me, s, foe, territories: state, label, bonusName, mine, mineSet, unitsAt, noSplit, myCommanders } = pc;
  const { rationale, avail, locked, coverKeep, centralKeep, captured, moves } = ps;
  const { guardAt, coverOf, orderOf, warnSplit } = book;
  const { holdArmies, borderAt, ownerOf } = threats;
  const { arrived, conceded, stayAt, twoStepCite, twoStepHold, twoStepKeep } = hd;
  const { strikes, worstCase } = caps;
  if (s.allowTransferOnly ?? true) {
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
    // B2 (T4): a truce's covered territory is no front.
    const isEnemy = (id: number) => {
      const st = state.get(id);
      return st?.owner.kind === 'player' && foe(st.owner.playerId) && !pc.truce.noTarget(id);
    };
    // Enemy front first (#121): idle armies head for the territories a visible enemy holds; only
    // with no enemy reachable do they head for the nearest territory not mine (neutral or fog).
    const ids = [...g.territoryById.keys()];
    const enemyFront = ids.filter((id) => !held.has(id) && isEnemy(id));
    const anyFront = ids.filter((id) => !held.has(id) && !pc.truce.noTarget(id));
    const distEnemy = bfsDistances(g, enemyFront, { passable });
    const distAny = bfsDistances(g, anyFront, { passable });
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
        const step = neighborsOf(g, t)
          .filter((x) => mineSet.has(x) && !conceded.has(x) && (distStage.get(x) ?? Infinity) < d)
          .sort((a, b) => distStage.get(a)! - distStage.get(b)! || a - b)[0];
        if (step === undefined) continue;
        // #172: what a stack two steps away needs it to keep stays (the step below says so).
        const far = twoStepHold(t);
        // #179: nor what covers a finished-off player's exit.
        const k = n - Math.max(twoStepKeep(t), coverOf(t), centralKeep.get(t) ?? 0, truceKeep(pc, threats, t) - guardAt(t));
        // No-Split (#124): the whole stack or nothing.
        if (k <= 0 || (noSplit && k < n)) continue;
        if (orderOf(t)) {
          warnSplit(t, `its ${k} idle armies do not stage toward ${label(st.t)}`);
          continue;
        }
        avail.set(t, n - k);
        const reason = `stages toward ${label(st.t)}, the next step of bonus ${bonusName(st.bonusId)}`;
        moves.push({ from: t, to: step, armies: k, kind: 'transfer', reason });
        arrived.set(step, (arrived.get(step) ?? 0) + k);
        rationale.push(
          `Move ${k} from ${label(t)} to ${label(step)}: ${reason} (${st.cost} to take from ${label(st.from)}, not affordable this turn)${
            k < n && far ? twoStepCite(t, far, (c) => `; the rest stay: ${c}`) : ''
          }.`,
        );
      }
    }
    for (const t of mine) {
      const dist = distEnemy.has(t) ? distEnemy : distAny;
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
      const step = neighborsOf(g, t)
        .filter((x) => mineSet.has(x) && !conceded.has(x) && (dist.get(x) ?? Infinity) < d)
        .sort((a, b) => dist.get(a)! - dist.get(b)! || a - b)[0];
      if (step === undefined) continue;
      // #128: interior only if this turn's attacks on players beside it land. Until they do, it
      // keeps what holds against the threat there as if they failed (its neighbours' owners'
      // stacks and deploy as they stand): a +12 bonus was left on 1 beside a capture.
      const pending = neighborsOf(g, t).filter((x) => captured.has(x) && state.get(x)?.owner.kind === 'player');
      const ifFail = pending.length ? borderAt(t, () => false) : null;
      const keep128 = ifFail ? Math.max(0, holdArmies(ifFail.threat) - unitsAt(t)) : 0;
      // #172: or it is interior now, but a stack two steps away can take the territory in between
      // this turn and attack it next. The larger hold binds (never the two added together).
      const far = twoStepHold(t);
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
      // No-Split (#124): a transfer sends the whole stack, so one that must keep some sends none.
      const part = Math.min(n, Math.max(0, stayAt(t) - keep));
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
      moves.push({ from: t, to: step, armies: k, kind: 'transfer', reason });
      arrived.set(step, (arrived.get(step) ?? 0) + k);
      rationale.push(
        `Transfer ${k} from ${label(t)} to ${label(step)}: ${reason}${
          k < n && twoStep
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
  }
}
