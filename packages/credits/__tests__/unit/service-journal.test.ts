/**
 * What the service layer writes into the audit trail.
 *
 * Three defects lived here because nothing read the journal back after a
 * service-level operation: the monthly-reset delta was derived with float
 * subtraction and could refuse *after* the reset had already committed; the
 * downgrade and reset entries recorded `balance` alone while every other
 * journal writer records `balance + bonusCredits`; and the downgrade
 * description hard-coded "to free tier" even though the downgrade target is
 * configurable.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CreditsService,
  createInMemoryCreditRepository,
  initializeConfig,
  resetConfig,
} from "../../src/index.js";

const USER = "u-service-journal";

/** Long enough ago that no grace period covers it. */
const LONG_EXPIRED = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);

function configureWithDefault(
  defaultTier: "free" | "premium",
  freeMonthlyCredits = 10
) {
  initializeConfig({
    tierConfigs: {
      free: {
        tier: "free",
        monthlyCredits: freeMonthlyCredits,
        priceUsd: 0,
        features: [],
        isFree: true,
        isDefault: defaultTier === "free",
      },
      premium: {
        tier: "premium",
        monthlyCredits: 500,
        priceUsd: 19.99,
        features: [],
        isDefault: defaultTier === "premium",
      },
      unlimited: {
        tier: "unlimited",
        monthlyCredits: 0,
        priceUsd: 49.99,
        features: [],
        unlimited: true,
      },
    },
  } as never);
}

describe("the subscription-downgrade journal entry", () => {
  afterEach(() => {
    resetConfig();
  });

  async function downgrade() {
    const repo = createInMemoryCreditRepository();
    const service = new CreditsService(repo);
    await repo.initializeUserCredits(USER, "premium", 8);
    await repo.updateUserCredits(USER, {
      bonusCredits: 5,
      subscriptionExpiresAt: LONG_EXPIRED,
    });

    await service.getUserCredits(USER);

    const entries = await repo.getJournalEntries({ userId: USER });
    return entries.find((entry) => entry.source === "subscription_downgrade");
  }

  it("records the ledger balance, not the balance column alone", async () => {
    configureWithDefault("free");

    const entry = await downgrade();

    // Balance 8 (already under the free limit, so not clamped) plus 5 bonus
    // credits. Recording `balance` alone reported 8 and made this account's own
    // audit trail disagree with what add, deduct and the V2 transitions write.
    expect(entry?.balanceAfter).toBe(13);
  });

  it("names the tier actually downgraded to", async () => {
    configureWithDefault("premium");

    const entry = await downgrade();

    // The downgrade target is configurable. A hard-coded "to free tier" here
    // described a transition that never happened.
    expect(entry?.description).toContain("to premium tier");
    expect(entry?.description).not.toContain("to free tier");
  });
});

describe("the in-memory adapter's read isolation", () => {
  afterEach(() => {
    resetConfig();
  });

  it("returns a copy, so a later write cannot mutate an earlier read", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "free", 5);

    const before = await repo.getUserCredits(USER);
    await repo.updateUserCredits(USER, { balance: 9 });
    const after = await repo.getUserCredits(USER);

    // Handing out the live record made every "before" snapshot a lie. It is
    // what silently suppressed the monthly-reset journal entry below: the
    // service compared the reset balance against a value that had already
    // become the reset balance.
    expect(before?.balance).toBe(5);
    expect(after?.balance).toBe(9);
  });

  it("returns copies of every record type, not only user credits", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "free", 5);
    const held = await repo.reserveCreditsV2({
      userId: USER,
      amount: 1,
      operationType: "story_generation",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await repo.addCreditsAtomic(USER, 2, "top-up", "pay-copy");

    // Mutating anything handed back must not reach the store.
    const reservation = await repo.getReservation(USER, held.reservation!.id);
    reservation!.status = "committed";
    const [transaction] = await repo.getTransactions(USER);
    transaction.amount = 9999;
    const [entry] = await repo.getJournalEntries({ userId: USER });
    entry.amount = 9999;

    expect((await repo.getReservation(USER, held.reservation!.id))?.status).toBe("reserved");
    expect((await repo.getTransactions(USER))[0].amount).toBe(2);
    expect((await repo.getJournalEntries({ userId: USER }))[0].amount).toBe(2);
  });

  it("returns a copy from a usage log write, and from a V2 transition", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "free", 5);

    const log = await repo.logUsage({
      userId: USER,
      operationType: "story_generation",
      creditsUsed: 1,
      success: true,
    });
    log.creditsUsed = 9999;

    const held = await repo.reserveCreditsV2({
      userId: USER,
      amount: 1,
      operationType: "story_generation",
      expiresAt: new Date(Date.now() + 60_000),
    });
    held.reservation!.amount = 9999;

    expect((await repo.getUsageLogs({ userId: USER }))[0].creditsUsed).toBe(1);
    expect((await repo.getReservation(USER, held.reservation!.id))?.amount).toBe(1);
  });

  it("copies metadata in both directions", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "free", 5);
    const metadata: Record<string, unknown> = { invoice: "inv-1" };

    await repo.createJournalEntry({
      userId: USER,
      entryType: "credit",
      amount: 1,
      balanceAfter: 6,
      source: "purchase",
      referenceId: "ref-1",
      referenceType: "transaction",
      description: "top-up",
      metadata,
    });
    // The caller still holds its object and keeps using it.
    metadata.invoice = "inv-mutated";
    const [stored] = await repo.getJournalEntries({ userId: USER });
    (stored.metadata as Record<string, unknown>).invoice = "inv-read-mutated";

    const [reread] = await repo.getJournalEntries({ userId: USER });
    expect(reread.metadata).toEqual({ invoice: "inv-1" });
  });

  it("returns a copy from the reset result too", async () => {
    configureWithDefault("free");
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "free", 0.3);

    const before = await repo.getUserCredits(USER);
    const result = await repo.atomicMonthlyReset(USER, "free", before!.monthlyResetAt);

    expect(result.wasReset).toBe(true);
    expect(before?.balance).toBe(0.3);
    expect(result.credits.balance).toBe(10);
  });
});

describe("the monthly-reset journal entry", () => {
  afterEach(() => {
    resetConfig();
  });

  async function resetFrom(balance: number, bonusCredits: number) {
    const repo = createInMemoryCreditRepository();
    const service = new CreditsService(repo);
    await repo.initializeUserCredits(USER, "free", balance);
    await repo.updateUserCredits(USER, {
      bonusCredits,
      // Due: the reset window closed a day ago.
      monthlyResetAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    await service.getUserCredits(USER);

    const entries = await repo.getJournalEntries({ userId: USER });
    return { repo, entry: entries.find((e) => e.source === "monthly_reset") };
  }

  it("survives a delta that float subtraction puts off the cent grid", async () => {
    // The pair has to be awkward in the *delta*: resetting 0.3 up to 10 gives
    // 9.7, which raw subtraction reaches exactly. 0.3 - 0.1 does not.
    configureWithDefault("free", 0.3);

    // The reset commits before the journal entry is written, so a refused entry
    // left the account reset with no audit record of it at all.
    const { repo, entry } = await resetFrom(0.1, 0);

    expect(entry).toBeDefined();
    expect(entry?.amount).toBe(0.2);
    expect((await repo.getUserCredits(USER))?.balance).toBe(0.3);
  });

  it("records the ledger balance, not the balance column alone", async () => {
    configureWithDefault("free");

    const { entry } = await resetFrom(0.3, 5);

    expect(entry?.balanceAfter).toBe(15);
  });
});
