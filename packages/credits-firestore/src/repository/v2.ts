import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Transaction,
} from "firebase-admin/firestore";
import {
  CreditError,
  CreditErrorCode,
  assertHoldPlaced,
  assertKnownReservationStatus,
  assertRepresentableFields,
  assertValidCreditAmount,
  assertValidIdempotencyKey,
  assertValidStoredAmount,
  expiredBackingPatch,
  getDefaultTier,
  getOperationLabel,
  holdExpiredBacking,
  holdPlacedAtAfter,
  lotTotalsOf,
  planHoldCommit,
  planLotDraws,
  planLotGrant,
  planLotRemoval,
  reservationJournalKey,
  sameAmount,
  settleExpiredHoldBacking,
  sumAmounts,
  terminalStatusOf,
} from "@nehorai/credits";
import type {
  CommitOutcome,
  CreditSource,
  ExpiredBackingFields,
  ExpireOutcome,
  ExpireReservationV2Options,
  LotLedgerOptions,
  PortableReservation,
  ReleaseOutcome,
  ReservationTransitionOptions,
  ReserveCreditsV2Input,
  ReserveOutcome,
} from "@nehorai/credits";
import {
  BALANCE_DOC_ID,
  COLLECTIONS,
  DEFAULT_FREE_CREDITS,
  getNextMonthStart,
  getUserCreditsCollection,
  getUserReservationsCollection,
} from "./shared.js";
import {
  assertMayCreateAccount,
  readStoredCredits,
  type AccountSeedOptions,
  type FirestoreUserCredits,
} from "./credits-doc.js";
import { readExpiredBacking } from "./hold-backing.js";
import { getUserJournalCollection, journalSignupGrantInTransaction } from "./journal.js";
import { toPortableReservation } from "./reservation-crud.js";
import { LotDriftReporter, lotBucketsAfter, planFirestoreLots, writeLotPlan } from "./lots.js";

/**
 * The V2 reservation boundary on Firestore.
 *
 * Each transition is one Firestore transaction that reads the reservation, the
 * balance and the transition's journal document, then — only if the status is
 * still `reserved` — writes all three. A concurrent caller's transaction
 * conflicts on the same documents, retries, re-reads the terminal status and
 * reports `already_terminal`. So exactly one caller moves the balance and
 * exactly one journal row exists, and a crash can never commit one without the
 * other.
 *
 * The journal document id is the deterministic `reservationJournalKey`, so even
 * a row written outside this module under that key is detected rather than
 * duplicated.
 *
 * Balances are written as exact values computed on the cent grid, not as
 * `FieldValue.increment`: increments add in IEEE 754 (`0.1 + 0.2` stores
 * `0.30000000000000004`), which the amount validators then refuse. Writing
 * values read earlier is safe here because a Firestore transaction fails and
 * retries if any document it read changed before it commits.
 */

/** Reservation-key index: `users/{userId}/reservation-keys/{sha256(key)}`. */
const RESERVATION_KEYS_COLLECTION = "reservation-keys";

function reservationKeyRef(db: Firestore, userId: string, idempotencyKey: string) {
  // Hashed because a caller key may contain `/`, which Firestore ids cannot.
  const id = createHash("sha256").update(idempotencyKey).digest("hex");
  return db
    .collection(COLLECTIONS.users)
    .doc(userId)
    .collection(RESERVATION_KEYS_COLLECTION)
    .doc(id);
}

interface BalanceFields {
  balance: number;
  bonusCredits: number;
  reserved: number;
  monthlyUsed: number;
  expiredHoldBacking: number;
  /** The marked credits as stored, which a write compares with to repair a bad value. */
  stored: ExpiredBackingFields;
}

function readBalance(doc: DocumentSnapshot): BalanceFields {
  const raw = (doc.data() ?? {}) as FirestoreUserCredits;
  const data = readStoredCredits(raw);
  return {
    balance: data.balance ?? 0,
    bonusCredits: data.bonusCredits ?? 0,
    reserved: data.reserved ?? 0,
    monthlyUsed: data.monthlyUsed ?? 0,
    expiredHoldBacking: data.expiredHoldBacking ?? 0,
    stored: raw,
  };
}

function readReservation(doc: DocumentSnapshot): PortableReservation {
  return toPortableReservation(doc.id, doc.data() ?? {});
}

/**
 * Every check a persisted reservation must pass before a transition touches it.
 *
 * Ahead of the `already_terminal` and `not_due` exits on purpose: both are
 * success outcomes, and reporting one over a corrupt or unbacked row tells the
 * caller the reservation is fine.
 */
function assertTrustworthy(reservation: PortableReservation, transition: string): void {
  assertKnownReservationStatus(reservation, transition);
  assertValidStoredAmount(reservation.amount, {
    userId: reservation.userId,
    reservationId: reservation.id,
    transition,
  });
  assertHoldPlaced(reservation, transition);
}

/**
 * Refuse a transition whose hold is no longer covered by `reserved`.
 *
 * Clamping instead would quietly consume the coverage of other live holds. The
 * error is `DATABASE_ERROR`, not `INSUFFICIENT_CREDITS`, because this is
 * corruption, not a user who ran out of money.
 */
function assertReservedCoversHold(
  credits: BalanceFields,
  userId: string,
  reservationId: string,
  amount: number
): void {
  if (credits.reserved >= amount) return;
  throw new CreditError(
    `Credit balance invariant violated for user ${userId} while processing ` +
      `reservation ${reservationId}: reserved (${credits.reserved}) is less ` +
      `than the hold (${amount}). The transition was rolled back.`,
    CreditErrorCode.DATABASE_ERROR,
    { userId, reservationId, amount, reserved: credits.reserved }
  );
}

function requireBalance(doc: DocumentSnapshot, userId: string): BalanceFields {
  if (!doc.exists) {
    throw new CreditError(
      `User credits not found for user ${userId}`,
      CreditErrorCode.USER_NOT_FOUND,
      { userId }
    );
  }
  return readBalance(doc);
}

interface JournalWrite {
  userId: string;
  operation: string;
  entryType: "debit" | "credit";
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  source: CreditSource;
  reservationId: string;
  description: string;
  metadata: Record<string, unknown>;
  idempotencyKey: string;
}

/** Name the first deterministic field an existing entry disagrees on, or `null`. */
function describeJournalMismatch(
  row: Record<string, unknown>,
  input: JournalWrite
): string | null {
  if (row.userId !== input.userId) return "user_id";
  if (row.entryType !== input.entryType) return "entry_type";
  if (!sameAmount(row.amount, input.amount)) return "amount";
  if (!sameAmount(row.balanceAfter, input.balanceAfter)) return "balance_after";
  if (row.source !== input.source) return "source";
  if (row.referenceId !== input.reservationId) return "reference_id";
  if (row.referenceType !== "reservation") return "reference_type";
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  if (meta.operationType !== input.metadata.operationType) return "metadata.operationType";
  if (!sameAmount(meta.amount, input.metadata.amount)) return "metadata.amount";
  return null;
}

/**
 * Decide the journal write from the snapshot read inside the transaction.
 *
 * Returns `true` when an identical entry already exists under the key (reuse
 * it), `false` when a fresh document is needed, and throws — before any write
 * is queued — when the key is taken by a different event.
 */
function planJournal(doc: DocumentSnapshot, input: JournalWrite): boolean {
  assertRepresentableFields(
    { amount: input.amount, "journal balanceAfter": input.balanceAfter },
    { userId: input.userId, reservationId: input.reservationId, operation: input.operation }
  );
  if (!doc.exists) return false;
  const mismatch = describeJournalMismatch(doc.data() ?? {}, input);
  if (mismatch) {
    throw new CreditError(
      `Journal key ${input.idempotencyKey} is already used by a different entry ` +
        `(${mismatch}). The transition was refused rather than reported as applied.`,
      CreditErrorCode.DATABASE_ERROR,
      { idempotencyKey: input.idempotencyKey, reservationId: input.reservationId, mismatch }
    );
  }
  return true;
}

function writeJournal(transaction: Transaction, ref: DocumentReference, input: JournalWrite) {
  transaction.create(ref, {
    userId: input.userId,
    entryType: input.entryType,
    amount: input.amount,
    balanceBefore: input.balanceBefore,
    balanceAfter: input.balanceAfter,
    source: input.source,
    referenceId: input.reservationId,
    referenceType: "reservation",
    description: input.description,
    metadata: input.metadata,
    idempotencyKey: input.idempotencyKey,
    createdAt: FieldValue.serverTimestamp(),
  });
}

function journalRef(db: Firestore, userId: string, key: string) {
  return getUserJournalCollection(db, userId).doc(key);
}

export async function reserveCreditsV2(
  db: Firestore,
  input: ReserveCreditsV2Input,
  seedOptions?: AccountSeedOptions & LotLedgerOptions
): Promise<ReserveOutcome> {
  const { userId, amount, operationType, idempotencyKey } = input;
  assertValidCreditAmount(amount, { userId });
  assertValidIdempotencyKey(idempotencyKey, { userId });

  const balanceRef = getUserCreditsCollection(db, userId).doc(BALANCE_DOC_ID);
  const reservationsCol = getUserReservationsCollection(db, userId);
  const keyRef = idempotencyKey ? reservationKeyRef(db, userId, idempotencyKey) : null;

  const report = new LotDriftReporter(seedOptions, userId, "reserveCredits");
  const outcome = await db.runTransaction(async (transaction): Promise<ReserveOutcome> => {
    report.begin();
    if (keyRef && idempotencyKey) {
      const keyDoc = await transaction.get(keyRef);
      if (keyDoc.exists) {
        const existingDoc = await transaction.get(
          reservationsCol.doc(keyDoc.get("reservationId") as string)
        );
        if (existingDoc.exists) {
          const existing = readReservation(existingDoc);
          // A row is only adoptable as a replay if its own reserve placed the hold.
          assertHoldPlaced(existing, "reserve replay");
          // `expiresAt` is excluded: a retry legitimately computes a later deadline.
          const samePayload =
            sameAmount(existing.amount, amount) && existing.operationType === operationType;
          return samePayload
            ? { outcome: "replayed", reservation: existing }
            : { outcome: "idempotency_conflict", idempotencyKey, existing };
        }
      }
    }

    const balanceDoc = await transaction.get(balanceRef);
    if (!balanceDoc.exists) assertMayCreateAccount(userId, seedOptions);
    // A first reserve seeds the account, as the legacy reserve always has.
    const credits: BalanceFields = balanceDoc.exists
      ? readBalance(balanceDoc)
      : {
          balance: DEFAULT_FREE_CREDITS,
          bonusCredits: 0,
          reserved: 0,
          monthlyUsed: 0,
          expiredHoldBacking: 0,
          stored: {},
        };

    const available = sumAmounts(credits.balance, credits.bonusCredits, -credits.reserved);
    if (available < amount) {
      return {
        outcome: "insufficient",
        available,
        required: amount,
        shortfall: sumAmounts(amount, -available),
      };
    }

    const nextReserved = sumAmounts(credits.reserved, amount);
    assertRepresentableFields({ reserved: nextReserved }, { userId, operation: "reserveCredits" });

    const backing = await readExpiredBacking(transaction, db, userId, credits);
    const reservationRef = reservationsCol.doc();
    // A reserve moves no credit, but it is a write: a seeded account opens its free lot,
    // an account without a ledger gets one, and one another writer left is reconciled.
    const raw = balanceDoc.exists ? (balanceDoc.data() as FirestoreUserCredits) : null;
    const lots = planFirestoreLots(seedOptions, {
      raw,
      after: lotBucketsAfter(credits.balance, credits.expiredHoldBacking, credits.bonusCredits),
      opRef: `reserve:${reservationRef.id}`,
      apply: raw
        ? undefined
        : (plan) =>
            planLotGrant(plan, {
              bucket: "balance",
              credits: credits.balance,
              spec: { funding: "free" },
              sourceType: "seed",
            }),
    });
    report.track(lots);
    const lotFields = writeLotPlan(transaction, db, userId, lots);
    const now = new Date().toISOString();
    const reservation: PortableReservation = {
      id: reservationRef.id,
      userId,
      amount,
      operationType,
      status: "reserved",
      createdAt: now,
      expiresAt: input.expiresAt.toISOString(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      // The hold-origin fact, written in the same transaction that raises
      // `reserved`, so the row and the hold become visible together.
      holdPlacedAt: holdPlacedAtAfter(now, backing.total > 0 ? backing.frontier : null),
    };

    if (!balanceDoc.exists) {
      const tier = getDefaultTier();
      transaction.set(balanceRef, {
        userId,
        balance: DEFAULT_FREE_CREDITS,
        bonusCredits: 0,
        reserved: nextReserved,
        tier,
        monthlyLimit: DEFAULT_FREE_CREDITS,
        monthlyUsed: 0,
        monthlyResetAt: getNextMonthStart(new Date()).toISOString(),
        subscriptionExpiresAt: null,
        ...lotFields,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      journalSignupGrantInTransaction(transaction, db, userId, tier, DEFAULT_FREE_CREDITS);
    } else {
      transaction.update(balanceRef, {
        reserved: nextReserved,
        ...expiredBackingPatch(backing, credits.stored),
        ...lotFields,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    transaction.create(reservationRef, reservation);
    if (keyRef) {
      transaction.set(keyRef, { reservationId: reservationRef.id, createdAt: now });
    }

    return { outcome: "created", reservation };
  });
  report.flush();
  return outcome;
}

export async function commitReservationV2(
  db: Firestore,
  userId: string,
  reservationId: string,
  options?: ReservationTransitionOptions,
  lotOptions?: LotLedgerOptions
): Promise<CommitOutcome> {
  const balanceRef = getUserCreditsCollection(db, userId).doc(BALANCE_DOC_ID);
  const reservationRef = getUserReservationsCollection(db, userId).doc(reservationId);
  const key = reservationJournalKey(reservationId, "commit");
  const entryRef = journalRef(db, userId, key);

  const report = new LotDriftReporter(lotOptions, userId, "commitReservation");
  const result = await db.runTransaction(async (transaction): Promise<CommitOutcome> => {
    report.begin();
    // Reservation first, then balance: the order the V2 contract fixes.
    const reservationDoc = await transaction.get(reservationRef);
    if (!reservationDoc.exists) return { outcome: "not_found", reservationId };
    const reservation = readReservation(reservationDoc);
    assertTrustworthy(reservation, "commit");

    if (reservation.status !== "reserved") {
      return {
        outcome: "already_terminal",
        reservation,
        terminalStatus: terminalStatusOf(reservation, "commit"),
      };
    }

    const [balanceDoc, entryDoc] = await transaction.getAll(balanceRef, entryRef);
    const credits = requireBalance(balanceDoc, userId);
    const amount = reservation.amount;
    assertReservedCoversHold(credits, userId, reservationId, amount);
    const backing = await readExpiredBacking(transaction, db, userId, credits);
    const paid = planHoldCommit(
      credits.balance,
      credits.bonusCredits,
      backing.total,
      holdExpiredBacking(reservation, backing.frontier, backing.rewrites),
      amount
    );
    if (!paid.covered) {
      throw new CreditError(
        `Insufficient credits to commit reservation ${reservationId}`,
        CreditErrorCode.INSUFFICIENT_CREDITS,
        { userId, reservationId, required: amount }
      );
    }

    // Drain `balance` before `bonusCredits`. The projected values are written
    // verbatim, so the journal's `balanceAfter` and the stored balance agree.
    const nextBalance = paid.balance;
    const nextBonusCredits = paid.bonusCredits;
    const nextReserved = sumAmounts(credits.reserved, -amount);
    const nextMonthlyUsed = sumAmounts(credits.monthlyUsed, amount);
    const balanceAfter = sumAmounts(nextBalance, nextBonusCredits);
    assertRepresentableFields(
      {
        balance: nextBalance,
        bonusCredits: nextBonusCredits,
        reserved: nextReserved,
        monthlyUsed: nextMonthlyUsed,
      },
      { userId, operation: "commitReservation" }
    );

    // The lots that paid: the hold's backing share, then spendable balance, then bonus,
    // each in draw order.
    const fromBacking = sumAmounts(backing.total, -paid.expiredHoldBacking);
    const lots = planFirestoreLots(lotOptions, {
      raw: credits.stored as FirestoreUserCredits,
      after: lotBucketsAfter(nextBalance, paid.expiredHoldBacking, nextBonusCredits),
      opRef: `commit:${reservationId}`,
      apply: (plan) =>
        planLotDraws(plan, {
          backing: fromBacking,
          spendable: sumAmounts(credits.balance, -nextBalance, -fromBacking),
          bonus: sumAmounts(credits.bonusCredits, -nextBonusCredits),
        }),
    });
    report.track(lots);
    const lotFields = lots ? { lotDraws: lots.draws, lotTotals: lotTotalsOf(lots.draws) } : null;

    const journal: JournalWrite = {
      userId,
      operation: "commitReservation",
      entryType: "debit",
      amount,
      balanceBefore: sumAmounts(credits.balance, credits.bonusCredits),
      balanceAfter,
      source: "operation_commit",
      reservationId,
      description:
        options?.description ??
        `Committed ${amount} credits for ${getOperationLabel(reservation.operationType)}`,
      // Caller metadata first: the deterministic fields carry the event's identity.
      metadata: {
        ...options?.metadata,
        ...lotFields,
        operationType: reservation.operationType,
        amount,
      },
      idempotencyKey: key,
    };
    const reuseEntry = planJournal(entryDoc, journal);

    const completedAt = new Date().toISOString();
    transaction.update(reservationRef, { status: "committed", completedAt, ...lotFields });
    transaction.update(balanceRef, {
      balance: nextBalance,
      bonusCredits: nextBonusCredits,
      reserved: nextReserved,
      monthlyUsed: nextMonthlyUsed,
      ...expiredBackingPatch(
        { total: paid.expiredHoldBacking, frontier: backing.frontier },
        credits.stored
      ),
      ...writeLotPlan(transaction, db, userId, lots),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (!reuseEntry) writeJournal(transaction, entryRef, journal);

    return {
      outcome: "committed",
      reservation: { ...reservation, status: "committed", completedAt, ...lotFields },
      amount,
      balanceAfter,
      journalEntryId: entryRef.id,
    };
  });
  report.flush();
  return result;
}

interface UnspentTransition {
  status: "released" | "expired";
  source: CreditSource;
  transition: "release" | "expire";
  verb: string;
  options?: ReservationTransitionOptions;
  /** Expire only: the sweep time a reservation must be due by. */
  asOf?: Date;
  lotOptions?: LotLedgerOptions;
}

type UnspentResult =
  | { outcome: "finished"; reservation: PortableReservation; amount: number; journalEntryId: string }
  | { outcome: "not_due"; reservation: PortableReservation }
  | Extract<ReleaseOutcome, { outcome: "already_terminal" | "not_found" }>;

/**
 * Hand a hold back unspent and journal it, in one transaction.
 *
 * The journal `amount` is 0 because no credits changed hands; the hold size
 * stays in metadata, matching the other adapters. This hold's share of the credits
 * kept only to back holds leaves the balance here, so they cannot be spent later.
 */
async function finishUnspent(
  db: Firestore,
  userId: string,
  reservationId: string,
  spec: UnspentTransition & { asOf?: undefined }
): Promise<Exclude<UnspentResult, { outcome: "not_due" }>>;
async function finishUnspent(
  db: Firestore,
  userId: string,
  reservationId: string,
  spec: UnspentTransition
): Promise<UnspentResult>;
async function finishUnspent(
  db: Firestore,
  userId: string,
  reservationId: string,
  spec: UnspentTransition
): Promise<UnspentResult> {
  const balanceRef = getUserCreditsCollection(db, userId).doc(BALANCE_DOC_ID);
  const reservationRef = getUserReservationsCollection(db, userId).doc(reservationId);
  const key = reservationJournalKey(reservationId, spec.transition);
  const entryRef = journalRef(db, userId, key);

  const report = new LotDriftReporter(spec.lotOptions, userId, `${spec.transition}Reservation`);
  const result = await db.runTransaction(async (transaction): Promise<UnspentResult> => {
    report.begin();
    const reservationDoc = await transaction.get(reservationRef);
    if (!reservationDoc.exists) return { outcome: "not_found", reservationId };
    const reservation = readReservation(reservationDoc);
    assertTrustworthy(reservation, spec.transition);

    if (reservation.status !== "reserved") {
      return {
        outcome: "already_terminal",
        reservation,
        terminalStatus: terminalStatusOf(reservation, spec.transition),
      };
    }
    if (spec.asOf && new Date(reservation.expiresAt).getTime() > spec.asOf.getTime()) {
      return { outcome: "not_due", reservation };
    }

    const [balanceDoc, entryDoc] = await transaction.getAll(balanceRef, entryRef);
    const credits = requireBalance(balanceDoc, userId);
    assertReservedCoversHold(credits, userId, reservationId, reservation.amount);

    const nextReserved = sumAmounts(credits.reserved, -reservation.amount);
    const inForce = await readExpiredBacking(transaction, db, userId, credits);
    const backing = settleExpiredHoldBacking(
      credits.balance,
      inForce.total,
      holdExpiredBacking(reservation, inForce.frontier, inForce.rewrites)
    );
    const nextBalance = sumAmounts(credits.balance, -backing.used);
    const operation = `${spec.transition}Reservation`;
    assertRepresentableFields(
      { reserved: nextReserved, balance: nextBalance },
      { userId, operation }
    );
    // The hold's backing share leaves the balance unspent: breakage, as an expiry.
    const lots = planFirestoreLots(spec.lotOptions, {
      raw: credits.stored as FirestoreUserCredits,
      after: lotBucketsAfter(nextBalance, backing.remaining, credits.bonusCredits),
      opRef: `${spec.transition}:${reservationId}`,
      apply: (plan) =>
        planLotRemoval(plan, {
          bucket: "balance",
          portion: "backing",
          credits: backing.used,
          kind: "expire",
          reason: spec.transition,
          ref: reservationId,
        }),
    });
    report.track(lots);

    const journal: JournalWrite = {
      userId,
      operation,
      entryType: "credit",
      amount: 0,
      balanceBefore: sumAmounts(credits.balance, credits.bonusCredits),
      balanceAfter: sumAmounts(nextBalance, credits.bonusCredits),
      source: spec.source,
      reservationId,
      description:
        spec.options?.description ??
        `${spec.verb} ${reservation.amount} reserved credits for ${getOperationLabel(reservation.operationType)}`,
      metadata: {
        ...spec.options?.metadata,
        operationType: reservation.operationType,
        amount: reservation.amount,
        ...(backing.used > 0 ? { expiredCreditsRemoved: backing.used } : {}),
      },
      idempotencyKey: key,
    };
    const reuseEntry = planJournal(entryDoc, journal);

    const completedAt = new Date().toISOString();
    transaction.update(reservationRef, { status: spec.status, completedAt });
    transaction.update(balanceRef, {
      reserved: nextReserved,
      ...(backing.used > 0 ? { balance: nextBalance } : {}),
      ...expiredBackingPatch(
        { total: backing.remaining, frontier: inForce.frontier },
        credits.stored
      ),
      ...writeLotPlan(transaction, db, userId, lots),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (!reuseEntry) writeJournal(transaction, entryRef, journal);

    return {
      outcome: "finished",
      reservation: { ...reservation, status: spec.status, completedAt },
      amount: reservation.amount,
      journalEntryId: entryRef.id,
    };
  });
  report.flush();
  return result;
}

export async function releaseReservationV2(
  db: Firestore,
  userId: string,
  reservationId: string,
  options?: ReservationTransitionOptions,
  lotOptions?: LotLedgerOptions
): Promise<ReleaseOutcome> {
  const result = await finishUnspent(db, userId, reservationId, {
    status: "released",
    source: "operation_release",
    transition: "release",
    verb: "Released",
    options,
    lotOptions,
  });
  if (result.outcome === "finished") return { ...result, outcome: "released" };
  return result;
}

/**
 * Expire a reservation whether or not it is due — the legacy
 * `expireReservationAtomic` semantics, which never checked the deadline.
 */
export async function expireReservationNow(
  db: Firestore,
  userId: string,
  reservationId: string,
  lotOptions?: LotLedgerOptions
): Promise<Exclude<ExpireOutcome, { outcome: "not_due" }>> {
  const result = await finishUnspent(db, userId, reservationId, {
    status: "expired",
    source: "reservation_expired",
    transition: "expire",
    verb: "Expired",
    lotOptions,
  });
  if (result.outcome === "finished") return { ...result, outcome: "expired" };
  return result;
}

export async function expireReservationV2(
  db: Firestore,
  userId: string,
  reservationId: string,
  options?: ExpireReservationV2Options,
  lotOptions?: LotLedgerOptions
): Promise<ExpireOutcome> {
  const result = await finishUnspent(db, userId, reservationId, {
    status: "expired",
    source: "reservation_expired",
    transition: "expire",
    verb: "Expired",
    options,
    asOf: options?.asOf ?? new Date(),
    lotOptions,
  });
  if (result.outcome === "finished") return { ...result, outcome: "expired" };
  return result;
}
