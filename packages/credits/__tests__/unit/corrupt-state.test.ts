/**
 * What the V2 transitions do when the state they read back is not trustworthy.
 *
 * Every case here reaches past the public API to corrupt the store directly.
 * That is the point: the row could have been written by an older version of
 * this library, by a migration script, by hand — and the transition's job is to
 * notice before it turns that row into money.
 */

import { describe, expect, it } from "vitest";
import {
  CreditErrorCode,
  CreditsService,
  createInMemoryCreditRepository,
  reservationJournalKey,
} from "../../src/index.js";
import type { InMemoryCreditRepository } from "../../src/repository/memory/index.js";
import type { MemoryStore } from "../../src/repository/memory/store.js";
import type { PortableReservation } from "../../src/core/types.js";

const USER = "u-corrupt";
const OP = "story_generation";

/** Reach the private store the way a corrupt writer effectively would. */
function storeOf(repo: InMemoryCreditRepository): MemoryStore {
  return (repo as unknown as { store: MemoryStore }).store;
}

async function held(amount = 10): Promise<{
  repo: InMemoryCreditRepository;
  store: MemoryStore;
  reservation: PortableReservation;
}> {
  const repo = createInMemoryCreditRepository();
  await repo.initializeUserCredits(USER, "free", 100);
  const outcome = await repo.reserveCreditsV2({
    userId: USER,
    amount,
    operationType: OP,
    expiresAt: new Date(Date.now() + 60_000),
  });
  if (outcome.outcome !== "created") throw new Error("setup failed to reserve");
  return { repo, store: storeOf(repo), reservation: outcome.reservation };
}

function snapshotOf(store: MemoryStore, reservationId: string) {
  const credits = store.users.get(USER)!;
  const reservation = store.reservations.get(USER)!.get(reservationId)!;
  return {
    balance: credits.balance,
    bonusCredits: credits.bonusCredits,
    reserved: credits.reserved,
    monthlyUsed: credits.monthlyUsed,
    status: reservation.status,
    completedAt: reservation.completedAt,
    journalRows: (store.journalEntries.get(USER) ?? []).length,
    journalKeys: store.journalKeys.size,
  };
}

// ==================== Blocker 1: a corrupt amount must never move money ====

describe("corrupt persisted reservation amounts", () => {
  const CORRUPT: Array<[string, number]> = [
    ["negative", -10],
    ["zero", 0],
    ["over-precision", 1.005],
    ["out of range", 1e12],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ];

  for (const [label, amount] of CORRUPT) {
    it(`refuses to commit a ${label} amount, and changes nothing`, async () => {
      const { repo, store, reservation } = await held();
      store.reservations.get(USER)!.get(reservation.id)!.amount = amount;
      const before = snapshotOf(store, reservation.id);

      await expect(repo.commitReservationV2(USER, reservation.id)).rejects.toMatchObject({
        code: CreditErrorCode.INVALID_AMOUNT,
        details: { reason: "corrupt_stored_amount" },
      });

      expect(snapshotOf(store, reservation.id)).toEqual(before);
    });

    it(`refuses to release a ${label} amount, and changes nothing`, async () => {
      const { repo, store, reservation } = await held();
      store.reservations.get(USER)!.get(reservation.id)!.amount = amount;
      const before = snapshotOf(store, reservation.id);

      await expect(repo.releaseReservationV2(USER, reservation.id)).rejects.toMatchObject({
        code: CreditErrorCode.INVALID_AMOUNT,
      });

      expect(snapshotOf(store, reservation.id)).toEqual(before);
    });

    it(`refuses to expire a ${label} amount, and changes nothing`, async () => {
      const { repo, store, reservation } = await held();
      const row = store.reservations.get(USER)!.get(reservation.id)!;
      row.amount = amount;
      row.expiresAt = new Date(Date.now() - 1000).toISOString();
      const before = snapshotOf(store, reservation.id);

      await expect(repo.expireReservationV2(USER, reservation.id)).rejects.toMatchObject({
        code: CreditErrorCode.INVALID_AMOUNT,
      });

      expect(snapshotOf(store, reservation.id)).toEqual(before);
    });
  }

  it("does not mint credits from a negative hold", async () => {
    // The exact reproduction: `reserved >= -10` is true and `balance - (-10)`
    // adds. Before the guard this returned `committed` with balance 100 -> 110.
    const { repo, store, reservation } = await held();
    store.reservations.get(USER)!.get(reservation.id)!.amount = -10;

    await expect(repo.commitReservationV2(USER, reservation.id)).rejects.toThrow();

    const credits = store.users.get(USER)!;
    expect(credits.balance).toBe(100);
    expect(credits.monthlyUsed).toBe(0);
    expect(credits.reserved).toBe(10);
  });
});

// ==================== Blocker 3: journal key parity ====================

describe("journal idempotency parity", () => {
  it("registers keys written through the public method", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "free", 100);
    await repo.createJournalEntry({
      userId: USER,
      entryType: "debit",
      amount: 5,
      balanceAfter: 95,
      source: "operation_commit",
      description: "first",
      idempotencyKey: "caller-key",
    });

    await expect(
      repo.createJournalEntry({
        userId: USER,
        entryType: "debit",
        amount: 5,
        balanceAfter: 90,
        source: "operation_commit",
        description: "second",
        idempotencyKey: "caller-key",
      })
    ).rejects.toMatchObject({ code: CreditErrorCode.DATABASE_ERROR });
  });

  it("refuses to write into the namespace the transitions own", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "free", 100);
    await expect(
      repo.createJournalEntry({
        userId: USER,
        entryType: "debit",
        amount: 10,
        balanceAfter: 90,
        source: "operation_commit",
        description: "pre-seeded to be adopted by a commit",
        idempotencyKey: reservationJournalKey("any-reservation", "commit"),
      })
    ).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_IDEMPOTENCY_KEY,
      details: { reason: "reserved_namespace" },
    });
  });

  it("refuses a transition whose key is held by a different event, before mutating", async () => {
    const { repo, store, reservation } = await held();
    // Simulate a foreign row already occupying the deterministic key: describes
    // the same reservation, but a different amount.
    const key = reservationJournalKey(reservation.id, "commit");
    store.journalEntries.set(USER, [
      {
        id: "planted",
        userId: USER,
        entryType: "debit",
        amount: 999,
        balanceAfter: 1,
        source: "operation_commit",
        referenceId: reservation.id,
        referenceType: "reservation",
        description: "planted",
        idempotencyKey: key,
        createdAt: new Date().toISOString(),
      },
    ]);
    store.journalKeys.set(`${USER}\n${key}`, "planted");
    const before = snapshotOf(store, reservation.id);

    await expect(repo.commitReservationV2(USER, reservation.id)).rejects.toMatchObject({
      code: CreditErrorCode.DATABASE_ERROR,
    });

    // The whole point of the preflight: nothing moved, so the ledger is not
    // left half-transitioned with no transaction to roll it back.
    expect(snapshotOf(store, reservation.id)).toEqual(before);
  });
});

// ==================== Blocker 9: deterministic metadata ====================

describe("journal metadata", () => {
  it("cannot be overwritten by caller metadata", async () => {
    const { repo, store, reservation } = await held(10);
    await repo.commitReservationV2(USER, reservation.id, {
      metadata: { operationType: "spoofed", amount: 999, note: "kept" },
    });

    const entry = store.journalEntries.get(USER)!.at(-1)!;
    expect(entry.metadata).toMatchObject({ operationType: OP, note: "kept" });
    expect(entry.amount).toBe(10);
  });

  it("cannot be overwritten on the legacy commit and release paths either", async () => {
    // These write the journal through the public `createJournalEntry` rather
    // than through a transition, and they had the spread the other way round.
    const inner = createInMemoryCreditRepository();
    await inner.initializeUserCredits(USER, "free", 100);
    const legacy = Object.fromEntries(
      [
        "getUserCredits",
        "initializeUserCredits",
        "getReservation",
        "createJournalEntry",
        "getJournalEntries",
        "reserveCreditsAtomic",
        "commitReservationAtomic",
        "releaseReservationAtomic",
        "updateUserCredits",
      ].map((name) => [name, (...args: unknown[]) => (inner as never as Record<string, Function>)[name](...args)])
    ) as never;

    const service = new CreditsService(legacy);
    const reservation = await service.reserveCredits(USER, 10, OP);
    await service.commitCredits(USER, reservation.id, {
      metadata: { operationType: "spoofed" },
    });

    const entries = await inner.getJournalEntries({ userId: USER });
    expect(entries.at(-1)?.metadata).toMatchObject({ operationType: OP });
  });

  it("keeps the transition's own amount in release metadata", async () => {
    const { repo, store, reservation } = await held(10);
    await repo.releaseReservationV2(USER, reservation.id, {
      metadata: { amount: -1, operationType: "spoofed" },
    });

    const entry = store.journalEntries.get(USER)!.at(-1)!;
    expect(entry.metadata).toMatchObject({ operationType: OP, amount: 10 });
  });
});

/**
 * A corrupt row must not come back as a *success*.
 *
 * `already_terminal` and `not_due` both report "nothing to do, everything is
 * fine" — which is exactly the claim a row with an unusable amount cannot
 * support. Validating only before the write left these paths reporting health
 * over data nobody can trust.
 */
describe("corrupt amounts are refused on the early-exit paths too", () => {
  const CORRUPT = [-10, 0, 1.005, Number.NaN, Number.POSITIVE_INFINITY];

  async function corruptReservation(status: PortableReservation["status"], amount: number) {
    const { repo, store, reservation } = await held();
    const stored = store.reservations.get(USER)!.get(reservation.id)!;
    stored.amount = amount;
    stored.status = status;
    return { repo, id: reservation.id };
  }

  for (const amount of CORRUPT) {
    it(`refuses to commit an already-committed row holding ${amount}`, async () => {
      const { repo, id } = await corruptReservation("committed", amount);
      await expect(repo.commitReservationV2(USER, id)).rejects.toMatchObject({
        code: CreditErrorCode.INVALID_AMOUNT,
      });
    });

    it(`refuses to release an already-released row holding ${amount}`, async () => {
      const { repo, id } = await corruptReservation("released", amount);
      await expect(repo.releaseReservationV2(USER, id)).rejects.toMatchObject({
        code: CreditErrorCode.INVALID_AMOUNT,
      });
    });

    it(`refuses to expire a not-yet-due row holding ${amount}`, async () => {
      const { repo, id } = await corruptReservation("reserved", amount);
      await expect(repo.expireReservationV2(USER, id)).rejects.toMatchObject({
        code: CreditErrorCode.INVALID_AMOUNT,
      });
    });
  }

  it("still reports already_terminal for a healthy committed row", async () => {
    const { repo, id } = await corruptReservation("committed", 10);
    const outcome = await repo.commitReservationV2(USER, id);
    expect(outcome.outcome).toBe("already_terminal");
  });

  it("still reports not_due for a healthy undue row", async () => {
    const { repo, id } = await corruptReservation("reserved", 10);
    const outcome = await repo.expireReservationV2(USER, id);
    expect(outcome.outcome).toBe("not_due");
  });

  it("leaves the balance untouched when it refuses an early exit", async () => {
    const { repo, id } = await corruptReservation("committed", -10);
    await expect(repo.commitReservationV2(USER, id)).rejects.toThrow();
    expect((await repo.getUserCredits(USER))?.balance).toBe(100);
  });
});
