/**
 * Behavioral tests for the Firestore expiry path.
 *
 * These cover the race-safety fix: cleanup must settle each expired reservation
 * through a guarded transaction (`expireReservationAtomic`) that re-reads status,
 * NOT via an unconditional batch write that could decrement `reserved` twice when
 * a reservation is committed/released between discovery and settlement.
 *
 * A minimal in-memory fake Firestore models the only behaviours these functions
 * use: `runTransaction`, doc get/update/create, `collectionGroup().where()
 * .orderBy().startAfter().limit().get()`, and the FieldValue sentinels (mocked
 * below). Transactions run one at a time, standing in for Firestore's
 * isolation; the real contention behaviour is covered by the emulator suite.
 */
import { describe, it, expect, vi } from "vitest";

// Mock FieldValue so the fake `update` can interpret increment/serverTimestamp.
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    increment: (value: number) => ({ __op: "increment", value }),
    serverTimestamp: () => ({ __op: "serverTimestamp" }),
  },
}));

// Imported after the mock so the source picks up the mocked FieldValue.
import { ReservationAtomicOps, CleanupOps } from "../src";

type Doc = Record<string, unknown>;

function applyUpdate(current: Doc, updates: Doc): Doc {
  const next: Doc = { ...current };
  for (const [key, value] of Object.entries(updates)) {
    if (value && typeof value === "object" && (value as Doc).__op === "increment") {
      next[key] = ((next[key] as number) ?? 0) + ((value as Doc).value as number);
    } else if (value && typeof value === "object" && (value as Doc).__op === "serverTimestamp") {
      next[key] = "SERVER_TS";
    } else {
      next[key] = value;
    }
  }
  return next;
}

/** Build a fake Firestore seeded with docs keyed by full path. */
function makeFakeDb(seed: Record<string, Doc>) {
  const store = new Map<string, Doc>(Object.entries(seed).map(([k, v]) => [k, { ...v }]));

  const docRef = (path: string): any => ({
    path,
    id: path.split("/").pop(),
    collection: (name: string) => collectionRef(`${path}/${name}`),
  });
  const collectionRef = (path: string): any => ({
    path,
    doc: (id: string) => docRef(`${path}/${id}`),
  });

  let queue: Promise<unknown> = Promise.resolve();
  const txn = {
    async get(ref: any) {
      const data = store.get(ref.path);
      return { exists: data !== undefined, id: ref.id, ref, data: () => (data ? { ...data } : undefined) };
    },
    async getAll(...refs: any[]) {
      return Promise.all(refs.map((ref) => txn.get(ref)));
    },
    update(ref: any, updates: Doc) {
      store.set(ref.path, applyUpdate(store.get(ref.path) ?? {}, updates));
    },
    set(ref: any, data: Doc) {
      store.set(ref.path, { ...data });
    },
    create(ref: any, data: Doc) {
      if (store.has(ref.path)) throw new Error(`ALREADY_EXISTS: ${ref.path}`);
      store.set(ref.path, applyUpdate({}, data));
    },
  };

  const collectionGroup = (name: string) => {
    const filters: Array<{ field: string; op: string; value: unknown }> = [];
    let orderField: string | null = null;
    let limitN = Infinity;
    let afterPath: string | null = null;
    const q: any = {
      where(field: string, op: string, value: unknown) {
        filters.push({ field, op, value });
        return q;
      },
      orderBy(field: string) {
        orderField = field;
        return q;
      },
      limit(n: number) {
        limitN = n;
        return q;
      },
      startAfter(doc: { path: string }) {
        afterPath = doc.path;
        return q;
      },
      async get() {
        let rows = [...store.entries()]
          .filter(([path]) => {
            const segs = path.split("/");
            return segs.length >= 2 && segs[segs.length - 2] === name;
          })
          .map(([path, data]) => ({ path, data }));
        for (const f of filters) {
          rows = rows.filter(({ data }) => {
            const v = data[f.field];
            if (f.op === "==") return v === f.value;
            if (f.op === "<") return (v as string) < (f.value as string);
            return true;
          });
        }
        if (orderField) {
          // Ties broken by path, as Firestore breaks them by document name.
          rows.sort((a, b) => {
            const left = a.data[orderField!] as string;
            const right = b.data[orderField!] as string;
            if (left !== right) return left < right ? -1 : 1;
            return a.path < b.path ? -1 : 1;
          });
        }
        if (afterPath) {
          const anchor = store.get(afterPath) ?? {};
          const key = orderField ? (anchor[orderField] as string) : "";
          rows = rows.filter(({ path, data }) => {
            const value = orderField ? (data[orderField] as string) : "";
            return value > key || (value === key && path > afterPath!);
          });
        }
        rows = rows.slice(0, limitN);
        // Capture a snapshot copy so later store mutations don't change results.
        const snapshot = rows.map(({ path, data }) => ({ path, data: { ...data } }));
        if (typeof q._onGet === "function") q._onGet();
        return {
          docs: snapshot.map(({ path, data }) => ({
            id: path.split("/").pop(),
            path,
            data: () => data,
          })),
        };
      },
    };
    return q;
  };

  const db: any = {
    collection: (name: string) => collectionRef(name),
    runTransaction: (fn: any) => {
      const run = queue.then(() => fn(txn));
      queue = run.catch(() => undefined);
      return run;
    },
    collectionGroup,
    _store: store,
  };
  return db;
}

const past = new Date(Date.now() - 60_000).toISOString();
const future = new Date(Date.now() + 60_000).toISOString();

/** A row as the atomic reserve writes it: `holdPlacedAt` records the placed hold. */
function reservation(userId: string, amount: number, status: string, expiresAt: string): Doc {
  return {
    userId,
    amount,
    status,
    operationType: "audio_generation",
    createdAt: past,
    expiresAt,
    holdPlacedAt: past,
  };
}

describe("expireReservationAtomic", () => {
  it("releases reserved once and marks the reservation expired", async () => {
    const db = makeFakeDb({
      "users/u1/credits/balance": { reserved: 10, balance: 0, bonusCredits: 35 },
      "users/u1/reservations/r1": reservation("u1", 5, "reserved", past),
    });

    const result = await ReservationAtomicOps.expireReservationAtomic(db, "u1", "r1");

    expect(result).toEqual({ expired: true, amount: 5 });
    expect(db._store.get("users/u1/credits/balance").reserved).toBe(5);
    expect(db._store.get("users/u1/reservations/r1").status).toBe("expired");
  });

  it("is idempotent — a second call does not decrement reserved again", async () => {
    const db = makeFakeDb({
      "users/u1/credits/balance": { reserved: 10 },
      "users/u1/reservations/r1": reservation("u1", 5, "reserved", past),
    });

    await ReservationAtomicOps.expireReservationAtomic(db, "u1", "r1");
    const second = await ReservationAtomicOps.expireReservationAtomic(db, "u1", "r1");

    expect(second).toEqual({ expired: false, amount: 0 });
    expect(db._store.get("users/u1/credits/balance").reserved).toBe(5);
  });

  it("no-ops on an already-committed reservation (the race the fix prevents)", async () => {
    const db = makeFakeDb({
      "users/u1/credits/balance": { reserved: 0 }, // commit already released it
      "users/u1/reservations/r1": reservation("u1", 5, "committed", past),
    });

    const result = await ReservationAtomicOps.expireReservationAtomic(db, "u1", "r1");

    expect(result).toEqual({ expired: false, amount: 0 });
    expect(db._store.get("users/u1/credits/balance").reserved).toBe(0); // NOT -5
  });

  it("journals the expiry under its deterministic key", async () => {
    const db = makeFakeDb({
      "users/u1/credits/balance": { reserved: 5, balance: 20, bonusCredits: 0 },
      "users/u1/reservations/r1": reservation("u1", 5, "reserved", past),
    });

    await ReservationAtomicOps.expireReservationAtomic(db, "u1", "r1");

    const entry = db._store.get("users/u1/credits/data/journal/reservation:r1:expire");
    expect(entry).toMatchObject({
      entryType: "credit",
      amount: 0,
      balanceAfter: 20,
      source: "reservation_expired",
      referenceId: "r1",
      referenceType: "reservation",
      metadata: { operationType: "audio_generation", amount: 5 },
    });
  });

  it("refuses a row that does not record a placed hold, and changes nothing", async () => {
    const { holdPlacedAt: _omitted, ...unbacked } = reservation("u1", 5, "reserved", past);
    const db = makeFakeDb({
      "users/u1/credits/balance": { reserved: 5 },
      "users/u1/reservations/r1": unbacked,
    });

    await expect(ReservationAtomicOps.expireReservationAtomic(db, "u1", "r1")).rejects.toThrow(
      /holdPlacedAt is absent/
    );
    expect(db._store.get("users/u1/credits/balance").reserved).toBe(5);
    expect(db._store.get("users/u1/reservations/r1").status).toBe("reserved");
  });

  it("throws when the reservation does not exist", async () => {
    const db = makeFakeDb({ "users/u1/credits/balance": { reserved: 0 } });
    await expect(ReservationAtomicOps.expireReservationAtomic(db, "u1", "missing")).rejects.toThrow(
      /not found/
    );
  });
});

describe("findAndExpireReservations", () => {
  it("expires only reserved+past reservations and releases reserved exactly once", async () => {
    const db = makeFakeDb({
      "users/u1/credits/balance": { reserved: 15 },
      "users/u1/reservations/a": reservation("u1", 5, "reserved", past),
      "users/u1/reservations/b": reservation("u1", 10, "reserved", past),
      "users/u1/reservations/c": reservation("u1", 7, "committed", past), // wrong status
      "users/u1/reservations/d": reservation("u1", 3, "reserved", future), // not expired yet
    });

    const result = await CleanupOps.findAndExpireReservations(db);

    expect(result.expiredCount).toBe(2);
    expect(result.creditsReleased).toBe(15);
    expect(result.errors).toEqual([]);
    expect(db._store.get("users/u1/credits/balance").reserved).toBe(0); // 15 - 5 - 10
    expect(db._store.get("users/u1/reservations/a").status).toBe("expired");
    expect(db._store.get("users/u1/reservations/b").status).toBe("expired");
    expect(db._store.get("users/u1/reservations/c").status).toBe("committed");
    expect(db._store.get("users/u1/reservations/d").status).toBe("reserved");
  });

  it("pages past rows it refuses instead of re-selecting them", async () => {
    const unbacked = (amount: number) => {
      const { holdPlacedAt: _omitted, ...row } = reservation("u1", amount, "reserved", past);
      return row;
    };
    const db = makeFakeDb({
      "users/u1/credits/balance": { reserved: 7 },
      "users/u1/reservations/a": unbacked(1),
      "users/u1/reservations/b": unbacked(1),
      "users/u1/reservations/c": reservation("u1", 5, "reserved", past),
    });

    const result = await CleanupOps.findAndExpireReservations(db, 2, 5);

    expect(result.expiredCount).toBe(1);
    expect(db._store.get("users/u1/reservations/c").status).toBe("expired");
    expect(result.errors.filter((e) => e.includes("holdPlacedAt"))).toHaveLength(2);
  });

  it("does NOT double-decrement when a candidate is committed between discovery and settlement", async () => {
    // Reproduces the original bug: the query sees `g` as reserved, but a
    // concurrent finalize commits it (status->committed, reserved already
    // released) before cleanup settles. The old batch code would decrement
    // reserved a second time -> negative drift. The atomic re-read prevents it.
    const db = makeFakeDb({
      "users/u1/credits/balance": { reserved: 6 },
      "users/u1/reservations/g": reservation("u1", 6, "reserved", past),
    });

    // Inject the concurrent commit right after the discovery query returns.
    const realCollectionGroup = db.collectionGroup;
    db.collectionGroup = (name: string) => {
      const q = realCollectionGroup(name);
      q._onGet = () => {
        db._store.set("users/u1/reservations/g", {
          ...db._store.get("users/u1/reservations/g"),
          status: "committed",
        });
        db._store.set("users/u1/credits/balance", { reserved: 0 }); // commit released it
      };
      return q;
    };

    const result = await CleanupOps.findAndExpireReservations(db);

    expect(result.expiredCount).toBe(0);
    expect(result.creditsReleased).toBe(0);
    expect(db._store.get("users/u1/credits/balance").reserved).toBe(0); // NOT -6
  });
});
