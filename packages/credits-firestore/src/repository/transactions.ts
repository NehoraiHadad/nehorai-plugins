import { FieldValue } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import type {
  AddCreditsAtomicOptions,
  AddCreditsOutcome,
  DeductJournalInput,
  LotLedgerOptions,
  LotPlan,
  PortableTransaction,
  CreateTransactionInput,
} from "@nehorai/credits";
import {
  assertRepresentableFields,
  assertValidCreditAmount,
  assertValidLotSpec,
  planLotGrant,
  planLotRemoval,
  canonicalAmount,
  CreditError,
  CreditErrorCode,
  describePaymentMismatch,
  getDefaultTier,
  normalizePaymentRef,
  spendableBalance,
  sumAmounts,
} from "@nehorai/credits";
import {
  getUserTransactionsCollection,
  getUserCreditsCollection,
  BALANCE_DOC_ID,
  DEFAULT_FREE_CREDITS,
  getNextMonthStart,
  toISOString,
  calculateCreditDeduction,
} from "./shared.js";
import {
  applyCallerDocUpdate,
  assertMayCreateAccount,
  deterministicDocId,
  readStoredCredits,
  type AccountSeedOptions,
  type CallerDocUpdate,
  type FirestoreUserCredits,
} from "./credits-doc.js";
import { planHoldBacking } from "./hold-backing.js";
import {
  createJournalEntryInTransaction,
  getUserJournalCollection,
  journalSignupGrantInTransaction,
} from "./journal.js";
import {
  LotDriftReporter,
  lotBucketsAfter,
  newLotOpRef,
  planFirestoreLots,
  writeLotPlan,
} from "./lots.js";

/**
 * A credit's lots: a free `seed` lot for an account the credit creates with a balance,
 * then the credit's own bonus lot, paid when the caller says what it was paid.
 */
function planCreditLots(
  lotOptions: LotLedgerOptions | undefined,
  input: {
    raw: FirestoreUserCredits | null;
    seedBalance: number;
    balance: number;
    marked: number;
    nextBonusCredits: number;
    amount: number;
    paymentRef?: string;
    options?: AddCreditsAtomicOptions;
  }
): LotPlan | null {
  return planFirestoreLots(lotOptions, {
    raw: input.raw,
    after: lotBucketsAfter(input.balance, input.marked, input.nextBonusCredits),
    opRef: newLotOpRef(),
    apply: (plan) =>
      planLotGrant(
        input.raw
          ? plan
          : planLotGrant(plan, {
              bucket: "balance",
              credits: input.seedBalance,
              spec: { funding: "free" },
              sourceType: "seed",
            }),
        {
          bucket: "bonus",
          credits: input.amount,
          spec: input.options?.lot ?? { funding: "unknown" },
          sourceType: input.paymentRef ? "purchase" : "admin",
          sourceRef: input.paymentRef ?? null,
        }
      ),
  });
}

/**
 * Create a credit transaction record
 */
export async function createTransaction(
  db: Firestore,
  input: CreateTransactionInput
): Promise<PortableTransaction> {
  const transactionsCol = getUserTransactionsCollection(db, input.userId);
  const txRef = transactionsCol.doc();

  // Noise from a caller's float arithmetic is not an amount; see `canonicalAmount`.
  const amount = canonicalAmount(input.amount);
  const previousBalance = canonicalAmount(input.previousBalance);
  const newBalance = canonicalAmount(input.newBalance);
  assertRepresentableFields(
    { amount, previousBalance, newBalance },
    { userId: input.userId, operation: "createTransaction" }
  );

  const transaction: PortableTransaction = {
    id: txRef.id,
    userId: input.userId,
    type: input.type,
    amount,
    description: input.description,
    paymentRef: input.paymentRef,
    previousBalance,
    newBalance,
    createdAt: new Date().toISOString(),
  };

  await txRef.set({
    ...transaction,
    createdAt: FieldValue.serverTimestamp(),
  });

  return transaction;
}

/**
 * Get user's credit transaction history with pagination
 */
export async function getTransactions(
  db: Firestore,
  userId: string,
  limit = 50,
  offset = 0
): Promise<PortableTransaction[]> {
  const transactionsCol = getUserTransactionsCollection(db, userId);

  const snapshot = await transactionsCol
    .orderBy("createdAt", "desc")
    .offset(offset)
    .limit(limit)
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      ...data,
      id: doc.id,
      createdAt: toISOString(data.createdAt),
    } as PortableTransaction;
  });
}

/**
 * Atomically add credits to user balance, with its transaction record and journal
 * entry in the same transaction.
 */
export async function addCreditsAtomic(
  db: Firestore,
  userId: string,
  amount: number,
  description: string,
  paymentRef?: string,
  seedOptions?: AccountSeedOptions & LotLedgerOptions,
  options?: AddCreditsAtomicOptions
): Promise<void> {
  const context = { userId, operation: "addCreditsAtomic" };
  assertValidCreditAmount(amount, context);
  if (options?.lot !== undefined) assertValidLotSpec(options.lot);

  const creditsCol = getUserCreditsCollection(db, userId);
  const transactionsCol = getUserTransactionsCollection(db, userId);
  const balanceRef = creditsCol.doc(BALANCE_DOC_ID);

  const report = new LotDriftReporter(seedOptions, userId, "addCredits");
  await db.runTransaction(async (transaction) => {
    report.begin();
    const balanceDoc = await transaction.get(balanceRef);
    if (!balanceDoc.exists) assertMayCreateAccount(userId, seedOptions);
    const raw = balanceDoc.exists ? (balanceDoc.data() as FirestoreUserCredits) : null;
    const current = raw ? readStoredCredits(raw) : null;
    // A missing account is seeded below, so the seed is what this credit lands on.
    const currentBalance = current ? current.balance : DEFAULT_FREE_CREDITS;
    const currentBonusCredits = current?.bonusCredits ?? 0;
    const nextBonusCredits = sumAmounts(currentBonusCredits, amount);
    const previousBalance = sumAmounts(currentBalance, currentBonusCredits);
    const newBalance = sumAmounts(currentBalance, nextBonusCredits);
    assertRepresentableFields(
      { bonusCredits: nextBonusCredits, previousBalance, newBalance },
      context
    );
    const lots = planCreditLots(seedOptions, {
      raw,
      seedBalance: currentBalance,
      balance: currentBalance,
      marked: current?.expiredHoldBacking ?? 0,
      nextBonusCredits,
      amount,
      paymentRef,
      options,
    });
    report.track(lots);
    // A credit does not change the marks; this repairs a stored value outside the balance.
    const backing =
      raw && current
        ? await planHoldBacking(transaction, db, userId, current.expiredHoldBacking ?? 0, raw)
        : {};
    const lotFields = writeLotPlan(transaction, db, userId, lots);

    // Create transaction record
    const txRef = transactionsCol.doc();
    transaction.set(txRef, {
      id: txRef.id,
      userId,
      type: paymentRef ? "purchase" : "bonus",
      amount,
      description,
      // Omitted, not undefined: Firestore rejects undefined unless the app opts out.
      ...(paymentRef ? { paymentRef } : {}),
      previousBalance,
      newBalance,
      createdAt: FieldValue.serverTimestamp(),
    });
    createJournalEntryInTransaction(transaction, db, {
      userId,
      entryType: "credit",
      amount,
      balanceBefore: previousBalance,
      balanceAfter: newBalance,
      source: options?.source ?? "purchase",
      referenceId: txRef.id,
      referenceType: options?.referenceType ?? "transaction",
      description,
      metadata: { ...(paymentRef ? { paymentRef } : {}), ...options?.metadata },
    });

    // Update bonusCredits (not balance - bonusCredits persist across monthly resets).
    // An exact cent-grid value, not FieldValue.increment, which adds in IEEE 754;
    // the transaction retries if the balance changed since it was read.
    if (balanceDoc.exists) {
      transaction.update(balanceRef, {
        bonusCredits: nextBonusCredits,
        ...backing,
        ...lotFields,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      // Initialize with added credits in bonusCredits
      const now = new Date();
      const tier = getDefaultTier();
      transaction.set(balanceRef, {
        userId,
        balance: currentBalance,
        bonusCredits: nextBonusCredits,
        reserved: 0,
        tier,
        monthlyLimit: DEFAULT_FREE_CREDITS,
        monthlyUsed: 0,
        monthlyResetAt: getNextMonthStart(now).toISOString(),
        subscriptionExpiresAt: null,
        ...lotFields,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      // The credit's own line starts from this seed, so the seed needs one too.
      journalSignupGrantInTransaction(transaction, db, userId, tier, currentBalance);
    }
  });
  report.flush();
}

/**
 * A paid credit that applies once per payment.
 */
export interface AddCreditsIdempotentInput {
  userId: string;
  amount: number;
  description: string;
  /** The payment's id. A repeat of this reference for this user changes nothing. */
  paymentRef: string;
  options?: AddCreditsAtomicOptions;
  /** Written only when the credit applies, for example `creditsGranted` on an order. */
  alsoUpdate?: CallerDocUpdate;
}

/**
 * Atomically credit `bonusCredits` once per payment.
 *
 * The transaction row at an id derived from `paymentRef` is the guard, read and
 * written in one transaction with the balance and the journal entry, so concurrent or
 * retried fulfilment credits once. The outcome is the shared `AddCreditsOutcome`.
 *
 * The guard is per user: the same reference on another account is not detected. A
 * missing account is created at balance 0, because a payment is not a signup grant.
 * With `seedMissingAccounts: false` it throws `USER_NOT_FOUND` instead, so the
 * delivery can be retried once the account exists.
 *
 * It is a separate method, not `addCreditsV2`: `CreditsService` routes through
 * `addCreditsV2` when an adapter has it, which would change every existing caller.
 */
export async function addCreditsIdempotent(
  db: Firestore,
  input: AddCreditsIdempotentInput,
  seedOptions?: AccountSeedOptions & LotLedgerOptions
): Promise<AddCreditsOutcome> {
  const { userId, amount, description, options, alsoUpdate } = input;
  const context = { userId, operation: "addCreditsIdempotent" };
  assertValidCreditAmount(amount, context);
  if (options?.lot !== undefined) assertValidLotSpec(options.lot);
  const paymentRef = normalizePaymentRef(input.paymentRef);
  if (!paymentRef) {
    throw new CreditError(
      "addCreditsIdempotent needs a non-blank paymentRef: it has nothing else to deduplicate on",
      CreditErrorCode.INVALID_IDEMPOTENCY_KEY,
      context
    );
  }

  const source = options?.source ?? "purchase";
  const referenceType = options?.referenceType ?? "transaction";
  const docId = deterministicDocId("payment", paymentRef);
  const balanceRef = getUserCreditsCollection(db, userId).doc(BALANCE_DOC_ID);
  const txRef = getUserTransactionsCollection(db, userId).doc(docId);
  const entryRef = getUserJournalCollection(db, userId).doc(docId);

  const report = new LotDriftReporter(seedOptions, userId, "addCreditsIdempotent");
  const outcome = await db.runTransaction(async (transaction): Promise<AddCreditsOutcome> => {
    report.begin();
    const [txDoc, entryDoc, balanceDoc] = await transaction.getAll(txRef, entryRef, balanceRef);

    if (txDoc.exists) {
      const data = txDoc.data() ?? {};
      const existing = {
        ...data,
        id: txDoc.id,
        createdAt: toISOString(data.createdAt),
      } as PortableTransaction;
      const mismatch = describePaymentMismatch(
        {
          userId: existing.userId,
          amount: existing.amount,
          type: existing.type,
          source: entryDoc.get("source"),
          referenceType: entryDoc.get("referenceType"),
        },
        { userId, amount, type: "purchase", source, referenceType }
      );
      return mismatch === null
        ? { outcome: "replayed", paymentRef, transaction: existing }
        : { outcome: "conflict", paymentRef, existing, mismatch };
    }

    if (!balanceDoc.exists) assertMayCreateAccount(userId, seedOptions);
    const raw = balanceDoc.exists ? (balanceDoc.data() as FirestoreUserCredits) : null;
    const current = raw ? readStoredCredits(raw) : null;
    const balance = current?.balance ?? 0;
    const bonusCredits = current?.bonusCredits ?? 0;
    const nextBonusCredits = sumAmounts(bonusCredits, amount);
    const previousBalance = sumAmounts(balance, bonusCredits);
    const newBalance = sumAmounts(balance, nextBonusCredits);
    assertRepresentableFields(
      { bonusCredits: nextBonusCredits, previousBalance, newBalance },
      context
    );
    const lots = planCreditLots(seedOptions, {
      raw,
      seedBalance: 0,
      balance,
      marked: current?.expiredHoldBacking ?? 0,
      nextBonusCredits,
      amount,
      paymentRef,
      options,
    });
    report.track(lots);
    // A credit does not change the marks; this repairs a stored value outside the balance.
    const backing =
      raw && current
        ? await planHoldBacking(transaction, db, userId, current.expiredHoldBacking ?? 0, raw)
        : {};
    const lotFields = writeLotPlan(transaction, db, userId, lots);

    const record = {
      id: txRef.id,
      userId,
      type: "purchase" as const,
      amount,
      description,
      paymentRef,
      previousBalance,
      newBalance,
    };
    transaction.create(txRef, { ...record, createdAt: FieldValue.serverTimestamp() });
    transaction.create(entryRef, {
      userId,
      entryType: "credit",
      amount,
      balanceBefore: previousBalance,
      balanceAfter: newBalance,
      source,
      referenceId: txRef.id,
      referenceType,
      description,
      metadata: { paymentRef, ...options?.metadata },
      createdAt: FieldValue.serverTimestamp(),
    });
    if (current) {
      transaction.update(balanceRef, {
        bonusCredits: nextBonusCredits,
        ...backing,
        ...lotFields,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      transaction.create(balanceRef, {
        userId,
        balance: 0,
        bonusCredits: nextBonusCredits,
        reserved: 0,
        tier: getDefaultTier(),
        monthlyLimit: 0,
        monthlyUsed: 0,
        monthlyResetAt: getNextMonthStart().toISOString(),
        subscriptionExpiresAt: null,
        ...lotFields,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    applyCallerDocUpdate(transaction, alsoUpdate);

    return {
      outcome: "created",
      paymentRef,
      transaction: { ...record, createdAt: new Date().toISOString() },
      journalEntryId: entryRef.id,
    };
  });
  report.flush();
  return outcome;
}

/**
 * Atomically deduct credits from user balance.
 *
 * Splits the deduction between `balance` (monthly, resets each cycle) and
 * `bonusCredits` (persistent, never resets), draining `balance` first so the
 * user keeps credits they paid for longer. Runs inside a Firestore transaction
 * so the availability check and the split are coherent — concurrent deducts
 * cannot drive either field negative.
 *
 * This is the admin-deduct path. It does NOT touch `reserved` or
 * `monthlyUsed` (those are owned by the reservation lifecycle, not by
 * administrative adjustments). With `journal` it writes the audit line in this
 * same transaction, from the values it read, and returns the entry's id.
 *
 * @returns combined totals (`balance + bonusCredits`) before and after.
 */
export async function deductCreditsAtomic(
  db: Firestore,
  userId: string,
  amount: number,
  journal?: DeductJournalInput,
  lotOptions?: LotLedgerOptions
): Promise<{ previousBalance: number; newBalance: number; journalEntryId?: string }> {
  assertValidCreditAmount(amount, { userId, operation: "deductCreditsAtomic" });

  const creditsCol = getUserCreditsCollection(db, userId);
  const balanceRef = creditsCol.doc(BALANCE_DOC_ID);

  const report = new LotDriftReporter(lotOptions, userId, "deductCredits");
  const result = await db.runTransaction(async (transaction) => {
    report.begin();
    const balanceDoc = await transaction.get(balanceRef);
    if (!balanceDoc.exists) {
      throw new Error(`User credits not found for userId: ${userId}`);
    }

    const raw = balanceDoc.data() as FirestoreUserCredits;
    const credits = readStoredCredits(raw);
    const bonusCredits = credits.bonusCredits ?? 0;
    const reserved = credits.reserved ?? 0;
    // Credits kept only for holds have expired: a deduct cannot land on them.
    const spendable = spendableBalance(credits.balance, credits.expiredHoldBacking);
    const available = Math.min(
      sumAmounts(credits.balance, bonusCredits, -reserved),
      sumAmounts(spendable, bonusCredits)
    );

    if (available < amount) {
      throw new Error(
        `Insufficient credits. Available: ${available}, requested: ${amount}`
      );
    }

    const { balanceDeduction, bonusDeduction } = calculateCreditDeduction(
      spendable,
      bonusCredits,
      amount
    );

    const updateData: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp(),
    };
    // Exact cent-grid values; see addCreditsAtomic.
    if (balanceDeduction > 0) {
      updateData.balance = sumAmounts(credits.balance, -balanceDeduction);
    }
    if (bonusDeduction > 0) {
      updateData.bonusCredits = sumAmounts(bonusCredits, -bonusDeduction);
    }

    // An administrative removal, not revenue: spendable balance first, then bonus.
    const opRef = newLotOpRef();
    const ref = journal?.referenceId ?? opRef;
    const lots = planFirestoreLots(lotOptions, {
      raw,
      after: lotBucketsAfter(
        sumAmounts(credits.balance, -balanceDeduction),
        credits.expiredHoldBacking ?? 0,
        sumAmounts(bonusCredits, -bonusDeduction)
      ),
      opRef,
      apply: (plan) =>
        planLotRemoval(
          planLotRemoval(plan, {
            bucket: "balance",
            portion: "spendable",
            credits: balanceDeduction,
            kind: "adjustment",
            reason: "deduct",
            ref,
          }),
          {
            bucket: "bonus",
            portion: "spendable",
            credits: bonusDeduction,
            kind: "adjustment",
            reason: "deduct",
            ref,
          }
        ),
    });
    report.track(lots);

    // The deduct draws on spendable credits only, so the marks stand; this repairs a
    // stored value that was never within the balance.
    Object.assign(
      updateData,
      await planHoldBacking(transaction, db, userId, credits.expiredHoldBacking ?? 0, raw)
    );

    transaction.update(balanceRef, {
      ...updateData,
      ...writeLotPlan(transaction, db, userId, lots),
    });

    const previousBalance = sumAmounts(credits.balance, bonusCredits);
    const newBalance = sumAmounts(previousBalance, -amount);
    if (!journal) return { previousBalance, newBalance };

    const journalEntryId = createJournalEntryInTransaction(transaction, db, {
      userId,
      entryType: "debit",
      amount,
      balanceBefore: previousBalance,
      balanceAfter: newBalance,
      source: journal.source ?? "operation_commit",
      referenceId: journal.referenceId,
      referenceType: journal.referenceType ?? "adjustment",
      description: journal.description,
      metadata: journal.metadata,
    });
    return { previousBalance, newBalance, journalEntryId };
  });
  report.flush();
  return result;
}
