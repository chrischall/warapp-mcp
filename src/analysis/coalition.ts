// Before surrendering a free-for-all, whether a coalition against the leader is viable and with whom (#445,
// owner 2026-11-20: "reach out to the weaker players and team up"). Pure, advice only: it never sends a
// message and never changes a plan. The grace window is the owner's to set (`COALITION_GRACE_TURNS`, the
// issue's suggested 2); the planner does not count it, the tool says it.

/** Turns the coalition attempt gets before the surrender advice returns (#445's suggestion; the owner may change it). */
export const COALITION_GRACE_TURNS = 2;

export interface CoalitionRow {
  playerId: number;
  armies: number;
  income: number;
}

export interface CoalitionPartner {
  playerId: number;
  income: number;
  armies: number;
  /** It borders the leader on this board: it can hit it, and it has reason to. */
  bordersLeader: boolean;
}

export interface CoalitionAdvice {
  /** Trailing players together (me included) earn at least the leader. */
  viable: boolean;
  leader: number;
  leaderIncome: number;
  /** Mine plus every candidate's income. */
  trailingIncome: number;
  /** Candidates, those bordering the leader first, then by income (largest), then id. */
  partners: CoalitionPartner[];
  graceTurns: number;
  /** One line for the owner. */
  advice: string;
  /** An honest first message to the best partner: the shared threat in words, no figure, no promise beyond what is said. */
  draft?: string;
}

/**
 * `rows`: every player in sight with its armies and income estimate (the profile's FFA ranking). `me`: my id.
 * `bordersLeader`: the players with a territory beside the leader's. `excluded`: players ruled out (an agreement
 * broken against me, at war with me, out of the game). Returns `null` outside a free-for-all of three or more
 * (a 1v1 goes straight to the surrender advice) or when I lead.
 */
export function coalitionAdvice(input: {
  rows: readonly CoalitionRow[];
  me: number;
  leader: number;
  bordersLeader: ReadonlySet<number>;
  excluded?: ReadonlySet<number>;
}): CoalitionAdvice | null {
  const { rows, me, leader } = input;
  if (rows.length < 3 || leader === me) return null;
  const lead = rows.find((r) => r.playerId === leader);
  const mine = rows.find((r) => r.playerId === me);
  if (!lead || !mine) return null;
  const partners: CoalitionPartner[] = rows
    .filter((r) => r.playerId !== me && r.playerId !== leader && !input.excluded?.has(r.playerId))
    .map((r) => ({ playerId: r.playerId, income: r.income, armies: r.armies, bordersLeader: input.bordersLeader.has(r.playerId) }))
    .sort((a, b) => Number(b.bordersLeader) - Number(a.bordersLeader) || b.income - a.income || a.playerId - b.playerId);
  const trailingIncome = mine.income + partners.reduce((n, p) => n + p.income, 0);
  const viable = partners.length > 0 && trailingIncome >= lead.income;
  const best = partners.find((p) => p.bordersLeader) ?? partners[0];
  const advice = viable
    ? `Try a coalition first: the trailing players together earn ~${trailingIncome} against player ${leader}'s ~${lead.income}${best ? `; player ${best.playerId} is the best partner${best.bordersLeader ? ' (it borders the leader)' : ''}` : ''}. Give it ${COALITION_GRACE_TURNS} turns; if nobody agrees, or the leader's lead keeps growing, the surrender advice stands (advice only; the server sends nothing).`
    : `No coalition looks viable: the trailing players together earn ~${trailingIncome} against player ${leader}'s ~${lead.income}${partners.length ? '' : ' and there is no one left to ask'}, so the surrender advice stands.`;
  return {
    viable,
    leader,
    leaderIncome: lead.income,
    trailingIncome,
    partners,
    graceTurns: COALITION_GRACE_TURNS,
    advice,
    ...(viable && best
      ? {
          draft: `Player ${leader} is ahead of both of us and I would rather it not take either of us next. Would you be willing to hold off attacking each other and to press ${best.bordersLeader ? 'it on the border we share' : 'it where you can'}? I will tell you before I change that.`,
        }
      : {}),
  };
}
