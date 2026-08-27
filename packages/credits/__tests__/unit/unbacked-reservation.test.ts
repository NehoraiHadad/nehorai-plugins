/**
 * A reservation row is not a hold.
 *
 * `createReservation` writes a row and never touches `reserved`. If such a row
 * could carry an idempotency key, `reserveCreditsV2` would find it, report
 * `replayed`, and hand the caller a reservation whose credits nothing ever
 * held — and the commit that follows passes its `reserved >= amount` guard on
 * coverage belonging to a *different*, genuine hold. Two holds, one payment.
 *
 * The invariant that closes it: a row is a reservation only if the same atomic
 * operation that wrote it also raised `reserved` by its amount. `holdPlacedAt`
 * is that fact, written by `reserveCreditsV2` and by nothing else.
 *
 * These tests attack it from both ends — through the public API, and by
 * planting a row directly in the store the way a corrupt writer, an older
 * version or a hand-run script would.
 */

import { describe, expect, it } from "vitest";
import {
  CreditErrorCode,
  createInMemoryCreditRepository,
} from "../../src/index.js";
import type { InMemoryCreditRepository } from "../../src/repository/memory/index.js";
import type { MemoryStore } from "../../src/repository/memory/store.js";
import { scopedKey } from "../../src/repository/memory/store.js";

const OWNER = "u-unbacked";
const OTHER = "u-genuine";
const OP = "story_generation";

function storeOf(repo: InMemoryCreditRepository): MemoryStore {
  return (repo as unknown as { store: MemoryStore }).store;
}

async function repoWithBalance(balance = 100): Promise<InMemoryCreditRepository> {
  const repo = createInMemoryCreditRepository();
  await repo.initializeUserCredits(OWNER, "free", balance);
  return repo;
}

/**
 * A keyed row that no hold backs — exactly what `createReservation` used to
 * write when handed an `idempotencyKey`.
 */
function plantUnbackedRow(
  store: MemoryStore,
  userId: string,
  id: string,
  key: string,
  amount: number
): void {
  const rows = store.reservations.get(userId) ?? new Map();
  rows.set(id, {
    id,
    userId,
    amount,
    operationType: OP,
    status: "reserved",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    idempotencyKey: key,
    // No `holdPlacedAt`: nothing raised `reserved` for this row.
  });
  store.reservations.set(userId, rows);
  store.reservationKeys.set(scopedKey(userId, key), id);
}

describe("createReservation refuses to name a hold it does not place", () => {
  it("rejects an idempotency key, and writes nothing", async () => {
    const repo = await repoWithBalance();

    await expect(
      repo.createReservation({
        userId: OWNER,
        amount: 10,
        operationType: OP,
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: "k1",
      })
    ).rejects.toMatchObject({ code: CreditErrorCode.UNSUPPORTED_OPERATION });

    expect(storeOf(repo).reservations.get(OWNER)?.size ?? 0).toBe(0);
    expect(storeOf(repo).reservationKeys.size).toBe(0);
  });

  it("still writes an unkeyed row, which is the legacy path's whole job", async () => {
    const repo = await repoWithBalance();
    const reservation = await repo.createReservation({
      userId: OWNER,
      amount: 10,
      operationType: OP,
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(reservation.idempotencyKey).toBeUndefined();
    expect(storeOf(repo).reservations.get(OWNER)?.size).toBe(1);
  });
});

describe("a planted keyed row cannot be adopted as a replay", () => {
  it("refuses the reserve, and leaves the other hold fully covered", async () => {
    const repo = await repoWithBalance(100);
    const store = storeOf(repo);

    // Two unbacked keyed rows, as the old `createReservation` would have left.
    plantUnbackedRow(store, OWNER, "planted-1", "k1", 60);
    plantUnbackedRow(store, OWNER, "planted-2", "k2", 60);

    // One genuine hold, placed atomically. It is the only thing `reserved`
    // covers, and it must still be covered when this is over.
    const genuine = await repo.reserveCreditsV2({
      userId: OWNER,
      amount: 60,
      operationType: OP,
      expiresAt: new Date(Date.now() + 600_000),
      idempotencyKey: "genuine",
    });
    expect(genuine.outcome).toBe("created");
    expect((await repo.getUserCredits(OWNER))?.reserved).toBe(60);

    await expect(
      repo.reserveCreditsV2({
        userId: OWNER,
        amount: 60,
        operationType: OP,
        expiresAt: new Date(Date.now() + 600_000),
        idempotencyKey: "k1",
      })
    ).rejects.toMatchObject({
      code: CreditErrorCode.UNBACKED_RESERVATION,
      details: { reservationId: "planted-1" },
    });

    // Nothing moved: the refusal happened before any state changed.
    expect(await repo.getUserCredits(OWNER)).toMatchObject({ balance: 100, reserved: 60 });
  });

  it("refuses to commit one, and does not spend the genuine hold's coverage", async () => {
    const repo = await repoWithBalance(100);
    const store = storeOf(repo);
    plantUnbackedRow(store, OWNER, "planted-1", "k1", 60);

    const genuine = await repo.reserveCreditsV2({
      userId: OWNER,
      amount: 60,
      operationType: OP,
      expiresAt: new Date(Date.now() + 600_000),
    });
    if (genuine.outcome !== "created") throw new Error("setup failed to reserve");

    await expect(repo.commitReservationV2(OWNER, "planted-1")).rejects.toMatchObject({
      code: CreditErrorCode.UNBACKED_RESERVATION,
      details: { reservationId: "planted-1", transition: "commit" },
    });

    // The planted row is untouched, and so is the balance.
    expect(store.reservations.get(OWNER)?.get("planted-1")?.status).toBe("reserved");
    expect(await repo.getUserCredits(OWNER)).toMatchObject({ balance: 100, reserved: 60 });

    // And the genuine hold still commits for its full amount afterwards.
    const committed = await repo.commitReservationV2(OWNER, genuine.reservation.id);
    expect(committed.outcome).toBe("committed");
    expect(await repo.getUserCredits(OWNER)).toMatchObject({ balance: 40, reserved: 0 });
  });

  it("refuses to release or expire one, so it cannot hand back what it never held", async () => {
    const repo = await repoWithBalance(100);
    const store = storeOf(repo);
    plantUnbackedRow(store, OWNER, "planted-1", "k1", 60);
    store.reservations.get(OWNER)!.get("planted-1")!.expiresAt = new Date(
      Date.now() - 1000
    ).toISOString();

    await repo.reserveCreditsV2({
      userId: OWNER,
      amount: 60,
      operationType: OP,
      expiresAt: new Date(Date.now() + 600_000),
    });

    await expect(repo.releaseReservationV2(OWNER, "planted-1")).rejects.toMatchObject({
      code: CreditErrorCode.UNBACKED_RESERVATION,
    });
    await expect(repo.expireReservationV2(OWNER, "planted-1")).rejects.toMatchObject({
      code: CreditErrorCode.UNBACKED_RESERVATION,
    });

    // `reserved` still covers the genuine hold — a release that had gone
    // through would have subtracted it.
    expect(await repo.getUserCredits(OWNER)).toMatchObject({ balance: 100, reserved: 60 });
  });
});

describe("the guard does not break the operation it protects", () => {
  it("still replays a key whose hold this boundary placed", async () => {
    const repo = await repoWithBalance(100);
    const input = {
      userId: OWNER,
      amount: 25,
      operationType: OP,
      expiresAt: new Date(Date.now() + 600_000),
      idempotencyKey: "retry-me",
    };

    const first = await repo.reserveCreditsV2(input);
    const second = await repo.reserveCreditsV2(input);

    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("replayed");
    if (second.outcome !== "replayed") throw new Error("unreachable");
    expect(second.reservation.id).toBe(
      first.outcome === "created" ? first.reservation.id : ""
    );
    // Credited once: the replay placed no second hold.
    expect(await repo.getUserCredits(OWNER)).toMatchObject({ balance: 100, reserved: 25 });
  });

  it("still commits, releases and expires a hold it placed", async () => {
    const repo = await repoWithBalance(100);
    await repo.initializeUserCredits(OTHER, "free", 100);

    for (const [amount, transition] of [
      [10, "commit"],
      [11, "release"],
      [12, "expire"],
    ] as const) {
      const outcome = await repo.reserveCreditsV2({
        userId: OTHER,
        amount,
        operationType: OP,
        expiresAt: new Date(Date.now() - 1000),
      });
      if (outcome.outcome !== "created") throw new Error("setup failed to reserve");
      const id = outcome.reservation.id;
      const result =
        transition === "commit"
          ? await repo.commitReservationV2(OTHER, id)
          : transition === "release"
            ? await repo.releaseReservationV2(OTHER, id)
            : await repo.expireReservationV2(OTHER, id);
      expect(result.outcome).toBe(
        transition === "commit" ? "committed" : transition === "release" ? "released" : "expired"
      );
    }

    // 10 spent, the other two handed back.
    expect(await repo.getUserCredits(OTHER)).toMatchObject({ balance: 90, reserved: 0 });
  });
});
