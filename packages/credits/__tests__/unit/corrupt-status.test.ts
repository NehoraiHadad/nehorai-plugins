/**
 * A persisted status that this library does not define is not a status.
 *
 * The transitions used to write `reservation.status as ReservationStatus` and
 * report `already_terminal` with whatever the row held. `already_terminal` is a
 * *success* outcome — it tells the caller "this reservation is resolved, there
 * is nothing to do" — so a row holding `'RESERVED'`, `'pending'`, `''` or a
 * value some other system wrote read back as resolved, and the credits it
 * claimed were never handed back to anyone.
 *
 * The rule now: validate, never cast. An unknown status quarantines the row
 * with a typed invariant error naming the exact operation, and changes nothing.
 *
 * The SQL parity of these cases lives in
 * `credits-drizzle/__tests__/integration/corrupt-status.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { CreditErrorCode, createInMemoryCreditRepository } from "../../src/index.js";
import { isReservationStatus, RESERVATION_STATUSES } from "../../src/core/index.js";
import type { InMemoryCreditRepository } from "../../src/repository/memory/index.js";
import type { MemoryStore } from "../../src/repository/memory/store.js";

const USER = "u-status";
const OP = "story_generation";

function storeOf(repo: InMemoryCreditRepository): MemoryStore {
  return (repo as unknown as { store: MemoryStore }).store;
}

/** A real hold, then a status only a foreign writer could have produced. */
async function heldWithStatus(status: unknown) {
  const repo = createInMemoryCreditRepository();
  await repo.initializeUserCredits(USER, "free", 100);
  const outcome = await repo.reserveCreditsV2({
    userId: USER,
    amount: 10,
    operationType: OP,
    expiresAt: new Date(Date.now() - 1000),
  });
  if (outcome.outcome !== "created") throw new Error("setup failed to reserve");

  const store = storeOf(repo);
  const row = store.reservations.get(USER)!.get(outcome.reservation.id)!;
  (row as { status: unknown }).status = status;
  return { repo, store, id: outcome.reservation.id };
}

function snapshot(store: MemoryStore, id: string) {
  const credits = store.users.get(USER)!;
  const row = store.reservations.get(USER)!.get(id)!;
  return {
    balance: credits.balance,
    reserved: credits.reserved,
    status: (row as { status: unknown }).status,
    completedAt: row.completedAt,
    journal: (store.journalEntries.get(USER) ?? []).length,
  };
}

const CORRUPT: Array<[string, unknown]> = [
  ["a different case", "RESERVED"],
  ["a status from another system", "pending"],
  ["an empty string", ""],
  ["a number", 3],
  ["null", null],
  ["an object", { status: "committed" }],
];

describe("the closed set of statuses", () => {
  it("is exactly the four this library defines", () => {
    expect([...RESERVATION_STATUSES]).toEqual(["reserved", "committed", "released", "expired"]);
  });

  for (const [label, value] of CORRUPT) {
    it(`does not admit ${label}`, () => {
      expect(isReservationStatus(value)).toBe(false);
    });
  }
});

for (const [label, value] of CORRUPT) {
  describe(`a row holding ${label}`, () => {
    for (const transition of ["commit", "release", "expire"] as const) {
      it(`refuses the ${transition}, and changes nothing`, async () => {
        const { repo, store, id } = await heldWithStatus(value);
        const before = snapshot(store, id);

        const call =
          transition === "commit"
            ? repo.commitReservationV2(USER, id)
            : transition === "release"
              ? repo.releaseReservationV2(USER, id)
              : repo.expireReservationV2(USER, id);

        const error = await call.then(
          (outcome) => {
            throw new Error(
              `reported ${JSON.stringify(outcome)} over a corrupt status instead of refusing`
            );
          },
          (e) => e
        );

        expect(error).toMatchObject({
          code: CreditErrorCode.CORRUPT_RESERVATION_STATUS,
          details: {
            userId: USER,
            reservationId: id,
            transition,
            reason: "corrupt_reservation_status",
          },
        });
        // The row is named in the message, and the allowed set is handed over
        // so an operator knows what to repair it to.
        expect(error.details.allowed).toEqual([...RESERVATION_STATUSES]);
        expect(snapshot(store, id)).toEqual(before);
      });
    }
  });
}

describe("the guard does not break the outcome it protects", () => {
  it("still reports already_terminal for a genuinely committed row", async () => {
    const { repo, id } = await heldWithStatus("committed");
    const outcome = await repo.releaseReservationV2(USER, id);
    expect(outcome).toMatchObject({ outcome: "already_terminal", terminalStatus: "committed" });
  });

  it("still commits a reserved row", async () => {
    const { repo, id } = await heldWithStatus("reserved");
    const outcome = await repo.commitReservationV2(USER, id);
    expect(outcome.outcome).toBe("committed");
  });
});
