/**
 * The direct (record-only) writers cannot impersonate the atomic boundary.
 *
 * `createTransaction` and `updateReservationStatus` write records; they move no
 * credits. Each used to accept exactly one input that let a record stand in for
 * a movement:
 *
 * - A `paymentRef` on `createTransaction` occupied the global payment boundary
 *   without crediting anyone, so the real delivery via `addCreditsV2` matched
 *   the record, reported `replayed`, and credited nothing — forever.
 * - `updateReservationStatus` assigned any status to any row, so writing
 *   `committed` onto a live V2 hold stranded `reserved` (the real commit then
 *   said `already_terminal` and never debited), and writing `reserved` onto a
 *   terminal row re-armed a settled reservation.
 *
 * The SQL parity of these cases lives in
 * `credits-drizzle/__tests__/integration/direct-writers.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  CreditErrorCode,
  createInMemoryCreditRepository,
  isCreditError,
} from "../../src";

const USER = "u-direct";
const OP = "story_generation";
const soon = () => new Date(Date.now() + 60_000);

async function repoWith(balance: number) {
  const repo = createInMemoryCreditRepository();
  await repo.initializeUserCredits(USER, "free", balance);
  return repo;
}

describe("createTransaction and paymentRef", () => {
  it("refuses a paymentRef, so a record cannot consume the payment event", async () => {
    const repo = await repoWith(100);
    await expect(
      repo.createTransaction({
        userId: USER,
        type: "purchase",
        amount: 25,
        description: "recorded, not credited",
        paymentRef: "pay-x",
        previousBalance: 100,
        newBalance: 125,
      })
    ).rejects.toMatchObject({ code: CreditErrorCode.UNSUPPORTED_OPERATION });

    // The reference was never claimed: the real delivery still credits.
    const outcome = await repo.addCreditsV2({
      userId: USER,
      amount: 25,
      description: "the actual payment",
      paymentRef: "pay-x",
    });
    expect(outcome.outcome).toBe("created");
    expect((await repo.getUserCredits(USER))?.bonusCredits).toBe(25);
  });

  it("treats a blank paymentRef as absent and stores no reference", async () => {
    const repo = await repoWith(100);
    const transaction = await repo.createTransaction({
      userId: USER,
      type: "usage",
      amount: 1,
      description: "unreferenced record",
      paymentRef: "   ",
      previousBalance: 100,
      newBalance: 99,
    });
    expect(transaction.paymentRef ?? undefined).toBeUndefined();
  });
});

describe("updateReservationStatus and the V2 state machine", () => {
  it("refuses to write a status onto a backed hold, so commit still debits", async () => {
    const repo = await repoWith(100);
    const reserved = await repo.reserveCreditsV2({
      userId: USER,
      amount: 10,
      operationType: OP,
      expiresAt: soon(),
    });
    if (reserved.outcome !== "created") throw new Error("expected a hold");

    await expect(
      repo.updateReservationStatus(USER, reserved.reservation.id, "committed")
    ).rejects.toMatchObject({ code: CreditErrorCode.UNSUPPORTED_OPERATION });

    // The hold is untouched and the real commit performs the debit once.
    const commit = await repo.commitReservationV2(USER, reserved.reservation.id);
    expect(commit.outcome).toBe("committed");
    const credits = await repo.getUserCredits(USER);
    expect(credits?.balance).toBe(90);
    expect(credits?.reserved).toBe(0);
  });

  it("never reopens a row, and still annotates plain records", async () => {
    const repo = await repoWith(100);
    const record = await repo.createReservation({
      userId: USER,
      amount: 5,
      operationType: OP,
      expiresAt: soon(),
    });

    // A record (no hold) may take a terminal status…
    await repo.updateReservationStatus(USER, record.id, "released");
    expect((await repo.getReservation(USER, record.id))?.status).toBe("released");

    // …but nothing may ever be written back to `reserved`.
    await expect(
      repo.updateReservationStatus(USER, record.id, "reserved")
    ).rejects.toSatisfy(
      (error: unknown) =>
        isCreditError(error) && error.code === CreditErrorCode.UNSUPPORTED_OPERATION
    );
  });
});
