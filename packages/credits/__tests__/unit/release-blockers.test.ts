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

  it("reports the missing capability even when the amount is also invalid", async () => {
    // A caller who asked for a guarantee this repository cannot give should
    // hear that, not whichever other complaint the arguments happen to trip
    // first — otherwise fixing the amount just reveals the real problem later.
    const reserveSpy = vi.fn();
    const repo = legacyRepo({ reserveCreditsAtomic: reserveSpy as never });
    const service = new CreditsService(repo);

    await expect(
      service.reserveCredits(USER, 0, OP, { idempotencyKey: "job-1" })
    ).rejects.toMatchObject({ code: CreditErrorCode.UNSUPPORTED_OPERATION });
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

  it("is a no-op when the reservation was already committed", async () => {
    // The pre-V2 contract: any terminal status makes the legacy wrapper a
    // no-op. Callers that retry a release after a commit landed depend on it,
    // so throwing here would be a breaking change dressed up as a fix.
    const [service, reservation] = await held();
    await service.commitCredits(USER, reservation.id);
    await expect(service.releaseCredits(USER, reservation.id)).resolves.toBeUndefined();
  });

  it("leaves the committed balance untouched when a late release arrives", async () => {
    const [service, reservation, repo] = await held();
    await service.commitCredits(USER, reservation.id);
    const after = await repo.getUserCredits(USER);
    await service.releaseCredits(USER, reservation.id);
    const later = await repo.getUserCredits(USER);
    expect(later?.balance).toBe(after?.balance);
    expect(later?.reserved).toBe(after?.reserved);
    expect(later?.monthlyUsed).toBe(after?.monthlyUsed);
  });

  it("still exposes the committed conflict through releaseCreditsDetailed", async () => {
    const [service, reservation] = await held();
    await service.commitCredits(USER, reservation.id);
    const outcome = await service.releaseCreditsDetailed(USER, reservation.id);
    expect(outcome).toMatchObject({ outcome: "already_terminal", terminalStatus: "committed" });
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

    // Asserting only the status would let a mutant decrement `reserved` to -1
    // or write a journal row and still pass, as long as it threw before the
    // status flip. The claim is that *nothing* moved, so assert that.
    const credits = await repo.getUserCredits(USER);
    expect(credits?.reserved).toBe(39);
    expect(credits?.balance).toBe(1000);
    const held = await repo.getReservation(USER, reservation.id);
    expect(held?.status).toBe("reserved");
    expect(held?.completedAt).toBeUndefined();
    expect(await repo.getJournalEntries({ userId: USER })).toHaveLength(0);
  });

  it("refuses to expire a hold that reserved no longer covers", async () => {
    // Expire is a separate transition with its own balance write, so a guard
    // bypass there would go unnoticed by the commit and release tests.
    const { repo, reservation } = await withDriftedReserved(40);
    // `asOf` in the future makes the hold due without waiting on a clock.
    await expect(
      repo.expireReservationV2(USER, reservation.id, { asOf: new Date(Date.now() + 600_000) })
    ).rejects.toMatchObject({ code: CreditErrorCode.DATABASE_ERROR });

    const credits = await repo.getUserCredits(USER);
    expect(credits?.reserved).toBe(39);
    expect(credits?.balance).toBe(1000);
    const held = await repo.getReservation(USER, reservation.id);
    expect(held?.status).toBe("reserved");
    expect(held?.completedAt).toBeUndefined();
    expect(await repo.getJournalEntries({ userId: USER })).toHaveLength(0);
  });

  it("reports corruption as DATABASE_ERROR, never as INSUFFICIENT_CREDITS", async () => {
    const { repo, reservation } = await withDriftedReserved(40);
    const error = await repo.commitReservationV2(USER, reservation.id).catch((e) => e);
    expect(isCreditError(error)).toBe(true);
    expect(error.code).not.toBe(CreditErrorCode.INSUFFICIENT_CREDITS);
  });
});

/**
 * The legacy (non-V2) path, driven through an adapter that behaves the way the
 * contract warns legacy adapters may: it refuses to release a reservation it
 * has already processed.
 *
 * `releaseCredits` is specified as a silent no-op there. Returning the typed
 * outcome is not enough on its own — the refusal happens before the outcome is
 * built, so it has to be swallowed rather than propagated.
 */
describe("legacy release against an adapter that rejects processed holds", () => {
  function legacyRepo(status: "committed" | "released" | "expired") {
    const reservation = {
      id: "r-legacy",
      userId: "u-legacy",
      amount: 10,
      operationType: "story_generation",
      status,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    let atomicCalls = 0;
    const repo = {
      getReservation: async () => reservation,
      releaseReservationAtomic: async () => {
        atomicCalls += 1;
        throw new Error(`Reservation ${reservation.id} is already ${status}`);
      },
      getUserCredits: async () => ({ userId: "u-legacy", balance: 100 }),
      createJournalEntry: async () => ({ id: "j-1" }),
    } as unknown as ICreditRepository;
    return { repo, reservation, calls: () => atomicCalls };
  }

  for (const status of ["committed", "released", "expired"] as const) {
    it(`is a silent no-op for a ${status} reservation`, async () => {
      const { repo } = legacyRepo(status);
      const service = new CreditsService(repo);
      await expect(service.releaseCredits("u-legacy", "r-legacy")).resolves.toBeUndefined();
    });

    it(`still calls through to the adapter for ${status}`, async () => {
      const { repo, calls } = legacyRepo(status);
      await new CreditsService(repo).releaseCredits("u-legacy", "r-legacy");
      expect(calls()).toBe(1);
    });
  }

  it("still reports the committed conflict through releaseCreditsDetailed", async () => {
    const { repo } = legacyRepo("committed");
    const outcome = await new CreditsService(repo).releaseCreditsDetailed(
      "u-legacy",
      "r-legacy"
    );
    expect(outcome).toMatchObject({ outcome: "already_terminal", terminalStatus: "committed" });
  });
});

/**
 * The legacy commit path builds its journal entry by hand, so it needs the same
 * protection the V2 transitions have: caller metadata must not be able to name
 * an amount the transition never moved.
 */
describe("legacy commit metadata", () => {
  it("records the reserved amount, not the caller's", async () => {
    const reservation = {
      id: "r-meta",
      userId: "u-meta",
      amount: 10,
      operationType: "story_generation",
      status: "reserved",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    let written: any;
    const repo = {
      getReservation: async () => reservation,
      commitReservationAtomic: async () => undefined,
      getUserCredits: async () => ({ userId: "u-meta", balance: 90 }),
      createJournalEntry: async (entry: any) => {
        written = entry;
        return { id: "j-meta" };
      },
    } as any;

    await new CreditsService(repo).commitCredits("u-meta", "r-meta", {
      metadata: { operationType: "spoofed", amount: 999, note: "kept" },
    });

    expect(written.metadata).toMatchObject({
      operationType: "story_generation",
      amount: 10,
      note: "kept",
    });
  });
});
