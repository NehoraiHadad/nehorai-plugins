/**
 * Close-order scenarios for holds backed by expired credits, shared by the memory
 * and Firestore suites so both adapters answer to the same table.
 *
 * Each scenario builds an account and leaves holds open. The driver then closes
 * them in every order, for every assignment of outcomes, on a fresh account each
 * time: the required invariant is that one assignment has one final state.
 */
export type Close = "commit" | "release" | "expire";

export type Step =
  | { op: "hold"; name: string; amount: number }
  /** The subscription-expiry downgrade, with the repo's downgrade cap. */
  | { op: "downgrade" }
  /** `updateUserTier` with `balanceCap`. */
  | { op: "cap"; cap: number }
  /** `updateUserTier` with an absolute `balance`. */
  | { op: "tierBalance"; balance: number }
  | { op: "absoluteBalance"; balance: number }
  | { op: "balanceIncrement"; amount: number }
  /** A monthly reset, resolved by the repo's `resolveMonthlyReset`. */
  | { op: "reset" }
  | { op: "bonus"; amount: number }
  | { op: "deduct"; amount: number };

export interface Scenario {
  name: string;
  balance: number;
  bonusCredits?: number;
  /** What `getDowngradeBalanceCap` answers. */
  downgradeCap?: number;
  /** What `resolveMonthlyReset` answers. */
  resetBalance?: number;
  steps: Step[];
  /** Outcomes to enumerate. Defaults to commit and release. */
  closes?: Close[];
  /** Pinned final `balance + bonusCredits`, keyed like `old:commit,new:release`. */
  expected?: Record<string, number>;
}

export interface FinalState {
  balance: number;
  bonusCredits: number;
  reserved: number;
  expiredHoldBacking: number;
}

export const SCENARIOS: Scenario[] = [
  {
    name: "a hold placed after the expiry leaves the older backing alone",
    balance: 100,
    downgradeCap: 0,
    closes: ["commit", "release", "expire"],
    steps: [
      { op: "hold", name: "old", amount: 80 },
      { op: "downgrade" },
      { op: "bonus", amount: 100 },
      { op: "hold", name: "new", amount: 10 },
    ],
    expected: {
      "old:commit,new:release": 100,
      "old:commit,new:expire": 100,
      "old:commit,new:commit": 90,
      "old:release,new:release": 100,
      "old:release,new:commit": 90,
    },
  },
  {
    name: "an admin deduct lands on spendable credits, not expired ones",
    balance: 100,
    bonusCredits: 50,
    downgradeCap: 0,
    closes: ["commit", "release", "expire"],
    steps: [
      { op: "hold", name: "old", amount: 80 },
      { op: "downgrade" },
      { op: "bonus", amount: 40 },
      { op: "deduct", amount: 20 },
    ],
    expected: {
      // Balance 30 is all expired, so the 20 comes out of the bonus: 90 -> 70.
      "old:release": 70,
      "old:expire": 70,
      // 30 expired + 50 bonus pay the hold, 20 bonus remains.
      "old:commit": 20,
    },
  },
  {
    name: "two old holds share the backing the same way in either order",
    balance: 100,
    downgradeCap: 20,
    steps: [
      { op: "hold", name: "a", amount: 50 },
      { op: "hold", name: "b", amount: 30 },
      { op: "downgrade" },
    ],
    expected: {
      // Spendable 20, marked 60: a holds 50 of it, b holds 10.
      "a:commit,b:release": 20,
      "a:release,b:commit": 0,
      "a:commit,b:commit": 0,
      "a:release,b:release": 20,
    },
  },
  {
    name: "old and new holds, with bonus covering part of the old ones",
    balance: 100,
    bonusCredits: 30,
    downgradeCap: 10,
    steps: [
      { op: "hold", name: "a", amount: 60 },
      { op: "hold", name: "b", amount: 40 },
      { op: "downgrade" },
      { op: "bonus", amount: 25 },
      { op: "hold", name: "c", amount: 20 },
    ],
  },
  {
    name: "a repeated cap changes nothing and never moves backing to a newer hold",
    balance: 100,
    steps: [
      { op: "hold", name: "a", amount: 20 },
      { op: "cap", cap: 0 },
      { op: "bonus", amount: 100 },
      { op: "hold", name: "b", amount: 20 },
      { op: "cap", cap: 0 },
    ],
    expected: {
      // a keeps its 20, so its own close removes them. b is paid from the bonus.
      "a:release,b:commit": 80,
      "a:commit,b:release": 100,
      "a:commit,b:commit": 80,
      "a:release,b:release": 100,
    },
  },
  {
    name: "a cap taken in two steps attributes across holds oldest first",
    balance: 100,
    steps: [
      { op: "hold", name: "a", amount: 50 },
      { op: "cap", cap: 60 },
      { op: "hold", name: "b", amount: 10 },
      { op: "cap", cap: 0 },
    ],
  },
  {
    name: "a reset below the holds re-marks what it kept",
    balance: 100,
    bonusCredits: 10,
    resetBalance: 5,
    steps: [
      { op: "hold", name: "a", amount: 40 },
      { op: "hold", name: "b", amount: 30 },
      { op: "cap", cap: 0 },
      { op: "reset" },
    ],
  },
  {
    name: "a reset above the holds clears the marks",
    balance: 100,
    resetBalance: 90,
    steps: [
      { op: "hold", name: "a", amount: 40 },
      { op: "cap", cap: 0 },
      { op: "bonus", amount: 15 },
      { op: "hold", name: "b", amount: 15 },
      { op: "reset" },
    ],
    expected: { "a:release,b:release": 105, "a:commit,b:commit": 50 },
  },
  {
    name: "a tier write with an absolute balance re-marks across holds",
    balance: 100,
    steps: [
      { op: "hold", name: "a", amount: 30 },
      { op: "hold", name: "b", amount: 30 },
      { op: "cap", cap: 0 },
      { op: "tierBalance", balance: 40 },
    ],
  },
  {
    name: "an absolute balance write clears the marks on the holds too",
    balance: 100,
    steps: [
      { op: "hold", name: "a", amount: 30 },
      { op: "cap", cap: 0 },
      { op: "absoluteBalance", balance: 70 },
    ],
    expected: { "a:release": 70, "a:commit": 40 },
  },
  {
    name: "a charge on valid credits above the mark leaves the backing alone",
    balance: 100,
    steps: [
      { op: "hold", name: "a", amount: 30 },
      { op: "hold", name: "b", amount: 30 },
      { op: "cap", cap: 0 },
      { op: "bonus", amount: 60 },
      { op: "balanceIncrement", amount: 40 },
      { op: "balanceIncrement", amount: -25 },
    ],
  },
];

export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length < 2) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ])
  );
}

function assignments(names: string[], closes: Close[]): Record<string, Close>[] {
  return names.reduce<Record<string, Close>[]>(
    (all, name) => all.flatMap((partial) => closes.map((c) => ({ ...partial, [name]: c }))),
    [{}]
  );
}

/** The ledger invariants, checked after every scenario has built its holds. */
async function invariantProblems(repo: any, userId: string, holds: Record<string, string>) {
  const credits = await repo.getUserCredits(userId);
  const total = credits.expiredHoldBacking ?? 0;
  const problems: string[] = [];
  let shares = 0;
  for (const [name, id] of Object.entries(holds)) {
    const hold = await repo.getReservation(userId, id);
    const share = hold.expiredBacking ?? 0;
    shares = Math.round((shares + share) * 100) / 100;
    if (hold.status === "reserved" && (share < 0 || share > hold.amount)) {
      problems.push(`${name} has share ${share} of ${hold.amount}`);
    }
  }
  if (total !== shares) problems.push(`total ${total} is not the sum of shares ${shares}`);
  if (total < 0 || total > credits.balance) {
    problems.push(`total ${total} outside balance ${credits.balance}`);
  }
  return problems;
}

/**
 * A negative increment cannot take the balance below 0 or through the floor holds put
 * under it. It is refused and changes nothing, on every adapter.
 */
export async function checkIncrementGuard(repo: any, userId: string): Promise<void> {
  const fail = (message: string) => {
    throw new Error(message);
  };
  const state = async () => {
    const c = await repo.getUserCredits(userId);
    return [c.balance, c.bonusCredits, c.reserved, c.expiredHoldBacking ?? 0].join(",");
  };
  const placeHold = async (amount: number) => {
    const made = await repo.reserveCreditsV2({
      userId,
      amount,
      operationType: "story_generation",
      expiresAt: new Date(Date.now() + 60_000),
    });
    if (made.outcome !== "created") fail(`no hold: ${made.outcome}`);
    return made.reservation.id;
  };
  const refused = async (update: Record<string, number>) => {
    const before = await state();
    const accepted = await repo.updateUserCredits(userId, update).then(
      () => true,
      () => false
    );
    if (accepted) fail(`accepted ${JSON.stringify(update)}: ${await state()}`);
    if ((await state()) !== before) fail(`refused ${JSON.stringify(update)} still wrote`);
  };

  await repo.initializeUserCredits(userId, "premium", 100);
  const old = await placeHold(80);
  await repo.updateUserTier(userId, { tier: "premium", monthlyLimit: 500, balanceCap: 0 });
  if ((await state()) !== "80,0,80,80") fail(`after the cap: ${await state()}`);

  // Through the floor: the holds need all 80.
  await refused({ balanceIncrement: -1 });
  await repo.updateUserCredits(userId, { bonusCreditsIncrement: 100 });
  // The floor is 0 now, but the balance cannot go below it.
  await refused({ balanceIncrement: -90 });
  await refused({ balance: 1000, balanceIncrement: -1090 });
  await refused({ bonusCreditsIncrement: -101 });

  await repo.releaseReservationV2(userId, old);
  if ((await state()) !== "0,100,0,0") fail(`after the release: ${await state()}`);
  for (let i = 0; i < 3; i += 1) {
    await repo.releaseReservationV2(userId, await placeHold(10));
    if ((await state()) !== "0,100,0,0") fail(`free credits after a release: ${await state()}`);
  }

  // An increment within the floor still works, and an absolute seeds the sum.
  await repo.updateUserCredits(userId, { balance: 50, balanceIncrement: -20 });
  if ((await state()) !== "30,100,0,0") fail(`after absolute + increment: ${await state()}`);

  // Each field on its own, where the floor would not catch it.
  await refused({ bonusCreditsIncrement: -101 });
  await refused({ reservedIncrement: -1 });
}

/**
 * A negative increment is a charge, so it can only draw on valid credits. Marked credits
 * are expired and belong to their hold: charging them would hand the charge back when
 * the hold releases. Bonus credits are valid, so drawing on them leaves the marks alone.
 * An absolute balance states the whole field, so it clears the marks with their shares.
 */
export async function checkIncrementSparesBacking(repo: any, userId: string): Promise<void> {
  await repo.initializeUserCredits(userId, "premium", 100);
  const made = await repo.reserveCreditsV2({
    userId,
    amount: 80,
    operationType: "story_generation",
    expiresAt: new Date(Date.now() + 60_000),
  });
  if (made.outcome !== "created") throw new Error(`no hold: ${made.outcome}`);
  const id = made.reservation.id;
  const state = async () => {
    const c = await repo.getUserCredits(userId);
    const share = (await repo.getReservation(userId, id)).expiredBacking ?? 0;
    return [c.balance, c.bonusCredits, c.reserved, c.expiredHoldBacking ?? 0, share].join(",");
  };
  const expectState = async (step: string, expected: string) => {
    const actual = await state();
    if (actual !== expected) throw new Error(`${step}: ${actual}, expected ${expected}`);
  };
  const refused = async (update: Record<string, number>) => {
    const before = await state();
    const accepted = await repo.updateUserCredits(userId, update).then(
      () => true,
      () => false
    );
    if (accepted) throw new Error(`accepted ${JSON.stringify(update)}: ${await state()}`);
    await expectState(`refused ${JSON.stringify(update)}`, before);
  };

  await repo.updateUserTier(userId, { tier: "premium", monthlyLimit: 500, balanceCap: 0 });
  await repo.updateUserCredits(userId, { bonusCreditsIncrement: 100 });
  await expectState("before the charge", "80,100,80,80,80");

  // Nothing valid in the balance: the bonus would cover the floor, not the charge.
  await refused({ balanceIncrement: -30 });
  await refused({ balanceIncrement: -0.01 });

  // Valid credits above the marks can be charged, to the cent and no further.
  await repo.updateUserCredits(userId, { balanceIncrement: 50 });
  await refused({ balanceIncrement: -50.01 });
  await repo.updateUserCredits(userId, { balanceIncrement: -50 });
  await expectState("after a valid charge", "80,100,80,80,80");

  await repo.updateUserCredits(userId, { bonusCreditsIncrement: -50 });
  await expectState("after a bonus charge", "80,50,80,80,80");

  await repo.releaseReservationV2(userId, id);
  await expectState("after the release", "0,50,0,0,80");
}

/** An absolute balance replaces the field: total and shares clear together. */
export async function checkAbsoluteBalanceClearsBacking(repo: any, userId: string): Promise<void> {
  await repo.initializeUserCredits(userId, "premium", 100);
  const made = await repo.reserveCreditsV2({
    userId,
    amount: 80,
    operationType: "story_generation",
    expiresAt: new Date(Date.now() + 60_000),
  });
  if (made.outcome !== "created") throw new Error(`no hold: ${made.outcome}`);
  const id = made.reservation.id;
  await repo.updateUserTier(userId, { tier: "premium", monthlyLimit: 500, balanceCap: 0 });
  await repo.updateUserCredits(userId, { bonusCreditsIncrement: 100 });
  // The increment applies to the absolute, which replaced the marks, so they don't limit it.
  await repo.updateUserCredits(userId, { balance: 90, balanceIncrement: -30 });
  const credits = await repo.getUserCredits(userId);
  const share = (await repo.getReservation(userId, id)).expiredBacking ?? 0;
  if (credits.balance !== 60 || (credits.expiredHoldBacking ?? 0) !== 0 || share !== 0) {
    throw new Error(`${credits.balance},${credits.expiredHoldBacking},${share}`);
  }
  await repo.releaseReservationV2(userId, id);
  if ((await repo.getUserCredits(userId)).balance !== 60) {
    throw new Error(`absolute balance moved on release`);
  }
}

/**
 * `reserved` not made of placed holds: a floor can keep more than the holds can carry.
 * The total stays the sum of the shares, and `reserved` keeps the rest out of reach.
 */
export async function checkReservedWithoutHolds(repo: any, userId: string): Promise<void> {
  await repo.initializeUserCredits(userId, "premium", 100);
  await repo.updateUserCredits(userId, { reservedIncrement: 20 });
  const made = await repo.reserveCreditsV2({
    userId,
    amount: 30,
    operationType: "story_generation",
    expiresAt: new Date(Date.now() + 60_000),
  });
  await repo.updateUserTier(userId, { tier: "premium", monthlyLimit: 500, balanceCap: 0 });
  const state = async () => {
    const c = await repo.getUserCredits(userId);
    return [c.balance, c.reserved, c.expiredHoldBacking ?? 0].join(",");
  };
  if ((await state()) !== "50,50,30") throw new Error(`after the cap: ${await state()}`);
  await repo.releaseReservationV2(userId, made.reservation.id);
  if ((await state()) !== "20,20,0") throw new Error(`after the release: ${await state()}`);
}

const past = () => new Date(Date.now() - 86_400_000).toISOString();
const longAgo = () => new Date(Date.now() - 400 * 86_400_000).toISOString();

/** Run one scenario up to the point where the holds are open. */
async function build(repo: any, userId: string, scenario: Scenario) {
  await repo.initializeUserCredits(userId, "premium", scenario.balance);
  await repo.updateUserCredits(userId, { bonusCredits: scenario.bonusCredits ?? 0 });
  const holds: Record<string, string> = {};
  for (const step of scenario.steps) {
    switch (step.op) {
      case "hold": {
        // Holds are attributed oldest first by the millisecond they were placed. Two
        // in one millisecond fall back to their random ids, which is stable for one
        // account but differs across the fresh accounts this driver compares.
        await new Promise((resolve) => setTimeout(resolve, 2));
        const made = await repo.reserveCreditsV2({
          userId,
          amount: step.amount,
          operationType: "story_generation",
          expiresAt: new Date(Date.now() + 60_000),
        });
        if (made.outcome !== "created") throw new Error(`no hold ${step.name}: ${made.outcome}`);
        holds[step.name] = made.reservation.id;
        break;
      }
      case "downgrade": {
        await repo.updateUserCredits(userId, { subscriptionExpiresAt: longAgo() });
        const result = await repo.checkAndHandleSubscriptionExpiry(userId, 3);
        if (!result.wasDowngraded) throw new Error("expected a downgrade");
        break;
      }
      case "cap":
        await repo.updateUserTier(userId, {
          tier: "premium",
          monthlyLimit: 500,
          balanceCap: step.cap,
        });
        break;
      case "tierBalance":
        await repo.updateUserTier(userId, {
          tier: "premium",
          monthlyLimit: 500,
          balance: step.balance,
        });
        break;
      case "absoluteBalance":
        await repo.updateUserCredits(userId, { balance: step.balance });
        break;
      case "balanceIncrement":
        await repo.updateUserCredits(userId, { balanceIncrement: step.amount });
        break;
      case "reset": {
        const expected = past();
        await repo.updateUserCredits(userId, { monthlyResetAt: expected });
        const result = await repo.atomicMonthlyReset(userId, "premium", expected);
        if (!result.wasReset) throw new Error("expected a reset");
        break;
      }
      case "bonus":
        await repo.updateUserCredits(userId, { bonusCreditsIncrement: step.amount });
        break;
      case "deduct":
        await repo.deductCreditsAtomic(userId, step.amount);
        break;
    }
  }
  return holds;
}

async function close(repo: any, userId: string, reservationId: string, how: Close) {
  const result =
    how === "commit"
      ? await repo.commitReservationV2(userId, reservationId)
      : how === "release"
        ? await repo.releaseReservationV2(userId, reservationId)
        : await repo.expireReservationV2(userId, reservationId, {
            asOf: new Date(Date.now() + 120_000),
          });
  const wanted = { commit: "committed", release: "released", expire: "expired" }[how];
  if (result.outcome !== wanted) throw new Error(`${how} answered ${result.outcome}`);
}

/**
 * Every order of every outcome assignment. Returns what went wrong, one line each,
 * so a failure names the case instead of a boolean.
 */
export async function checkScenario(
  scenario: Scenario,
  makeRepo: (options: Record<string, unknown>) => any,
  newUser: () => string
): Promise<string[]> {
  const repo = makeRepo({
    ...(scenario.downgradeCap !== undefined
      ? { getDowngradeBalanceCap: () => scenario.downgradeCap }
      : {}),
    ...(scenario.resetBalance !== undefined
      ? { resolveMonthlyReset: () => ({ balance: scenario.resetBalance }) }
      : {}),
  });
  const names = scenario.steps.flatMap((step) => (step.op === "hold" ? [step.name] : []));
  const problems: string[] = [];

  // One account at a time: the emulator's transaction locks are far coarser than
  // production's and time out under hundreds of unrelated concurrent transactions.
  for (const assignment of assignments(names, scenario.closes ?? ["commit", "release"])) {
    const label = names.map((name) => `${name}:${assignment[name]}`).join(",");
    const finals: { order: string; state: FinalState }[] = [];
    for (const order of permutations(names)) {
      const userId = newUser();
      const holds = await build(repo, userId, scenario);
      problems.push(...(await invariantProblems(repo, userId, holds)).map((p) => `${label}: ${p}`));
      try {
        for (const name of order) await close(repo, userId, holds[name], assignment[name]);
      } catch (error) {
        problems.push(`${label}: ${order.join(">")} threw ${(error as Error).message}`);
      }
      const credits = await repo.getUserCredits(userId);
      finals.push({
        order: order.join(">"),
        state: {
          balance: credits.balance,
          bonusCredits: credits.bonusCredits,
          reserved: credits.reserved,
          expiredHoldBacking: credits.expiredHoldBacking ?? 0,
        },
      });
    }

    const first = JSON.stringify(finals[0].state);
    for (const { order, state } of finals) {
      if (JSON.stringify(state) !== first) {
        problems.push(`${label}: ${order} gave ${JSON.stringify(state)}, not ${first}`);
      }
      if (state.reserved !== 0 || state.expiredHoldBacking !== 0) {
        problems.push(`${label}: ${order} left ${JSON.stringify(state)}`);
      }
    }
    const pinned = scenario.expected?.[label];
    const total = finals[0].state.balance + finals[0].state.bonusCredits;
    if (pinned !== undefined && total !== pinned) {
      problems.push(`${label}: total ${total}, expected ${pinned}`);
    }
  }
  return problems;
}
