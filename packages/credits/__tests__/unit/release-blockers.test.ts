/**
 * Regressions for the release blockers raised against the first V2 commit.
 *
 * Each block names the defect it pins down. They are deliberately separate
 * from the contract suite: those tests describe what the boundary promises,
 * these describe specific ways an earlier implementation broke that promise.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CreditErrorCode,
  CreditsService,
  createInMemoryCreditRepository,
  isCreditError,
  isValidCreditAmount,
  numericToCents,
  sameAmount,
  toCents,
  type ICreditRepository,
  type PortableReservation,
} from "../../src";

const USER = "user-blockers";
const OP = "story_generation";
const soon = () => new Date(Date.now() + 60_000);

async function repoWith(balance: number) {
  const repo = createInMemoryCreditRepository();
  await repo.initializeUserCredits(USER, "free", balance);
  return repo;
}

/**
 * A repository that implements only the legacy surface.
 *
 * `supportsCreditsV2` must report `false` for it, which is what routes calls
 * down the legacy path being tested here.
 */
function legacyRepo(overrides: Partial<ICreditRepository> = {}): ICreditRepository {
  const inner = createInMemoryCreditRepository();
  const legacy = {
    ...Object.fromEntries(
      ["getUserCredits", "initializeUserCredits", "getReservation", "createJournalEntry",
       "reserveCreditsAtomic", "commitReservationAtomic", "releaseReservationAtomic",
       "updateUserCredits"].map((name) => [
        name,
        (...args: unknown[]) => (inner as any)[name](...args),
      ])
    ),
    ...overrides,
  } as unknown as ICreditRepository;
  return legacy;
}

// ==================== Blocker 4: numeric(12,2) validation ====================

describe("credit amount validation", () => {
  it("accepts values that sit exactly on the cent grid", () => {
    for (const value of [0.01, 1, 1.5, 1.05, 99.99, 1234.56, 9_999_999_999.99]) {
      expect(isValidCreditAmount(value)).toBe(true);
    }
  });

  it("rejects values the ledger cannot represent", () => {
    for (const value of [0, -1, -0.01, NaN, Infinity, -Infinity, 0.001, 1.005, 1.234,
                         10_000_000_000, 1e21]) {
      expect(isValidCreditAmount(value)).toBe(false);
    }
  });

  it("rejects non-numbers", () => {
    for (const value of ["1.00", null, undefined, {}, []]) {
      expect(isValidCreditAmount(value)).toBe(false);
    }
  });

  it("does not fall for the naive float check", () => {
    // `Math.round(1.005 * 100) === 1.005 * 100` is false in binary float even
    // though 1.005 is over-precision anyway; and 1.1 * 100 is 110.00000000000001,
    // which the naive check rejects despite 1.1 being perfectly valid.
    expect(isValidCreditAmount(1.1)).toBe(true);
    expect(toCents(1.1)).toBe(110);
    expect(isValidCreditAmount(1.005)).toBe(false);
  });

  it("refuses an over-precision reserve before writing anything", async () => {
    const repo = await repoWith(1000);
    await expect(
      repo.reserveCreditsV2({ userId: USER, amount: 1.005, operationType: OP, expiresAt: soon() })
    ).rejects.toMatchObject({ code: CreditErrorCode.INVALID_AMOUNT });

    expect(repo.getAllReservations(USER)).toHaveLength(0);
    expect((await repo.getUserCredits(USER))?.reserved).toBe(0);
  });

  it("refuses an out-of-range reserve before writing anything", async () => {
    const repo = await repoWith(1000);
    await expect(
      repo.reserveCreditsV2({
        userId: USER,
        amount: 10_000_000_000,
        operationType: OP,
        expiresAt: soon(),
      })
    ).rejects.toMatchObject({ code: CreditErrorCode.INVALID_AMOUNT });
    expect(repo.getAllReservations(USER)).toHaveLength(0);
  });
});

describe("exact numeric comparison", () => {
  it("parses numeric strings without going through float", () => {
    expect(numericToCents("40.00")).toBe(4000n);
    expect(numericToCents("0.01")).toBe(1n);
    expect(numericToCents("-12.30")).toBe(-1230n);
    expect(numericToCents("40")).toBe(4000n);
    expect(numericToCents("40.000")).toBe(4000n);
  });

  it("refuses to guess at unparseable values", () => {
    for (const value of ["", "abc", "1.2.3", null, undefined, {}]) {
      expect(numericToCents(value)).toBeNull();
    }
    // Unparseable is never equal to anything, including itself.
    expect(sameAmount("abc", "abc")).toBe(false);
  });

  it("matches a number against the string the driver returns", () => {
    expect(sameAmount("40.00", 40)).toBe(true);
    expect(sameAmount("40.01", 40)).toBe(false);
  });
});

// ==================== Blocker 3: legacy adapters ====================

describe("legacy adapters", () => {
  it("refuses an idempotency key instead of silently reporting created", async () => {
    const reserveSpy = vi.fn();
    const repo = legacyRepo({ reserveCreditsAtomic: reserveSpy as never });
    const service = new CreditsService(repo);

    await expect(
      service.reserveCredits(USER, 10, OP, { idempotencyKey: "job-1" })
    ).rejects.toMatchObject({ code: CreditErrorCode.UNSUPPORTED_OPERATION });

    // "Before reserve" is the point: nothing was attempted.
    expect(reserveSpy).not.toHaveBeenCalled();
  });

  it("still reserves without a key", async () => {
    const repo = legacyRepo();
    await repo.initializeUserCredits(USER, "free", 100);
    const service = new CreditsService(repo);
    const reservation = await service.reserveCredits(USER, 10, OP);
    expect(reservation.amount).toBe(10);
  });

  it("does not relabel an infrastructure failure as insufficient credits", async () => {
    const boom = Object.assign(new Error("connection terminated unexpectedly"), {
      code: "08006",
    });
    const repo = legacyRepo({
      reserveCreditsAtomic: (() => Promise.reject(boom)) as never,
      // A low balance is what made the old code call this "insufficient".
      getUserCredits: (() =>
        Promise.resolve({ balance: 1, bonusCredits: 0, reserved: 0 })) as never,
    });

    await expect(new CreditsService(repo).reserveCredits(USER, 10, OP)).rejects.toBe(boom);
  });

  it("still reports a real shortfall as insufficient", async () => {
    const repo = legacyRepo();
    await repo.initializeUserCredits(USER, "free", 5);
    await expect(
      new CreditsService(repo).reserveCredits(USER, 500, OP)
    ).rejects.toMatchObject({ code: CreditErrorCode.INSUFFICIENT_CREDITS });
  });
});

// ==================== Blocker 5: release compatibility ====================

describe("releaseCredits compatibility", () => {
  async function held(): Promise<[CreditsService, PortableReservation, ReturnType<typeof createInMemoryCreditRepository>]> {
    const repo = await repoWith(1000);
    const service = new CreditsService(repo);
    const reservation = await service.reserveCredits(USER, 40, OP);
    return [service, reservation, repo];
  }

  it("throws RESERVATION_NOT_FOUND for an unknown reservation", async () => {
    const [service] = await held();
    await expect(service.releaseCredits(USER, "does-not-exist")).rejects.toMatchObject({
      code: CreditErrorCode.RESERVATION_NOT_FOUND,
    });
  });

  it("is a no-op when the reservation is already released", async () => {
    const [service, reservation] = await held();
    await service.releaseCredits(USER, reservation.id);
    await expect(service.releaseCredits(USER, reservation.id)).resolves.toBeUndefined();
  });

  it("is a no-op when the reservation already expired", async () => {
    const repo = await repoWith(1000);
    const service = new CreditsService(repo);
    const reservation = await service.reserveCredits(USER, 40, OP, { ttlMs: -1 });
    await repo.expireReservationV2(USER, reservation.id);
    await expect(service.releaseCredits(USER, reservation.id)).resolves.toBeUndefined();
  });

  it("surfaces a committed reservation rather than pretending to release it", async () => {
    const [service, reservation] = await held();
    await service.commitCredits(USER, reservation.id);
    await expect(service.releaseCredits(USER, reservation.id)).rejects.toMatchObject({
      code: CreditErrorCode.RESERVATION_ALREADY_PROCESSED,
    });
  });
});

// ==================== Blocker 8: balance invariants ====================

describe("balance invariants", () => {
  /** Corrupt `reserved` behind the repository's back, as a bad legacy write would. */
  async function withDriftedReserved(amount: number) {
    const repo = await repoWith(1000);
    const reservation = await repo.reserveCreditsV2({
      userId: USER,
      amount,
      operationType: OP,
      expiresAt: soon(),
    });
    if (reservation.outcome !== "created") throw new Error("setup failed");
    await repo.updateUserCredits(USER, { reserved: amount - 1 });
    return { repo, reservation: reservation.reservation };
  }

  it("refuses to commit a hold that reserved no longer covers", async () => {
    const { repo, reservation } = await withDriftedReserved(40);

    await expect(repo.commitReservationV2(USER, reservation.id)).rejects.toMatchObject({
      code: CreditErrorCode.DATABASE_ERROR,
    });

    // Nothing moved, and the reservation is still claimable.
    const credits = await repo.getUserCredits(USER);
    expect(credits?.balance).toBe(1000);
    expect(credits?.monthlyUsed).toBe(0);
    expect((await repo.getReservation(USER, reservation.id))?.status).toBe("reserved");
    expect(await repo.getJournalEntries({ userId: USER })).toHaveLength(0);
  });

  it("refuses to release a hold that reserved no longer covers", async () => {
    const { repo, reservation } = await withDriftedReserved(40);
    await expect(repo.releaseReservationV2(USER, reservation.id)).rejects.toMatchObject({
      code: CreditErrorCode.DATABASE_ERROR,
    });
    expect((await repo.getReservation(USER, reservation.id))?.status).toBe("reserved");
  });

  it("reports corruption as DATABASE_ERROR, never as INSUFFICIENT_CREDITS", async () => {
    const { repo, reservation } = await withDriftedReserved(40);
    const error = await repo.commitReservationV2(USER, reservation.id).catch((e) => e);
    expect(isCreditError(error)).toBe(true);
    expect(error.code).not.toBe(CreditErrorCode.INSUFFICIENT_CREDITS);
  });
});
