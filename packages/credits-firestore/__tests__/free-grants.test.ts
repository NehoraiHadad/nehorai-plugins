/**
 * The free-tier policy hooks and the atomic tier write, on a fake Firestore.
 *
 * Transactions here run one at a time, so the races are staged: `beforeRead`
 * changes the document after the caller's read and before the transaction's.
 * Real contention is covered by `free-grants.emulator.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    increment: (value: number) => ({ __op: "increment", value }),
    serverTimestamp: () => ({ __op: "serverTimestamp" }),
  },
}));

// Imported after the mock so the source picks up the mocked FieldValue.
import { CreditErrorCode } from "@nehorai/credits";
import {
  FirestoreCreditRepository,
  getNextMonthStart,
  type FirestoreRepositoryOptions,
} from "../src";

type Doc = Record<string, unknown>;

const USER = "u1";
const PATH = `users/${USER}/credits/balance`;
const PAST_DUE = new Date(Date.now() - 86_400_000).toISOString();
const LONG_EXPIRED = new Date(Date.now() - 400 * 86_400_000).toISOString();

function makeFakeDb(seed: Doc) {
  const store = new Map<string, Doc>([[PATH, { ...seed }]]);
  const fake = {
    writes: 0,
    transactions: 0,
    holdQueries: 0,
    autoIds: 0,
    beforeRead: undefined as (() => void) | undefined,
    failHoldQueries: undefined as Error | undefined,
  };

  const write = (path: string, updates: Doc) => {
    fake.writes++;
    const next: Doc = { ...store.get(path) };
    for (const [key, value] of Object.entries(updates)) {
      next[key] = (value as Doc | null)?.__op === "serverTimestamp" ? "SERVER_TS" : value;
    }
    store.set(path, next);
  };
  const docRef = (path: string): any => ({
    path,
    collection: (name: string) => collectionRef(`${path}/${name}`),
    update: async (updates: Doc) => write(path, updates),
  });
  const collectionRef = (path: string): any => ({
    doc: (id?: string) => docRef(`${path}/${id ?? `auto-${++fake.autoIds}`}`),
    where: (field: string, _op: string, value: unknown) => {
      const query = { path, field, value, isQuery: true, select: () => query };
      return query;
    },
  });
  const transaction = {
    async get(ref: any) {
      fake.beforeRead?.();
      if (ref.isQuery) {
        fake.holdQueries++;
        if (fake.failHoldQueries) throw fake.failHoldQueries;
        const docs = [...store.entries()]
          .filter(([path, doc]) => path.startsWith(`${ref.path}/`) && doc[ref.field] === ref.value)
          .map(([path, doc]) => ({ id: path.split("/").pop(), data: () => ({ ...doc }) }));
        return { docs };
      }
      const data = store.get(ref.path);
      return { exists: data !== undefined, data: () => (data ? { ...data } : undefined) };
    },
    update: (ref: any, updates: Doc) => write(ref.path, updates),
    set: (ref: any, data: Doc) => write(ref.path, data),
  };

  const db: any = {
    collection: (name: string) => collectionRef(name),
    runTransaction: async (fn: (t: typeof transaction) => Promise<unknown>) => {
      fake.transactions++;
      return fn(transaction);
    },
  };
  return { db, fake, read: () => store.get(PATH)!, patch: (doc: Doc) => write(PATH, doc) };
}

function account(overrides: Doc = {}): Doc {
  return {
    userId: USER,
    balance: 7,
    bonusCredits: 4,
    reserved: 0,
    tier: "free",
    monthlyLimit: 25,
    monthlyUsed: 2,
    monthlyResetAt: PAST_DUE,
    subscriptionExpiresAt: null,
    createdAt: PAST_DUE,
    updatedAt: PAST_DUE,
    ...overrides,
  };
}

function setup(seed: Doc, options: FirestoreRepositoryOptions = {}) {
  const fake = makeFakeDb(seed);
  return { ...fake, repo: new FirestoreCreditRepository(fake.db, options) };
}

const tierLimits: Record<string, number> = { free: 25, premium: 500 };
const getMonthlyLimit = (tier: string) => tierLimits[tier]!;

describe("atomicMonthlyReset uses the tier read inside the transaction", () => {
  it("gives a free account its own limit when the argument still names the paid tier", async () => {
    // Reproduced before the fix: 25 became 500 and stayed free.
    const { repo, read } = setup(account({ balance: 25 }), { getMonthlyLimit });

    const result = await repo.atomicMonthlyReset(USER, "premium", PAST_DUE);

    expect(result.wasReset).toBe(true);
    expect(result.credits.balance).toBe(25);
    expect(read().balance).toBe(25);
    expect(read().tier).toBe("free");
  });

  it("sees a downgrade that lands between the caller's read and the transaction", async () => {
    const { repo, fake, read, patch } = setup(account({ tier: "premium", balance: 300 }), {
      getMonthlyLimit,
    });
    fake.beforeRead = () => {
      fake.beforeRead = undefined;
      patch({ tier: "free", balance: 25 });
    };

    await repo.atomicMonthlyReset(USER, "premium", PAST_DUE);

    expect(read().balance).toBe(25);
  });

  it("falls back to the stored limit when no getMonthlyLimit is given", async () => {
    const { repo, read } = setup(account());

    await repo.atomicMonthlyReset(USER, "premium", PAST_DUE);

    expect(read().balance).toBe(25);
    expect(read().monthlyUsed).toBe(0);
  });
});

describe("resolveMonthlyReset", () => {
  it("null: no reset and no write", async () => {
    const { repo, fake, read } = setup(account(), { resolveMonthlyReset: () => null });
    const before = { ...read() };

    const result = await repo.atomicMonthlyReset(USER, "free", PAST_DUE);

    expect(result.wasReset).toBe(false);
    expect(result.credits.monthlyResetAt).toBe(PAST_DUE);
    expect(fake.writes).toBe(0);
    expect(read()).toEqual(before);
  });

  it("receives the balance and tier read inside the transaction", async () => {
    const resolveMonthlyReset = vi.fn(() => null);
    const { repo } = setup(account(), { resolveMonthlyReset });

    await repo.atomicMonthlyReset(USER, "premium", PAST_DUE);

    expect(resolveMonthlyReset).toHaveBeenCalledWith({ tier: "free", balance: 7 });
  });

  it("takes precedence over getMonthlyLimit", async () => {
    const limit = vi.fn(getMonthlyLimit);
    const { repo, read } = setup(account(), {
      getMonthlyLimit: limit,
      resolveMonthlyReset: () => ({ balance: 40 }),
    });

    await repo.atomicMonthlyReset(USER, "free", PAST_DUE);

    expect(limit).not.toHaveBeenCalled();
    expect(read().balance).toBe(40);
  });

  it("a result without monthlyLimit does not write the field", async () => {
    const { repo, read } = setup(account(), { resolveMonthlyReset: () => ({ balance: 40 }) });

    const result = await repo.atomicMonthlyReset(USER, "free", PAST_DUE);

    expect(result.wasReset).toBe(true);
    expect(result.credits.balance).toBe(40);
    expect(result.credits.monthlyLimit).toBe(25);
    expect(read().balance).toBe(40);
    expect(read().monthlyLimit).toBe(25);
    expect(read().monthlyUsed).toBe(0);
    expect(read().bonusCredits).toBe(4);
    expect(new Date(read().monthlyResetAt as string).getTime()).toBeGreaterThan(Date.now());
  });

  it("a result with monthlyLimit writes it, including 0", async () => {
    const { repo, read } = setup(account(), {
      resolveMonthlyReset: () => ({ balance: 7, monthlyLimit: 0 }),
    });

    const result = await repo.atomicMonthlyReset(USER, "free", PAST_DUE);

    expect(result.credits.monthlyLimit).toBe(0);
    expect(read().monthlyLimit).toBe(0);
    expect(read().balance).toBe(7);
  });

  it("a throw aborts the transaction", async () => {
    const { repo, fake } = setup(account(), {
      resolveMonthlyReset: () => {
        throw new Error("no settings");
      },
    });

    await expect(repo.atomicMonthlyReset(USER, "free", PAST_DUE)).rejects.toThrow("no settings");
    expect(fake.writes).toBe(0);
  });

  it("is not consulted when the reset is not due or was already done", async () => {
    const resolveMonthlyReset = vi.fn(() => ({ balance: 40 }));
    const notDue = new Date(Date.now() + 86_400_000).toISOString();

    const fresh = setup(account({ monthlyResetAt: notDue }), { resolveMonthlyReset });
    expect((await fresh.repo.atomicMonthlyReset(USER, "free", notDue)).wasReset).toBe(false);

    const stale = setup(account(), { resolveMonthlyReset });
    expect((await stale.repo.atomicMonthlyReset(USER, "free", LONG_EXPIRED)).wasReset).toBe(false);

    expect(resolveMonthlyReset).not.toHaveBeenCalled();
  });

  it.each([
    ["a negative balance", { balance: -1 }],
    ["an off-grid balance", { balance: 1.005 }],
    ["an infinite balance", { balance: Infinity }],
    ["a negative monthlyLimit", { balance: 1, monthlyLimit: -1 }],
  ])("refuses %s and writes nothing", async (_name, decision) => {
    const { repo, fake } = setup(account(), { resolveMonthlyReset: () => decision });

    await expect(repo.atomicMonthlyReset(USER, "free", PAST_DUE)).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_AMOUNT,
    });
    expect(fake.writes).toBe(0);
  });

  it("does not cut through the credits backing a live hold", async () => {
    const { repo, read } = setup(account({ balance: 100, bonusCredits: 10, reserved: 60 }), {
      resolveMonthlyReset: () => ({ balance: 0 }),
    });

    await repo.atomicMonthlyReset(USER, "free", PAST_DUE);

    expect(read().balance).toBe(50);
  });
});

describe("getDowngradeBalanceCap", () => {
  const expired = (overrides: Doc = {}) =>
    account({
      tier: "premium",
      balance: 400,
      monthlyLimit: 500,
      monthlyResetAt: new Date(Date.now() + 86_400_000).toISOString(),
      subscriptionExpiresAt: LONG_EXPIRED,
      ...overrides,
    });

  it("sets both the balance cap and monthlyLimit", async () => {
    const { repo, read } = setup(expired(), { getDowngradeBalanceCap: () => 10 });

    const result = await repo.checkAndHandleSubscriptionExpiry(USER, 3);

    expect(result.wasDowngraded).toBe(true);
    expect(result.credits.balance).toBe(10);
    expect(result.credits.monthlyLimit).toBe(10);
    expect(read().tier).toBe("free");
    expect(read().balance).toBe(10);
    expect(read().monthlyLimit).toBe(10);
    expect(read().bonusCredits).toBe(4);
  });

  it("accepts 0, which is not the same as the option being absent", async () => {
    const { repo, read } = setup(expired(), { getDowngradeBalanceCap: () => 0 });

    await repo.checkAndHandleSubscriptionExpiry(USER, 3);

    expect(read().balance).toBe(0);
    expect(read().monthlyLimit).toBe(0);
  });

  it("does not raise a balance already under the cap", async () => {
    const { repo, read } = setup(expired({ balance: 4 }), { getDowngradeBalanceCap: () => 10 });

    await repo.checkAndHandleSubscriptionExpiry(USER, 3);

    expect(read().balance).toBe(4);
    expect(read().monthlyLimit).toBe(10);
  });

  it("keeps DEFAULT_FREE_CREDITS without the option", async () => {
    const { repo, read } = setup(expired());

    await repo.checkAndHandleSubscriptionExpiry(USER, 3);

    expect(read().balance).toBe(25);
    expect(read().monthlyLimit).toBe(25);
  });

  it("does not cut through the credits backing a live hold", async () => {
    const { repo, read } = setup(expired({ bonusCredits: 0, reserved: 60 }), {
      getDowngradeBalanceCap: () => 0,
    });

    await repo.checkAndHandleSubscriptionExpiry(USER, 3);

    expect(read().balance).toBe(60);
  });

  it("is consulted only for a downgrade that happens", async () => {
    const getDowngradeBalanceCap = vi.fn(() => 10);
    const { repo } = setup(expired({ subscriptionExpiresAt: new Date(Date.now() + 86_400_000).toISOString() }), {
      getDowngradeBalanceCap,
    });

    await repo.checkAndHandleSubscriptionExpiry(USER, 3);

    expect(getDowngradeBalanceCap).not.toHaveBeenCalled();
  });

  it("refuses a negative cap and writes nothing", async () => {
    const { repo, fake } = setup(expired(), { getDowngradeBalanceCap: () => -1 });

    await expect(repo.checkAndHandleSubscriptionExpiry(USER, 3)).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_AMOUNT,
    });
    expect(fake.writes).toBe(0);
  });
});

describe("getNextMonthStart", () => {
  it("31 January gives 1 February, not 1 March", () => {
    expect(getNextMonthStart(new Date(2027, 0, 31, 15, 30))).toEqual(new Date(2027, 1, 1));
  });
});

describe("updateUserTier", () => {
  const downgrade = { tier: "free", monthlyLimit: 25 };

  it("leaves the balance alone when it does not change it", async () => {
    const { repo, read } = setup(account({ tier: "premium", balance: 400 }));

    await repo.updateUserTier(USER, downgrade);

    expect(read().balance).toBe(400);
    expect(read().tier).toBe("free");
  });

  it("writes balance from the stored holds, in a transaction", async () => {
    const { repo, fake, read } = setup(account({ tier: "premium", balance: 400, reserved: 80 }));

    await repo.updateUserTier(USER, { ...downgrade, balance: 25 });

    expect(fake.transactions).toBe(1);
    expect(read().balance).toBe(76);
    // `reserved` here has no placed holds to carry a share. What the floor kept stays
    // marked regardless, so a later close or correction does not make it spendable.
    expect(read().expiredHoldBacking).toBe(51);
  });

  it("lowers a paid account's balance in a transaction", async () => {
    const { repo, fake, read } = setup(account({ tier: "premium", balance: 400 }));

    await repo.updateUserTier(USER, { ...downgrade, balanceCap: 25, monthlyUsed: 0 });

    expect(fake.transactions).toBe(1);
    expect(fake.holdQueries).toBe(0);
    expect(read().balance).toBe(25);
    expect(read().tier).toBe("free");
    expect(read().monthlyLimit).toBe(25);
    expect(read().monthlyUsed).toBe(0);
  });

  it("does not write back a balance a charge has spent", async () => {
    // Reproduced before: read 20, charge to 0, the downgrade wrote 20 back.
    const { repo, fake, read, patch } = setup(account({ tier: "premium", balance: 20 }));
    fake.beforeRead = () => {
      fake.beforeRead = undefined;
      patch({ balance: 0 });
    };

    await repo.updateUserTier(USER, { ...downgrade, balanceCap: 25 });

    expect(read().balance).toBe(0);
  });

  it("is ignored for an account already free, and the rest of the write applies", async () => {
    const { repo, read } = setup(account({ tier: "free", balance: 400 }));

    await repo.updateUserTier(USER, { tier: "free", monthlyLimit: 50, balanceCap: 25 });

    expect(read().balance).toBe(400);
    expect(read().monthlyLimit).toBe(50);
  });

  it("reads the tier inside the transaction, not before it", async () => {
    // Another downgrade and a top-up landed first: the account is free now.
    const { repo, fake, read, patch } = setup(account({ tier: "premium", balance: 20 }));
    fake.beforeRead = () => {
      fake.beforeRead = undefined;
      patch({ tier: "free", balance: 100 });
    };

    await repo.updateUserTier(USER, { ...downgrade, balanceCap: 25 });

    expect(read().balance).toBe(100);
  });

  it("does not cut through the credits backing a live hold", async () => {
    const { repo, read } = setup(account({ tier: "premium", balance: 100, bonusCredits: 10, reserved: 60 }));

    await repo.updateUserTier(USER, { ...downgrade, balanceCap: 25 });

    expect(read().balance).toBe(50);
  });

  it("refuses balance and balanceCap together before touching anything", async () => {
    const { repo, fake } = setup(account({ tier: "premium", balance: 400 }));

    await expect(
      repo.updateUserTier(USER, { ...downgrade, balance: 25, balanceCap: 25 })
    ).rejects.toMatchObject({ code: CreditErrorCode.INVALID_AMOUNT });

    expect(fake.transactions).toBe(0);
    expect(fake.writes).toBe(0);
  });

  it.each([-1, 1.005, Infinity, NaN])("refuses a cap of %s", async (balanceCap) => {
    const { repo, fake } = setup(account({ tier: "premium", balance: 400 }));

    await expect(
      repo.updateUserTier(USER, { ...downgrade, balanceCap })
    ).rejects.toMatchObject({ code: CreditErrorCode.INVALID_AMOUNT });
    expect(fake.writes).toBe(0);
  });

  it("reports a missing account from the transaction", async () => {
    const { db } = makeFakeDb(account());
    const repo = new FirestoreCreditRepository(db);

    await expect(
      repo.updateUserTier("nobody", { ...downgrade, balanceCap: 25 })
    ).rejects.toThrow("User credits not found");
  });
});


describe("the marked total on a write that does not set it", () => {
  const bad: Array<[number, number]> = [
    [-10, 0],
    [90, 20],
  ];

  it.each(bad)("a top-up repairs a stored %d to %d", async (stored, repaired) => {
    const { repo, read } = setup(account({ balance: 20, expiredHoldBacking: stored }));

    await repo.addCreditsAtomic(USER, 1, "top-up");

    expect(read()).toMatchObject({ balance: 20, bonusCredits: 5, expiredHoldBacking: repaired });
  });

  it.each(bad)("a tier write with no balance repairs a stored %d to %d", async (stored, repaired) => {
    const { repo, read } = setup(account({ balance: 20, expiredHoldBacking: stored }));

    await repo.updateUserTier(USER, { tier: "free", monthlyLimit: 25 });

    expect(read()).toMatchObject({ balance: 20, expiredHoldBacking: repaired });
  });

  it.each(bad)("a cap on a free account repairs a stored %d to %d", async (stored, repaired) => {
    const { repo, read } = setup(account({ balance: 20, expiredHoldBacking: stored }));

    await repo.updateUserTier(USER, { tier: "free", monthlyLimit: 25, balanceCap: 25 });

    expect(read()).toMatchObject({ balance: 20, expiredHoldBacking: repaired });
  });

  it("a sound total reads no hold on a write that does not change it", async () => {
    const { repo, fake, read } = setup(account({ balance: 80, expiredHoldBacking: 60 }));

    await repo.addCreditsAtomic(USER, 1, "top-up");
    await repo.updateUserTier(USER, { tier: "free", monthlyLimit: 25 });

    expect(fake.holdQueries).toBe(0);
    expect(read().expiredHoldBacking).toBe(60);
  });

  it("a tier write on a missing account still fails", async () => {
    const { db } = makeFakeDb(account());
    const repo = new FirestoreCreditRepository(db);

    await expect(repo.updateUserTier("nobody", { tier: "free", monthlyLimit: 25 })).rejects.toThrow(
      "User credits not found"
    );
  });
});

describe("a walk of the open holds that cannot finish", () => {
  it("fails the transaction: the error reaches the caller and nothing is written", async () => {
    const { repo, fake, read } = setup(account({ balance: 80, reserved: 60, expiredHoldBacking: 30 }));
    const before = { ...read() };
    fake.failHoldQueries = new Error("10 ABORTED: transaction has expired");
    fake.writes = 0;

    await expect(
      repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 500, balance: 0 })
    ).rejects.toThrow("transaction has expired");

    expect(fake.writes).toBe(0);
    expect(read()).toEqual(before);
  });
});
