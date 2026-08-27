/**
 * Contract tests for the V2 reservation boundary, run against the in-memory
 * repository.
 *
 * These are the fast mirror of the PostgreSQL integration suite in
 * `@nehorai/credits-drizzle`: same scenarios, same expectations. They exist so
 * a regression in the shared contract is caught in milliseconds, without a
 * database — but they only mean something because the in-memory adapter models
 * the row locks and the unique indexes rather than relying on JS being
 * single-threaded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CreditErrorCode,
  CreditsService,
  InMemoryCreditRepository,
  createInMemoryCreditRepository,
  isCreditError,
  reservationJournalKey,
  supportsCreditsV2,
} from "../../src";

const USER = "user-v2";
const OP = "story_generation";
const soon = () => new Date(Date.now() + 60_000);
const past = () => new Date(Date.now() - 1_000);

/**
 * A real macrotask yield, installed inside every V2 critical section.
 *
 * Without it these `Promise.all` tests do not actually overlap: each critical
 * section runs to completion synchronously, so every scenario below would pass
 * even with the locking deleted. With it, callers suspend mid-transition at the
 * read/write seam and the tests fail unless the lock genuinely serialises them.
 */
const yieldToOtherCallers = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function repoWith(balance: number, bonusCredits = 0) {
  const repo = createInMemoryCreditRepository();
  repo.setSchedulingHook(yieldToOtherCallers);
  await repo.initializeUserCredits(USER, "free", balance);
  if (bonusCredits) await repo.updateUserCredits(USER, { bonusCredits });
  return repo;
}

async function hold(repo: InMemoryCreditRepository, amount: number, expiresAt = soon()) {
  const outcome = await repo.reserveCreditsV2({
    userId: USER,
    amount,
    operationType: OP,
    expiresAt,
  });
  if (outcome.outcome !== "created") throw new Error(`expected created, got ${outcome.outcome}`);
  return outcome.reservation;
}

describe("V2 reservation contract (in-memory)", () => {
  let repo: InMemoryCreditRepository;

  beforeEach(async () => {
    repo = await repoWith(1000);
  });

  it("advertises V2 support", () => {
    expect(supportsCreditsV2(repo)).toBe(true);
  });

  describe("reserve", () => {
    it("places exactly one hold for 50 concurrent reserves sharing a key", async () => {
      const outcomes = await Promise.all(
        Array.from({ length: 50 }, () =>
          repo.reserveCreditsV2({
            userId: USER,
            amount: 10,
            operationType: OP,
            expiresAt: soon(),
            idempotencyKey: "job-42",
          })
        )
      );

      expect(outcomes.filter((o) => o.outcome === "created")).toHaveLength(1);
      expect(outcomes.filter((o) => o.outcome === "replayed")).toHaveLength(49);

      const ids = new Set(
        outcomes.flatMap((o) =>
          o.outcome === "created" || o.outcome === "replayed" ? [o.reservation.id] : []
        )
      );
      expect(ids.size).toBe(1);

      const credits = await repo.getUserCredits(USER);
      expect(credits?.reserved).toBe(10);
      expect(repo.getAllReservations(USER)).toHaveLength(1);
    });

    it("respects available funds when distinct keys compete", async () => {
      repo = await repoWith(100);
      const outcomes = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          repo.reserveCreditsV2({
            userId: USER,
            amount: 25,
            operationType: OP,
            expiresAt: soon(),
            idempotencyKey: `job-${i}`,
          })
        )
      );

      expect(outcomes.filter((o) => o.outcome === "created")).toHaveLength(4);
      expect(outcomes.filter((o) => o.outcome === "insufficient")).toHaveLength(16);
      const credits = await repo.getUserCredits(USER);
      expect(credits?.reserved).toBe(100);
    });

    it("reports a conflict when a key is reused with a different payload", async () => {
      await repo.reserveCreditsV2({
        userId: USER,
        amount: 10,
        operationType: OP,
        expiresAt: soon(),
        idempotencyKey: "job-1",
      });
      const conflict = await repo.reserveCreditsV2({
        userId: USER,
        amount: 25,
        operationType: OP,
        expiresAt: soon(),
        idempotencyKey: "job-1",
      });

      expect(conflict.outcome).toBe("idempotency_conflict");
      const credits = await repo.getUserCredits(USER);
      expect(credits?.reserved).toBe(10);
    });

    it("treats a later expiry on replay as the same request", async () => {
      const first = await repo.reserveCreditsV2({
        userId: USER,
        amount: 10,
        operationType: OP,
        expiresAt: new Date(Date.now() + 10_000),
        idempotencyKey: "job-1",
      });
      const replay = await repo.reserveCreditsV2({
        userId: USER,
        amount: 10,
        operationType: OP,
        expiresAt: new Date(Date.now() + 900_000),
        idempotencyKey: "job-1",
      });

      expect(replay.outcome).toBe("replayed");
      if (first.outcome !== "created" || replay.outcome !== "replayed") return;
      expect(replay.reservation.id).toBe(first.reservation.id);
    });

    it("scopes keys per user", async () => {
      await repo.initializeUserCredits("other-user", "free", 100);
      const a = await repo.reserveCreditsV2({
        userId: USER,
        amount: 10,
        operationType: OP,
        expiresAt: soon(),
        idempotencyKey: "shared",
      });
      const b = await repo.reserveCreditsV2({
        userId: "other-user",
        amount: 10,
        operationType: OP,
        expiresAt: soon(),
        idempotencyKey: "shared",
      });
      expect(a.outcome).toBe("created");
      expect(b.outcome).toBe("created");
    });

    it("rejects a non-positive amount before touching state", async () => {
      await expect(
        repo.reserveCreditsV2({ userId: USER, amount: 0, operationType: OP, expiresAt: soon() })
      ).rejects.toMatchObject({ code: CreditErrorCode.INVALID_AMOUNT });
      expect(repo.getAllReservations(USER)).toHaveLength(0);
    });
  });

  describe("commit", () => {
    it("deducts once for 50 concurrent commits of one reservation", async () => {
      const reservation = await hold(repo, 40);
      const outcomes = await Promise.all(
        Array.from({ length: 50 }, () => repo.commitReservationV2(USER, reservation.id))
      );

      expect(outcomes.filter((o) => o.outcome === "committed")).toHaveLength(1);
      const losers = outcomes.filter((o) => o.outcome === "already_terminal");
      expect(losers).toHaveLength(49);
      for (const loser of losers) {
        if (loser.outcome === "already_terminal") expect(loser.terminalStatus).toBe("committed");
      }

      const credits = await repo.getUserCredits(USER);
      expect(credits).toMatchObject({ balance: 960, reserved: 0, monthlyUsed: 40 });

      const entries = await repo.getJournalEntries({ userId: USER });
      expect(entries.filter((e) => e.source === "operation_commit")).toHaveLength(1);
    });

    it("preserves both deductions when two reservations commit concurrently", async () => {
      const first = await hold(repo, 30);
      const second = await hold(repo, 45);

      const [a, b] = await Promise.all([
        repo.commitReservationV2(USER, first.id),
        repo.commitReservationV2(USER, second.id),
      ]);
      expect(a.outcome).toBe("committed");
      expect(b.outcome).toBe("committed");

      const credits = await repo.getUserCredits(USER);
      expect(credits).toMatchObject({ balance: 925, reserved: 0, monthlyUsed: 75 });
    });

    it("spends balance before bonus credits", async () => {
      repo = await repoWith(10, 100);
      const reservation = await hold(repo, 30);
      const outcome = await repo.commitReservationV2(USER, reservation.id);

      expect(outcome.outcome).toBe("committed");
      if (outcome.outcome !== "committed") return;
      expect(outcome.balanceAfter).toBe(80);
      expect(await repo.getUserCredits(USER)).toMatchObject({ balance: 0, bonusCredits: 80 });
    });

    it("stamps a deterministic journal key", async () => {
      const reservation = await hold(repo, 10);
      await repo.commitReservationV2(USER, reservation.id);
      const [entry] = await repo.getJournalEntries({ userId: USER });
      expect(entry.idempotencyKey).toBe(reservationJournalKey(reservation.id, "commit"));
    });

    it("reports not_found for an unknown reservation", async () => {
      expect((await repo.commitReservationV2(USER, "nope")).outcome).toBe("not_found");
    });
  });

  describe("release and expire", () => {
    it("picks exactly one winner between commit and release", async () => {
      for (let round = 0; round < 25; round += 1) {
        const reservation = await hold(repo, 10);
        const [commit, release] = await Promise.all([
          repo.commitReservationV2(USER, reservation.id),
          repo.releaseReservationV2(USER, reservation.id),
        ]);
        const winners = [commit.outcome, release.outcome].filter(
          (o) => o === "committed" || o === "released"
        );
        expect(winners).toHaveLength(1);
        expect((await repo.getUserCredits(USER))?.reserved).toBe(0);
      }
    });

    it("picks exactly one winner between commit and expire", async () => {
      for (let round = 0; round < 25; round += 1) {
        const reservation = await hold(repo, 10, past());
        const [commit, expire] = await Promise.all([
          repo.commitReservationV2(USER, reservation.id),
          repo.expireReservationV2(USER, reservation.id),
        ]);
        const winners = [commit.outcome, expire.outcome].filter(
          (o) => o === "committed" || o === "expired"
        );
        expect(winners).toHaveLength(1);
        expect((await repo.getUserCredits(USER))?.reserved).toBe(0);
      }
    });

    it("refuses to expire a reservation that is not due", async () => {
      const reservation = await hold(repo, 10);
      expect((await repo.expireReservationV2(USER, reservation.id)).outcome).toBe("not_due");
      expect((await repo.getUserCredits(USER))?.reserved).toBe(10);
    });

    it("sweeps only due reservations, once each", async () => {
      const stale = await hold(repo, 10, past());
      const live = await hold(repo, 20);

      const result = await repo.findAndExpireReservations();
      expect(result).toMatchObject({ expiredCount: 1, creditsReleased: 10, errors: [] });

      const byId = Object.fromEntries(
        repo.getAllReservations(USER).map((r) => [r.id, r.status])
      );
      expect(byId[stale.id]).toBe("expired");
      expect(byId[live.id]).toBe("reserved");
      expect((await repo.getUserCredits(USER))?.reserved).toBe(20);
    });
  });

  describe("CreditsService", () => {
    it("writes exactly one journal entry and notifies once per commit", async () => {
      const service = new CreditsService(repo);
      const onLowBalance = vi.fn().mockResolvedValue(undefined);
      service.setLowBalanceCallback(onLowBalance);

      const reservation = await service.reserveCredits(USER, 40, OP, {
        idempotencyKey: "job-1",
      });
      await service.commitCredits(USER, reservation.id);
      // A re-delivered commit must change nothing.
      await service.commitCredits(USER, reservation.id);

      const entries = await repo.getJournalEntries({ userId: USER });
      expect(entries.filter((e) => e.source === "operation_commit")).toHaveLength(1);
      expect(onLowBalance).toHaveBeenCalledTimes(1);
      expect(await repo.getUserCredits(USER)).toMatchObject({ balance: 960, monthlyUsed: 40 });
    });

    it("returns the same reservation for a replayed reserve", async () => {
      const service = new CreditsService(repo);
      const first = await service.reserveCredits(USER, 10, OP, { idempotencyKey: "job-1" });
      const second = await service.reserveCredits(USER, 10, OP, { idempotencyKey: "job-1" });
      expect(second.id).toBe(first.id);
      expect((await repo.getUserCredits(USER))?.reserved).toBe(10);
    });

    it("throws a typed IDEMPOTENCY_CONFLICT on key reuse with a different amount", async () => {
      const service = new CreditsService(repo);
      await service.reserveCredits(USER, 10, OP, { idempotencyKey: "job-1" });

      try {
        await service.reserveCredits(USER, 99, OP, { idempotencyKey: "job-1" });
        expect.unreachable("expected a conflict");
      } catch (error) {
        expect(isCreditError(error)).toBe(true);
        if (!isCreditError(error)) return;
        expect(error.code).toBe(CreditErrorCode.IDEMPOTENCY_CONFLICT);
        expect(error.details?.idempotencyKey).toBe("job-1");
      }
    });

    it("throws a typed INSUFFICIENT_CREDITS when funds run out", async () => {
      repo = await repoWith(5);
      const service = new CreditsService(repo);
      await expect(service.reserveCredits(USER, 50, OP)).rejects.toMatchObject({
        code: CreditErrorCode.INSUFFICIENT_CREDITS,
      });
    });

    it("does not throw when a release loses to a commit", async () => {
      const service = new CreditsService(repo);
      const reservation = await service.reserveCredits(USER, 10, OP);
      await service.commitCredits(USER, reservation.id);

      const outcome = await service.releaseCreditsDetailed(USER, reservation.id);
      expect(outcome).toMatchObject({ outcome: "already_terminal", terminalStatus: "committed" });
      expect((await repo.getUserCredits(USER))?.balance).toBe(990);
    });

    it("throws when committing a released reservation", async () => {
      const service = new CreditsService(repo);
      const reservation = await service.reserveCredits(USER, 10, OP);
      await service.releaseCredits(USER, reservation.id);

      await expect(service.commitCredits(USER, reservation.id)).rejects.toMatchObject({
        code: CreditErrorCode.RESERVATION_ALREADY_PROCESSED,
      });
    });
  });
});
