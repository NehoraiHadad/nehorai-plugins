/**
 * Where the shared amount and key validators actually apply.
 *
 * The claim in the changelog is that a credit amount is checked at every public
 * entry point that writes one, not just at the service's front door — so this
 * goes in through the service *and* straight at the repository, which is what a
 * direct adapter caller does.
 */

import { describe, expect, it } from "vitest";
import {
  CreditErrorCode,
  CreditsService,
  createInMemoryCreditRepository,
  getConfigMonthlyLimit,
  storedMonthlyLimit,
} from "../../src/index.js";

const USER = "u-validate";
const OP = "story_generation";

/** Values a `numeric(12, 2)` credit column can never faithfully hold. */
const UNSPENDABLE: Array<[string, number]> = [
  ["zero", 0],
  ["negative", -1],
  ["a third of a cent", 1.005],
  ["past the column range", 1e12],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
];

/** Values that are exactly representable and must keep working. */
const SPENDABLE = [0.01, 1, 25.5, 9999999999.99];

async function ready() {
  const repo = createInMemoryCreditRepository();
  await repo.initializeUserCredits(USER, "free", 100);
  return { repo, service: new CreditsService(repo) };
}

describe("credit amount validation", () => {
  for (const [label, amount] of UNSPENDABLE) {
    it(`rejects ${label} at every public writer`, async () => {
      const { repo, service } = await ready();
      const invalid = { code: CreditErrorCode.INVALID_AMOUNT };

      await expect(service.deductCredits(USER, amount)).rejects.toMatchObject(invalid);
      await expect(service.addCredits(USER, amount, "top-up")).rejects.toMatchObject(invalid);
      await expect(repo.deductCreditsAtomic(USER, amount)).rejects.toMatchObject(invalid);
      await expect(repo.addCreditsAtomic(USER, amount, "top-up")).rejects.toMatchObject(invalid);
      await expect(
        repo.createReservation({
          userId: USER,
          amount,
          operationType: OP,
          expiresAt: new Date(Date.now() + 60_000),
        })
      ).rejects.toMatchObject(invalid);
    });

    it(`leaves the balance untouched after rejecting ${label}`, async () => {
      const { repo, service } = await ready();
      await service.deductCredits(USER, amount).catch(() => undefined);
      await service.addCredits(USER, amount, "top-up").catch(() => undefined);
      const credits = await repo.getUserCredits(USER);
      expect(credits?.balance).toBe(100);
      expect(credits?.reserved).toBe(0);
    });
  }

  it("still accepts amounts on the cent grid", async () => {
    for (const amount of SPENDABLE) {
      const { repo } = await ready();
      await expect(
        repo.createReservation({
          userId: USER,
          amount,
          operationType: OP,
          expiresAt: new Date(Date.now() + 60_000),
        })
      ).resolves.toMatchObject({ amount });
    }
  });
});

describe("idempotency key validation", () => {
  const BAD_KEYS = ["", "   ", "\t\n"];

  for (const key of BAD_KEYS) {
    it(`rejects ${JSON.stringify(key)} rather than treating it as absent`, async () => {
      const { repo } = await ready();
      // `createReservation` refuses *every* key, blank or not: it writes the
      // row without placing the hold, so it can never honour one. The specific
      // complaint about blankness therefore only belongs on the V2 path.
      await expect(
        repo.createReservation({
          userId: USER,
          amount: 5,
          operationType: OP,
          expiresAt: new Date(Date.now() + 60_000),
          idempotencyKey: key,
        })
      ).rejects.toMatchObject({ code: CreditErrorCode.UNSUPPORTED_OPERATION });

      await expect(
        repo.reserveCreditsV2({
          userId: USER,
          amount: 5,
          operationType: OP,
          expiresAt: new Date(Date.now() + 60_000),
          idempotencyKey: key,
        })
      ).rejects.toMatchObject({ code: CreditErrorCode.INVALID_IDEMPOTENCY_KEY });
    });
  }

  it("does not trim a key that only looks like another one", async () => {
    // Normalising " job-1 " to "job-1" would silently share a hold between two
    // callers who each believe they own a distinct key.
    const { repo } = await ready();
    const first = await repo.reserveCreditsV2({
      userId: USER,
      amount: 5,
      operationType: OP,
      expiresAt: new Date(Date.now() + 60_000),
      idempotencyKey: " job-1 ",
    });
    const second = await repo.reserveCreditsV2({
      userId: USER,
      amount: 5,
      operationType: OP,
      expiresAt: new Date(Date.now() + 60_000),
      idempotencyKey: "job-1",
    });
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("created");
  });

  it("still replays an identical non-empty key", async () => {
    const { repo } = await ready();
    const input = {
      userId: USER,
      amount: 5,
      operationType: OP,
      expiresAt: new Date(Date.now() + 60_000),
      idempotencyKey: "job-2",
    } as const;
    expect((await repo.reserveCreditsV2(input)).outcome).toBe("created");
    expect((await repo.reserveCreditsV2(input)).outcome).toBe("replayed");
  });
});

/**
 * The five methods above are not the whole surface. Every public method that
 * writes a `numeric(12, 2)` column is a way to put an unrepresentable number in
 * the ledger, and a caller reaching past the service hits them directly.
 *
 * These run against the in-memory adapter; `__tests__/integration/corrupt-rows`
 * runs the same shapes against PostgreSQL, where the failure mode is worse — the
 * column silently rounds `1.005` to `1.01`, or raises a bare SQLSTATE 22003.
 */
describe("every public writer validates its amounts", () => {
  const BAD = [1.005, 1e12, Number.NaN, Number.POSITIVE_INFINITY];

  for (const amount of BAD) {
    it(`initializeUserCredits refuses ${amount}`, async () => {
      const repo = createInMemoryCreditRepository();
      await expect(repo.initializeUserCredits("u-init", "free", amount)).rejects.toMatchObject({
        code: CreditErrorCode.INVALID_AMOUNT,
        details: { field: "initialBalance" },
      });
    });

    it(`updateUserCredits refuses ${amount} as an increment`, async () => {
      const { repo } = await ready();
      await expect(
        repo.updateUserCredits(USER, { balanceIncrement: amount })
      ).rejects.toMatchObject({
        code: CreditErrorCode.INVALID_AMOUNT,
        details: { field: "balanceIncrement" },
      });
    });

    it(`updateUserTier refuses ${amount} as a monthly limit`, async () => {
      const { repo } = await ready();
      await expect(
        repo.updateUserTier(USER, { tier: "pro", monthlyLimit: amount })
      ).rejects.toMatchObject({
        code: CreditErrorCode.INVALID_AMOUNT,
        details: { field: "monthlyLimit" },
      });
    });

    it(`logUsage refuses ${amount} credits used`, async () => {
      const { repo } = await ready();
      await expect(
        repo.logUsage({ userId: USER, operationType: OP, creditsUsed: amount, success: true })
      ).rejects.toMatchObject({
        code: CreditErrorCode.INVALID_AMOUNT,
        details: { field: "creditsUsed" },
      });
    });
  }

  it("leaves the balance untouched when it refuses", async () => {
    const { repo } = await ready();
    await expect(repo.updateUserCredits(USER, { balance: 1.005 })).rejects.toThrow();
    expect((await repo.getUserCredits(USER))?.balance).toBe(100);
  });

  it("still accepts zero and negative increments, which are legitimate", async () => {
    const { repo } = await ready();
    await repo.updateUserCredits(USER, { balanceIncrement: -25.5 });
    expect((await repo.getUserCredits(USER))?.balance).toBe(74.5);
  });
});

/**
 * The journal is the audit trail, so the numbers in it have to be the numbers
 * the transition actually moved. Caller metadata is merged in first precisely so
 * it cannot name an `amount` or an `operationType` that never happened.
 */
describe("transition metadata is not caller-writable", () => {
  it("commit records the reserved amount, not the one in the caller's metadata", async () => {
    const { repo } = await ready();
    const reservation = await repo.reserveCreditsV2({
      userId: USER,
      amount: 10,
      operationType: OP,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await repo.commitReservationV2(USER, reservation.reservation.id, {
      metadata: { operationType: "spoofed", amount: 999, note: "kept" },
    });

    const entries = await repo.getJournalEntries({ userId: USER });
    const commit = entries.find((entry) => entry.source === "operation_commit");
    expect(commit?.metadata).toMatchObject({
      operationType: OP,
      amount: 10,
      note: "kept",
    });
  });
});

/**
 * Derived values — the numbers the adapter computes rather than the ones the
 * caller passes.
 *
 * A legal increment applied to a legal balance can produce a number the column
 * cannot hold, and the in-memory store has no transaction to undo a partial
 * write. So every derived value is projected and checked before any of them is
 * assigned, and the error names the field and the operation.
 */
describe("derived numeric writes", () => {
  const CEILING = 9999999999.99;

  async function atCeiling() {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "free", 0);
    await repo.updateUserCredits(USER, { balance: CEILING });
    return repo;
  }

  it("refuses an increment that overflows the balance", async () => {
    const repo = await atCeiling();
    await expect(
      repo.updateUserCredits(USER, { balanceIncrement: 0.01 })
    ).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_AMOUNT,
      details: { field: "balance", operation: "updateUserCredits", userId: USER },
    });
  });

  it("leaves the balance untouched when the increment overflows", async () => {
    const repo = await atCeiling();
    await expect(repo.updateUserCredits(USER, { balanceIncrement: 0.01 })).rejects.toThrow();
    expect((await repo.getUserCredits(USER))?.balance).toBe(CEILING);
  });

  it("applies no part of a multi-field update when one field overflows", async () => {
    const repo = await atCeiling();
    await expect(
      repo.updateUserCredits(USER, { monthlyUsedIncrement: 5, balanceIncrement: 0.01 })
    ).rejects.toThrow();
    const credits = await repo.getUserCredits(USER);
    expect(credits).toMatchObject({ balance: CEILING, monthlyUsed: 0 });
  });

  it("refuses addCredits at the ceiling without moving the balance", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "free", 0);
    await repo.updateUserCredits(USER, { bonusCredits: CEILING });

    await expect(
      repo.addCreditsAtomic(USER, 0.01, "top-up")
    ).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_AMOUNT,
      details: { operation: "addCredits" },
    });

    // The defect this pins: the balance used to move, and only then did the
    // derived transaction record fail validation.
    expect((await repo.getUserCredits(USER))?.bonusCredits).toBe(CEILING);
  });

  it("refuses a reservation whose derived hold overflows, leaving no reservation", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "free", 0);
    // Every field legal on its own, and enough available that the insufficiency
    // guard does not fire first — only the *sum* is unrepresentable.
    await repo.updateUserCredits(USER, {
      balance: CEILING,
      bonusCredits: CEILING,
      reserved: CEILING,
    });

    await expect(
      repo.reserveCreditsV2({
        userId: USER,
        amount: 0.01,
        operationType: OP,
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_AMOUNT,
      details: { field: "reserved", operation: "reserveCredits" },
    });

    expect((await repo.getUserCredits(USER))?.reserved).toBe(CEILING);
    // No reservation row was created either: the refusal happens before the
    // insert, so there is nothing half-written to clean up.
    const stored = (repo as unknown as {
      store: { reservations: Map<string, Map<string, unknown>> };
    }).store.reservations.get(USER);
    expect(stored?.size ?? 0).toBe(0);
  });

  it("refuses a commit whose derived monthlyUsed overflows", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "free", 100);
    await repo.updateUserCredits(USER, { monthlyUsed: CEILING });
    const { reservation } = await repo.reserveCreditsV2({
      userId: USER,
      amount: 10,
      operationType: OP,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(repo.commitReservationV2(USER, reservation.id)).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_AMOUNT,
      details: { field: "monthlyUsed", operation: "commitReservation" },
    });

    // Nothing moved: the hold is still live and the balance is intact.
    expect(await repo.getUserCredits(USER)).toMatchObject({ balance: 100, reserved: 10 });
  });
});

/**
 * `getConfigMonthlyLimit` returns `Infinity` for an unlimited tier, and no
 * numeric column holds that. Both adapters must resolve it the same way, or the
 * same tier means different things depending on which one you deployed.
 */
describe("the unlimited-tier storage contract", () => {
  it("stores the top of the representable range, not zero", () => {
    expect(storedMonthlyLimit(Number.POSITIVE_INFINITY)).toBe(9999999999.99);
  });

  it("leaves a finite limit alone", () => {
    expect(storedMonthlyLimit(500)).toBe(500);
  });

  it("is the exact value the in-memory adapter persists for an unlimited tier", async () => {
    const repo = createInMemoryCreditRepository();
    // The `unlimited` tier, not `free`: `getConfigMonthlyLimit` only returns the
    // `Infinity` sentinel for a tier that is actually unlimited, so a test on a
    // finite tier never exercises the contract at all.
    expect(getConfigMonthlyLimit("unlimited")).toBe(Number.POSITIVE_INFINITY);

    const credits = await repo.initializeUserCredits("u-unlimited", "unlimited", 0);

    // Asserted as the literal canonical value. `toBe(storedMonthlyLimit(x))`
    // would hold for *any* mapping, including a revert to 0, because it just
    // compares the adapter against itself.
    expect(credits.monthlyLimit).toBe(9999999999.99);
    expect(credits.monthlyLimit).not.toBe(0);
  });

  it("keeps a stored unlimited limit above any real usage", async () => {
    const repo = createInMemoryCreditRepository();
    const credits = await repo.initializeUserCredits("u-unlimited-2", "unlimited", 0);
    // The behaviour the mapping exists to preserve: an unlimited tier must not
    // read as *no* allowance, which is what storing 0 would mean.
    expect(credits.monthlyLimit).toBeGreaterThan(credits.monthlyUsed);
    expect(credits.monthlyLimit).toBeGreaterThan(1_000_000);
  });
});

/**
 * The journal's `balanceAfter` is a *derived total*, not one of the balance
 * columns, so validating `balance`, `bonusCredits`, `reserved` and
 * `monthlyUsed` individually says nothing about it. With balance and bonus each
 * legally at the ceiling, their sum is roughly twice what the column can hold —
 * and that sum is exactly what every transition records.
 *
 * The SQL adapter has always rejected this at `writeTransitionJournal` and
 * rolled the transaction back. The in-memory store has no transaction to roll
 * back, so it has to refuse in the shared preflight, before anything moves.
 */
describe("derived journal totals", () => {
  const CEILING = 9999999999.99;
  const JOURNAL_USER = "u-journal-total";

  /** A refused transition must leave the hold live, not half-completed. */
  async function expectHoldUntouched(
    repo: ReturnType<typeof createInMemoryCreditRepository>,
    reservationId: string
  ) {
    const credits = await repo.getUserCredits(JOURNAL_USER);
    expect(credits?.reserved).toBe(1);
    const stored = (repo as unknown as {
      store: { reservations: Map<string, Map<string, { status: string; completedAt?: string | null }>> };
    }).store.reservations.get(JOURNAL_USER)?.get(reservationId);
    expect(stored?.status).toBe("reserved");
    expect(stored?.completedAt ?? null).toBeNull();
  }

  async function heldAtBothCeilings() {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(JOURNAL_USER, "free", 0);
    await repo.updateUserCredits(JOURNAL_USER, {
      balance: CEILING,
      bonusCredits: CEILING,
    });
    const { reservation } = await repo.reserveCreditsV2({
      userId: JOURNAL_USER,
      amount: 1,
      operationType: OP,
      expiresAt: new Date(Date.now() + 60_000),
    });
    return { repo, reservationId: reservation!.id };
  }

  it("refuses a commit whose recorded total cannot be represented", async () => {
    const { repo, reservationId } = await heldAtBothCeilings();

    await expect(
      repo.commitReservationV2(JOURNAL_USER, reservationId)
    ).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_AMOUNT,
      details: {
        field: "journal balanceAfter",
        operation: "commitReservation",
        userId: JOURNAL_USER,
        reservationId,
      },
    });
  });

  it("leaves the ledger and the hold untouched when a commit is refused", async () => {
    const { repo, reservationId } = await heldAtBothCeilings();
    await expect(repo.commitReservationV2(JOURNAL_USER, reservationId)).rejects.toThrow();

    expect(await repo.getUserCredits(JOURNAL_USER)).toMatchObject({
      balance: CEILING,
      bonusCredits: CEILING,
      reserved: 1,
      monthlyUsed: 0,
    });
    const entries = await repo.getJournalEntries({ userId: JOURNAL_USER });
    expect(entries).toHaveLength(0);
    await expectHoldUntouched(repo, reservationId);
  });

  it("refuses a release whose recorded total cannot be represented", async () => {
    const { repo, reservationId } = await heldAtBothCeilings();

    await expect(
      repo.releaseReservationV2(JOURNAL_USER, reservationId)
    ).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_AMOUNT,
      details: {
        field: "journal balanceAfter",
        operation: "releaseReservation",
        userId: JOURNAL_USER,
        reservationId,
      },
    });
    await expectHoldUntouched(repo, reservationId);
  });

  it("refuses an expire whose recorded total cannot be represented", async () => {
    const { repo, reservationId } = await heldAtBothCeilings();

    await expect(
      repo.expireReservationV2(JOURNAL_USER, reservationId, {
        asOf: new Date(Date.now() + 600_000),
      })
    ).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_AMOUNT,
      details: { field: "journal balanceAfter", operation: "expireReservation" },
    });
    await expectHoldUntouched(repo, reservationId);
  });
});

/**
 * A refused update must leave the record exactly as it was.
 *
 * The absolute fields used to be assigned to the live record and the
 * increment-derived results validated afterwards, so `{ monthlyUsed: 5,
 * balanceIncrement: 0.01 }` at the ceiling threw on `balance` and left
 * `monthlyUsed` sitting at 5 — a value the caller was told was not applied.
 * There is no transaction in this store, so the only protection is to project
 * the whole record first.
 */
describe("all-or-nothing updates", () => {
  const CEILING = 9999999999.99;
  const ATOMIC_USER = "u-atomic-update";

  async function atCeiling() {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(ATOMIC_USER, "free", 0);
    await repo.updateUserCredits(ATOMIC_USER, { balance: CEILING });
    return repo;
  }

  // Names the field only. It would still pass against the old partial-mutation
  // bug — the atomicity claim is carried entirely by the next test.
  it("names the derived field that refused", async () => {
    const repo = await atCeiling();
    await expect(
      repo.updateUserCredits(ATOMIC_USER, { monthlyUsed: 5, balanceIncrement: 0.01 })
    ).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_AMOUNT,
      details: { field: "balance", operation: "updateUserCredits", userId: ATOMIC_USER },
    });
  });

  it("leaves the whole record untouched, absolute fields included", async () => {
    const repo = await atCeiling();
    const before = structuredClone(await repo.getUserCredits(ATOMIC_USER));

    await expect(
      repo.updateUserCredits(ATOMIC_USER, {
        // Every one of these is individually legal and would previously have
        // been written before the derived `balance` was ever checked.
        monthlyUsed: 5,
        bonusCredits: 7,
        reserved: 3,
        tier: "premium",
        monthlyLimit: 4242,
        monthlyResetAt: new Date("2030-01-01T00:00:00.000Z"),
        subscriptionExpiresAt: new Date("2030-06-01T00:00:00.000Z"),
        balanceIncrement: 0.01,
      })
    ).rejects.toThrow();

    expect(await repo.getUserCredits(ATOMIC_USER)).toEqual(before);
  });

  it("still applies a whole update when every derived value fits", async () => {
    const repo = await atCeiling();
    await repo.updateUserCredits(ATOMIC_USER, {
      balance: 10,
      monthlyUsed: 5,
      monthlyUsedIncrement: 2,
    });
    expect(await repo.getUserCredits(ATOMIC_USER)).toMatchObject({
      balance: 10,
      // The increment applies on top of the absolute value in the same call,
      // which is the order PostgreSQL evaluates them in.
      monthlyUsed: 7,
    });
  });
});

/**
 * `previousBalance` and `newBalance` are totals across two columns, so each
 * column can sit legally at the ceiling while the total does not fit.
 */
describe("derived deduction totals", () => {
  const CEILING = 9999999999.99;
  const DEDUCT_USER = "u-deduct-total";

  async function bothAtCeiling() {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(DEDUCT_USER, "free", 0);
    await repo.updateUserCredits(DEDUCT_USER, {
      balance: CEILING,
      bonusCredits: CEILING,
    });
    return repo;
  }

  it("refuses a deduction whose derived total cannot be represented", async () => {
    const repo = await bothAtCeiling();
    await expect(repo.deductCreditsAtomic(DEDUCT_USER, 1)).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_AMOUNT,
      details: { field: "previousBalance", operation: "deductCredits", userId: DEDUCT_USER },
    });
  });

  it("leaves both columns untouched when the total refuses", async () => {
    const repo = await bothAtCeiling();
    const before = structuredClone(await repo.getUserCredits(DEDUCT_USER));
    await expect(repo.deductCreditsAtomic(DEDUCT_USER, 1)).rejects.toThrow();
    expect(await repo.getUserCredits(DEDUCT_USER)).toEqual(before);
  });
});
