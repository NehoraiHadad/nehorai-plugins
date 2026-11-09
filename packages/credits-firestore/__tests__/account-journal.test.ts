/**
 * The journal lines of account creation and of a tier write, on a fake Firestore that
 * buffers writes until commit and re-runs an attempt the way the SDK does. Real
 * contention is covered by `account-journal.emulator.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    serverTimestamp: () => "SERVER_TS",
  },
}));

import { CreditErrorCode } from "@nehorai/credits";
import { FirestoreCreditRepository } from "../src";

type Doc = Record<string, unknown>;

const USER = "u1";
const BALANCE = `users/${USER}/credits/balance`;
const JOURNAL = `users/${USER}/credits/data/journal/`;

function makeFakeDb(seed?: Doc) {
  const store = new Map<string, Doc>(seed ? [[BALANCE, seed]] : []);
  const fake = {
    attempts: 0,
    autoIds: 0,
    /** Runs at the next commit, then the attempt is thrown away and run again. */
    conflictOnce: undefined as (() => void) | undefined,
  };

  const docRef = (path: string): any => ({
    path,
    id: path.split("/").pop(),
    collection: (name: string) => collectionRef(`${path}/${name}`),
  });
  const collectionRef = (path: string): any => ({
    path,
    doc: (id?: string) => docRef(`${path}/${id ?? `auto-${++fake.autoIds}`}`),
    where: () => {
      const query = { isQuery: true, select: () => query };
      return query;
    },
  });

  const db: any = {
    collection: (name: string) => collectionRef(name),
    runTransaction: async (fn: (transaction: unknown) => Promise<unknown>) => {
      for (;;) {
        fake.attempts++;
        const writes: Array<[string, Doc]> = [];
        const read = (ref: any) => {
          const data = store.get(ref.path);
          return { exists: data !== undefined, data: () => (data ? { ...data } : undefined) };
        };
        const transaction = {
          get: async (ref: any) => (ref.isQuery ? { docs: [] } : read(ref)),
          getAll: async (...refs: any[]) => refs.map(read),
          create: (ref: any, data: Doc) => writes.push([ref.path, data]),
          set: (ref: any, data: Doc) => writes.push([ref.path, data]),
          update: (ref: any, data: Doc) =>
            writes.push([ref.path, { ...store.get(ref.path), ...data }]),
        };
        const result = await fn(transaction);
        if (fake.conflictOnce) {
          const conflict = fake.conflictOnce;
          fake.conflictOnce = undefined;
          conflict();
          continue;
        }
        for (const [path, data] of writes) store.set(path, data);
        return result;
      }
    },
  };

  const lines = () =>
    [...store.entries()].filter(([path]) => path.startsWith(JOURNAL)).map(([, doc]) => doc);
  return { db, fake, store, lines, repo: new FirestoreCreditRepository(db) };
}

function account(overrides: Doc = {}): Doc {
  return {
    userId: USER,
    balance: 25,
    bonusCredits: 0,
    reserved: 0,
    tier: "free",
    monthlyLimit: 25,
    monthlyUsed: 0,
    monthlyResetAt: new Date(Date.now() + 86_400_000).toISOString(),
    subscriptionExpiresAt: null,
    ...overrides,
  };
}

const CLAIM = "claims/hash";

describe("account creation", () => {
  it("journals the signup grant", async () => {
    const { repo, lines } = makeFakeDb();

    await repo.initializeUserCredits(USER, "free", 25);

    expect(lines()).toEqual([
      expect.objectContaining({
        userId: USER,
        entryType: "credit",
        amount: 25,
        balanceBefore: 0,
        balanceAfter: 25,
        source: "bonus",
        referenceId: `signup-${USER}`,
        referenceType: "adjustment",
        createdAt: "SERVER_TS",
      }),
    ]);
  });

  it("an attempt that is re-run leaves one line", async () => {
    const { repo, fake, lines } = makeFakeDb();
    fake.conflictOnce = () => {};

    await repo.initializeUserCredits(USER, "free", 25);

    expect(fake.attempts).toBe(2);
    expect(lines()).toHaveLength(1);
  });

  it("an attempt that loses to a concurrent creation adds no line", async () => {
    const { repo, fake, store, lines } = makeFakeDb();
    const winner = `${JOURNAL}winner`;
    fake.conflictOnce = () => {
      store.set(BALANCE, account());
      store.set(winner, { amount: 25 });
    };

    const credits = await repo.initializeUserCredits(USER, "free", 25);

    expect(credits.balance).toBe(25);
    expect(lines()).toEqual([{ amount: 25 }]);
  });

  it("a second call adds no line", async () => {
    const { repo, lines } = makeFakeDb();

    await repo.initializeUserCredits(USER, "free", 25);
    await repo.initializeUserCredits(USER, "free", 25);

    expect(lines()).toHaveLength(1);
  });

  it("a grant of 0 writes no line", async () => {
    const { repo, lines } = makeFakeDb();

    await repo.initializeUserCredits(USER, "free", 0);

    expect(lines()).toEqual([]);
  });

  it("a taken claim starts the account at 0 and writes no line", async () => {
    const { db, repo, store, lines } = makeFakeDb();
    const claim = db.collection("claims").doc("hash");
    store.set(CLAIM, { claimedAt: "before" });

    const credits = await repo.initializeUserCredits(USER, "free", 25, { signupGrantClaim: claim });

    expect(credits.balance).toBe(0);
    expect(lines()).toEqual([]);
  });

  it("a free claim journals the grant with the claim", async () => {
    const { db, repo, store, lines } = makeFakeDb();
    const claim = db.collection("claims").doc("hash");

    await repo.initializeUserCredits(USER, "free", 25, { signupGrantClaim: claim });

    expect(store.has(CLAIM)).toBe(true);
    expect(lines()).toEqual([expect.objectContaining({ amount: 25, balanceAfter: 25 })]);
  });

  it("a reserve that seeds the account journals the seed", async () => {
    const { repo, lines } = makeFakeDb();

    await repo.reserveCreditsAtomic(USER, 5, "audio_generation", new Date(Date.now() + 60_000));

    expect(lines()).toEqual([
      expect.objectContaining({ amount: 25, balanceBefore: 0, balanceAfter: 25, source: "bonus" }),
    ]);
  });

  it("a reserve refused on a missing account writes nothing", async () => {
    const { repo, lines, store } = makeFakeDb();

    await expect(
      repo.reserveCreditsAtomic(USER, 500, "audio_generation", new Date(Date.now() + 60_000))
    ).rejects.toMatchObject({ code: CreditErrorCode.INSUFFICIENT_CREDITS });

    expect(store.has(BALANCE)).toBe(false);
    expect(lines()).toEqual([]);
  });

  it("a credit that seeds the account journals the seed under its own line", async () => {
    const { repo, lines } = makeFakeDb();

    await repo.addCreditsAtomic(USER, 10, "first credit");

    const entries = lines();
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.source === "bonus")).toMatchObject({
      amount: 25,
      balanceBefore: 0,
      balanceAfter: 25,
    });
    expect(entries.find((entry) => entry.source === "purchase")).toMatchObject({
      amount: 10,
      balanceBefore: 25,
      balanceAfter: 35,
    });
  });

  it("a credit on an existing account writes no seed line", async () => {
    const { repo, lines } = makeFakeDb(account());

    await repo.addCreditsAtomic(USER, 10, "credit");

    expect(lines()).toEqual([expect.objectContaining({ source: "purchase" })]);
  });

  it("a paid credit that creates the account at 0 writes only its own line", async () => {
    const { repo, lines } = makeFakeDb();

    await repo.addCreditsIdempotent({
      userId: USER,
      amount: 10,
      description: "paid",
      paymentRef: "stripe:pi_1",
    });

    expect(lines()).toEqual([expect.objectContaining({ amount: 10, balanceBefore: 0 })]);
  });
});

describe("account creation with signupBonus", () => {
  it("stores the bonus in bonusCredits and the allotment as balance and monthlyLimit", async () => {
    const { repo, store, lines } = makeFakeDb();

    const credits = await repo.initializeUserCredits(USER, "free", 10, { signupBonus: 65 });

    expect(credits).toMatchObject({ balance: 10, bonusCredits: 65, monthlyLimit: 10 });
    expect(store.get(BALANCE)).toMatchObject({ balance: 10, bonusCredits: 65, monthlyLimit: 10 });
    expect(lines()).toEqual([
      expect.objectContaining({
        amount: 10,
        balanceBefore: 0,
        balanceAfter: 10,
        metadata: { tier: "free", bucket: "balance" },
      }),
      expect.objectContaining({
        entryType: "credit",
        amount: 65,
        balanceBefore: 10,
        balanceAfter: 75,
        source: "bonus",
        referenceId: `signup-${USER}`,
        referenceType: "adjustment",
        metadata: { tier: "free", bucket: "bonus" },
      }),
    ]);
  });

  it("a free claim writes the claim, the bonus and its line in one commit", async () => {
    const { db, repo, fake, store, lines } = makeFakeDb();
    const claim = db.collection("claims").doc("hash");

    await repo.initializeUserCredits(USER, "free", 0, { signupBonus: 65, signupGrantClaim: claim });

    expect(fake.attempts).toBe(1);
    expect(store.get(CLAIM)).toEqual({ claimedAt: "SERVER_TS" });
    expect(store.get(BALANCE)).toMatchObject({ balance: 0, bonusCredits: 65, signupGrant: 65 });
    expect(lines()).toEqual([
      expect.objectContaining({ amount: 65, metadata: { tier: "free", bucket: "bonus" } }),
    ]);
  });

  it("a taken claim gives bonus 0, writes no claim, and journals only the allotment", async () => {
    const { db, repo, store, lines } = makeFakeDb();
    const claim = db.collection("claims").doc("hash");
    store.set(CLAIM, { claimedAt: "before" });

    const credits = await repo.initializeUserCredits(USER, "free", 25, {
      signupBonus: 65,
      signupGrantClaim: claim,
    });

    expect(credits).toMatchObject({ balance: 25, bonusCredits: 0 });
    expect(store.get(CLAIM)).toEqual({ claimedAt: "before" });
    expect(store.get(BALANCE)).not.toHaveProperty("signupGrant");
    expect(lines()).toEqual([
      expect.objectContaining({ amount: 25, metadata: { tier: "free", bucket: "balance" } }),
    ]);
  });

  it("a re-run attempt leaves one claim, one bonus and one line", async () => {
    const { db, repo, fake, store, lines } = makeFakeDb();
    const claim = db.collection("claims").doc("hash");
    fake.conflictOnce = () => {};

    await repo.initializeUserCredits(USER, "free", 0, { signupBonus: 65, signupGrantClaim: claim });

    expect(fake.attempts).toBe(2);
    expect(store.get(BALANCE)).toMatchObject({ bonusCredits: 65 });
    expect(lines()).toHaveLength(1);
  });

  it("refuses an off-grid bonus before the transaction", async () => {
    const { repo, fake, store } = makeFakeDb();

    await expect(
      repo.initializeUserCredits(USER, "free", 0, { signupBonus: 0.005 })
    ).rejects.toMatchObject({ code: CreditErrorCode.INVALID_AMOUNT });

    expect(fake.attempts).toBe(0);
    expect(store.size).toBe(0);
  });

  it("without signupBonus a free claim still grants into balance, as in 3.1.0", async () => {
    const { db, repo, store, lines } = makeFakeDb();
    const claim = db.collection("claims").doc("hash");

    await repo.initializeUserCredits(USER, "free", 25, { signupGrantClaim: claim });

    expect(store.get(BALANCE)).toMatchObject({ balance: 25, bonusCredits: 0, signupGrant: 25 });
    expect(lines()).toEqual([expect.objectContaining({ amount: 25, metadata: { tier: "free" } })]);
  });
});

describe("a tier write", () => {
  it("journals a raise: credit, the balance it set, in the same commit", async () => {
    const { repo, store, lines } = makeFakeDb(account());

    await repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 100, balance: 100 });

    expect(store.get(BALANCE)?.balance).toBe(100);
    expect(lines()).toEqual([
      expect.objectContaining({
        entryType: "credit",
        amount: 100,
        balanceBefore: 25,
        balanceAfter: 100,
        source: "subscription_upgrade",
        referenceType: "subscription",
      }),
    ]);
  });

  it("journals a cap: debit, amount 0, the totals moved", async () => {
    const { repo, lines } = makeFakeDb(account({ tier: "premium", balance: 400 }));

    await repo.updateUserTier(USER, { tier: "free", monthlyLimit: 25, balanceCap: 25 });

    expect(lines()).toEqual([
      expect.objectContaining({
        entryType: "debit",
        amount: 0,
        balanceBefore: 400,
        balanceAfter: 25,
        source: "subscription_downgrade",
      }),
    ]);
  });

  it("records balance + bonusCredits and does not subtract reserved", async () => {
    const { repo, lines } = makeFakeDb(account({ bonusCredits: 10, reserved: 5 }));

    await repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 100, balance: 100 });

    expect(lines()).toEqual([
      expect.objectContaining({ amount: 100, balanceBefore: 35, balanceAfter: 110 }),
    ]);
  });

  it("decides from the document read in the attempt that commits", async () => {
    const { repo, fake, store, lines } = makeFakeDb(account());
    fake.conflictOnce = () => store.set(BALANCE, account({ balance: 40 }));

    await repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 100, balance: 100 });

    expect(fake.attempts).toBe(2);
    expect(lines()).toEqual([expect.objectContaining({ balanceBefore: 40, balanceAfter: 100 })]);
  });

  it("an attempt that is re-run to an unmoved balance writes no line", async () => {
    const { repo, fake, store, lines } = makeFakeDb(account());
    fake.conflictOnce = () => store.set(BALANCE, account({ balance: 100 }));

    await repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 100, balance: 100 });

    expect(lines()).toEqual([]);
  });

  it.each([
    ["no balance in the write", { tier: "premium", monthlyLimit: 500 }],
    ["the same balance", { tier: "premium", monthlyLimit: 500, balance: 25 }],
    ["a cap above the balance", { tier: "premium", monthlyLimit: 500, balanceCap: 100 }],
  ])("writes no line with %s", async (_name, input) => {
    const { repo, lines } = makeFakeDb(account({ tier: "standard" }));

    await repo.updateUserTier(USER, input);

    expect(lines()).toEqual([]);
  });

  it("writes no line for a cap on an account already free", async () => {
    const { repo, lines } = makeFakeDb(account({ balance: 100 }));

    await repo.updateUserTier(USER, { tier: "free", monthlyLimit: 25, balanceCap: 25 });

    expect(lines()).toEqual([]);
  });

  it("refuses the whole write when the total cannot be recorded", async () => {
    const { repo, store, lines } = makeFakeDb(account({ bonusCredits: 9_999_999_999 }));

    await expect(
      repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 100, balance: 100 })
    ).rejects.toMatchObject({ code: CreditErrorCode.INVALID_AMOUNT });

    expect(store.get(BALANCE)?.balance).toBe(25);
    expect(lines()).toEqual([]);
  });
});
