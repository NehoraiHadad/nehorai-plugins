/**
 * The V2 reservation boundary against a real Firestore (the emulator).
 *
 * The fake Firestore in the other suites has no transaction isolation, so it
 * cannot show what matters here: that two settlers racing on one reservation
 * produce exactly one balance movement and exactly one journal row. Only real
 * transaction contention can.
 *
 * Run with `pnpm test:emulator` (needs Java for the emulator). Skipped when
 * FIRESTORE_EMULATOR_HOST is unset, so `pnpm test` stays hermetic.
 */
import { randomUUID } from "node:crypto";
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreditsService, isReservedOutcome, supportsCreditsV2 } from "@nehorai/credits";
import {
  BALANCE_DOC_ID,
  FirestoreCreditRepository,
  getUserCreditsCollection,
  getUserReservationsCollection,
} from "../src";
import { getUserJournalCollection } from "../src/repository/journal.js";
import { retryEmulatorClosedTransactions } from "./emulator-transactions.js";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const expiresIn = (ms: number) => new Date(Date.now() + ms);

// Contended transactions back off and retry on the emulator, which takes seconds,
// not the milliseconds the unit-test default allows for.
describe.skipIf(!emulator)("Firestore V2 boundary (emulator)", { timeout: 30_000 }, () => {
  let app: App;
  let db: Firestore;
  let repo: FirestoreCreditRepository;

  beforeAll(() => {
    app = initializeApp({ projectId: "credits-firestore-test" }, `v2-${randomUUID()}`);
    db = retryEmulatorClosedTransactions(getFirestore(app));
    repo = new FirestoreCreditRepository(db);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  async function seedUser(balance: number, bonusCredits = 0): Promise<string> {
    const userId = `user-${randomUUID()}`;
    await getUserCreditsCollection(db, userId).doc(BALANCE_DOC_ID).set({
      userId,
      balance,
      bonusCredits,
      reserved: 0,
      tier: "free",
      monthlyLimit: balance,
      monthlyUsed: 0,
      monthlyResetAt: expiresIn(30 * 86_400_000).toISOString(),
      subscriptionExpiresAt: null,
    });
    return userId;
  }

  async function balanceOf(userId: string) {
    const doc = await getUserCreditsCollection(db, userId).doc(BALANCE_DOC_ID).get();
    return doc.data() as { balance: number; bonusCredits: number; reserved: number; monthlyUsed: number };
  }

  async function journalFor(userId: string, reservationId: string) {
    const snap = await getUserJournalCollection(db, userId)
      .where("referenceId", "==", reservationId)
      .get();
    return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  it("is detected as a V2 repository", () => {
    expect(supportsCreditsV2(repo)).toBe(true);
  });

  it("two concurrent commits: one winner, one balance movement, one journal row", async () => {
    const userId = await seedUser(100);
    const hold = await repo.reserveCreditsV2({
      userId,
      amount: 30,
      operationType: "audio_generation",
      expiresAt: expiresIn(60_000),
    });
    if (hold.outcome !== "created") throw new Error(`reserve: ${hold.outcome}`);
    const reservationId = hold.reservation.id;

    const outcomes = await Promise.all([
      repo.commitReservationV2(userId, reservationId),
      repo.commitReservationV2(userId, reservationId),
    ]);

    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["already_terminal", "committed"]);
    expect(await balanceOf(userId)).toMatchObject({ balance: 70, reserved: 0, monthlyUsed: 30 });

    const entries = await journalFor(userId, reservationId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: `reservation:${reservationId}:commit`,
      entryType: "debit",
      amount: 30,
      balanceAfter: 70,
      source: "operation_commit",
    });
  });

  it("CreditsService settles through V2: concurrent commitCredits journal once", async () => {
    const service = new CreditsService(repo);
    const userId = await seedUser(50, 10);
    const reservation = await service.reserveCredits(userId, 55, "image_generation");

    await Promise.all(
      Array.from({ length: 5 }, () => service.commitCredits(userId, reservation.id))
    );

    // Drains balance first, then bonus: 50 + 10 - 55 = 5 left, all in bonus.
    expect(await balanceOf(userId)).toMatchObject({ balance: 0, bonusCredits: 5, reserved: 0 });
    const entries = await journalFor(userId, reservation.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entryType: "debit", amount: 55, balanceAfter: 5 });
  });

  it("commit racing release: exactly one transition and one journal row", async () => {
    const userId = await seedUser(40);
    const hold = await repo.reserveCreditsV2({
      userId,
      amount: 10,
      operationType: "audio_generation",
      expiresAt: expiresIn(60_000),
    });
    if (hold.outcome !== "created") throw new Error(`reserve: ${hold.outcome}`);
    const reservationId = hold.reservation.id;

    const [commit, release] = await Promise.all([
      repo.commitReservationV2(userId, reservationId),
      repo.releaseReservationV2(userId, reservationId),
    ]);

    const winners = [commit.outcome, release.outcome].filter((o) => o !== "already_terminal");
    expect(winners).toHaveLength(1);
    const after = await balanceOf(userId);
    expect(after.reserved).toBe(0);
    expect(after.balance).toBe(commit.outcome === "committed" ? 30 : 40);
    expect(await journalFor(userId, reservationId)).toHaveLength(1);
  });

  it("a mismatched entry under the journal key rolls the whole commit back", async () => {
    const userId = await seedUser(20);
    const hold = await repo.reserveCreditsV2({
      userId,
      amount: 5,
      operationType: "audio_generation",
      expiresAt: expiresIn(60_000),
    });
    if (hold.outcome !== "created") throw new Error(`reserve: ${hold.outcome}`);
    const reservationId = hold.reservation.id;
    await getUserJournalCollection(db, userId)
      .doc(`reservation:${reservationId}:commit`)
      .set({ userId, entryType: "debit", amount: 999, referenceId: reservationId });

    await expect(repo.commitReservationV2(userId, reservationId)).rejects.toThrow(
      /already used by a different entry/
    );

    // Nothing moved: the status, the balance and the journal write are one unit.
    expect(await balanceOf(userId)).toMatchObject({ balance: 20, reserved: 5, monthlyUsed: 0 });
    const row = await getUserReservationsCollection(db, userId).doc(reservationId).get();
    expect(row.get("status")).toBe("reserved");
  });

  it("concurrent reserves never hold more than is available", async () => {
    const userId = await seedUser(25);
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () =>
        repo.reserveCreditsV2({
          userId,
          amount: 10,
          operationType: "image_generation",
          expiresAt: expiresIn(60_000),
        })
      )
    );

    expect(outcomes.filter((o) => o.outcome === "created")).toHaveLength(2);
    expect(outcomes.filter((o) => o.outcome === "insufficient")).toHaveLength(2);
    expect((await balanceOf(userId)).reserved).toBe(20);
  });

  it("an idempotency key replays the original hold instead of placing a second", async () => {
    const userId = await seedUser(30);
    const input = {
      userId,
      amount: 10,
      operationType: "audio_generation",
      expiresAt: expiresIn(60_000),
      idempotencyKey: "job/42",
    };

    const [a, b] = await Promise.all([repo.reserveCreditsV2(input), repo.reserveCreditsV2(input)]);

    expect([a.outcome, b.outcome].sort()).toEqual(["created", "replayed"]);
    if (!isReservedOutcome(a) || !isReservedOutcome(b)) throw new Error("no reservation");
    expect(a.reservation.id).toBe(b.reservation.id);
    expect((await balanceOf(userId)).reserved).toBe(10);

    const conflict = await repo.reserveCreditsV2({ ...input, amount: 11 });
    expect(conflict.outcome).toBe("idempotency_conflict");
  });

  it("fractional amounts stay on the cent grid through reserve and commit", async () => {
    const userId = await seedUser(0.3);
    const a = await repo.reserveCreditsV2({
      userId,
      amount: 0.1,
      operationType: "image_generation",
      expiresAt: expiresIn(60_000),
    });
    const b = await repo.reserveCreditsV2({
      userId,
      amount: 0.2,
      operationType: "image_generation",
      expiresAt: expiresIn(60_000),
    });
    if (a.outcome !== "created" || b.outcome !== "created") throw new Error("reserve");
    expect((await balanceOf(userId)).reserved).toBe(0.3);

    const first = await repo.commitReservationV2(userId, a.reservation.id);
    expect(first).toMatchObject({ outcome: "committed", balanceAfter: 0.2 });
    expect(await balanceOf(userId)).toMatchObject({ balance: 0.2, reserved: 0.2 });

    const second = await repo.commitReservationV2(userId, b.reservation.id);
    expect(second).toMatchObject({ outcome: "committed", balanceAfter: 0 });
    expect(await balanceOf(userId)).toMatchObject({ balance: 0, reserved: 0, monthlyUsed: 0.3 });
  });

  it("credits added by the other writers stay on the cent grid, so holds still settle", async () => {
    const userId = await seedUser(0);
    await repo.addCreditsAtomic(userId, 0.1, "bonus");
    await repo.addCreditsAtomic(userId, 0.2, "bonus");
    await repo.updateUserCredits(userId, { bonusCreditsIncrement: 0.1 });
    expect((await balanceOf(userId)).bonusCredits).toBe(0.4);
    await repo.deductCreditsAtomic(userId, 0.1);
    expect((await balanceOf(userId)).bonusCredits).toBe(0.3);

    const hold = await repo.reserveCreditsV2({
      userId,
      amount: 0.1,
      operationType: "image_generation",
      expiresAt: expiresIn(60_000),
    });
    if (hold.outcome !== "created") throw new Error(`reserve: ${hold.outcome}`);
    const commit = await repo.commitReservationV2(userId, hold.reservation.id);
    expect(commit).toMatchObject({ outcome: "committed", balanceAfter: 0.2 });
    expect((await balanceOf(userId)).bonusCredits).toBe(0.2);
  });

  it("expiry journals once and leaves a not-yet-due hold alone", async () => {
    const userId = await seedUser(30);
    const due = await repo.reserveCreditsV2({
      userId,
      amount: 10,
      operationType: "audio_generation",
      expiresAt: expiresIn(-1_000),
    });
    const live = await repo.reserveCreditsV2({
      userId,
      amount: 5,
      operationType: "audio_generation",
      expiresAt: expiresIn(60_000),
    });
    if (due.outcome !== "created" || live.outcome !== "created") throw new Error("reserve");

    const [first, second, notDue] = await Promise.all([
      repo.expireReservationV2(userId, due.reservation.id),
      repo.expireReservationV2(userId, due.reservation.id),
      repo.expireReservationV2(userId, live.reservation.id),
    ]);

    expect([first.outcome, second.outcome].sort()).toEqual(["already_terminal", "expired"]);
    expect(notDue.outcome).toBe("not_due");
    expect((await balanceOf(userId)).reserved).toBe(5);
    expect(await journalFor(userId, due.reservation.id)).toHaveLength(1);
  });
});
