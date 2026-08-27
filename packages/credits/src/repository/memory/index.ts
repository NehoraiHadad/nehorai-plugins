/**
 * In-Memory Credit Repository Implementation
 *
 * A database-agnostic implementation of ICreditRepository for testing and prototyping.
 * All data is stored in memory and lost when the process restarts.
 *
 * Usage:
 * - Unit tests without database dependency
 * - Local development and prototyping
 * - Reference implementation for custom repositories
 */

import type {
  PortableUserCredits,
  PortableReservation,
  PortableTransaction,
  PortableJournalEntry,
  PortableUsageLog,
  SubscriptionTier,
  ReservationStatus,
  MonthlyResetResult,
  SubscriptionExpiryResult,
} from "../../core/types.js";
import type {
  ICreditRepository,
  CreateReservationInput,
  CreateTransactionInput,
  CreateUsageLogInput,
  CreateJournalEntryInput,
  UsageLogQuery,
  JournalEntryQuery,
  CreditBalanceUpdate,
  TierUpdateInput,
  AddCreditsAtomicOptions,
} from "../types.js";
import type {
  AddCreditsOutcome,
  CommitOutcome,
  ExpireOutcome,
  ReleaseOutcome,
  ReserveOutcome,
} from "../../core/outcomes.js";
import type {
  AddCreditsV2Input,
  ExpireReservationV2Options,
  ReservationTransitionOptions,
  ReserveCreditsV2Input,
} from "../v2-types.js";
import {
  assertUnreferencedDirectTransaction,
  createPaymentRefConflictError,
  describePaymentMismatch,
  normalizePaymentRef,
  type PaymentEventPayload,
} from "../../core/payment-ref.js";
import {
  createInsufficientCreditsError,
  createReservationAlreadyProcessedError,
  createReservationNotFoundError,
} from "../../core/errors.js";
import { generateId, toDate, getNextMonthlyReset } from "../utils.js";
import { copyRecord, copyRecords } from "./snapshot.js";
import {
  assertRepresentableAmount,
  assertRepresentableFields,
  assertRepresentableTierAmount,
  backedBalanceFloor,
  storedMonthlyLimit,
  assertValidCreditAmount,
  sumAmounts,
} from "../../core/amount.js";
import {
  assertPublicJournalKey,
  assertValidIdempotencyKey,
} from "../../core/idempotency.js";
import {
  assertDirectStatusWriteAllowed,
  assertUnkeyedDirectReservation,
} from "../../core/reservation-integrity.js";
import { CreditError, CreditErrorCode } from "../../core/errors.js";
import { MemoryStore, scopedKey } from "./store.js";
import {
  commitReservationV2,
  expireReservationV2,
  releaseReservationV2,
  reserveCreditsV2,
} from "./v2.js";
import {
  getConfigMonthlyLimit,
  getConfigTierConfig,
  getDefaultTier,
  isFreeTier,
  monthlyResetBalance,
} from "../../config/index.js";

/**
 * In-Memory implementation of ICreditRepository
 *
 * Implements all repository methods using Map-based storage.
 * Useful for testing and as a reference implementation.
 */
/** Apply an increment, or report `undefined` when the caller sent none. */
/** Accept either half of the `Date | string` timestamp inputs the API takes. */
function isoOf(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export class InMemoryCreditRepository implements ICreditRepository {
  private readonly store = new MemoryStore();

  // ==================== User Credits ====================

  /**
   * A copy, never the live record.
   *
   * Handing out the stored object made this adapter behave unlike any real
   * one: a caller holding a "before" snapshot saw it mutate under them. The
   * service's monthly reset compared `resetResult.credits.balance` against the
   * balance it had read moments earlier, got zero because both were the same
   * object, and silently skipped the reset's journal entry — while the SQL
   * adapter, which maps each row into a fresh object, wrote it.
   */
  async getUserCredits(userId: string): Promise<PortableUserCredits | null> {
    const credits = this.store.users.get(userId);
    return copyRecord(credits) ?? null;
  }

  async initializeUserCredits(
    userId: string,
    tier: SubscriptionTier,
    initialBalance: number
  ): Promise<PortableUserCredits> {
    assertRepresentableAmount(initialBalance, "initialBalance", { userId });
    // Derived from tier configuration rather than supplied by the caller, and
    // therefore just as capable of being unrepresentable: a tier configured
    // with `monthlyCredits: 1.005` writes a number the column cannot hold.
    const configured = getConfigMonthlyLimit(tier);
    assertRepresentableTierAmount(configured, "monthlyLimit", { userId, tier });
    // Stored through the shared contract so both adapters hold the same number
    // for an unlimited tier. See `storedMonthlyLimit`.
    const monthlyLimit = storedMonthlyLimit(configured);

    const now = new Date().toISOString();
    const credits: PortableUserCredits = {
      userId,
      balance: initialBalance,
      bonusCredits: 0,
      reserved: 0,
      tier,
      monthlyLimit,
      monthlyUsed: 0,
      monthlyResetAt: getNextMonthlyReset().toISOString(),
      subscriptionExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.users.set(userId, credits);
    return copyRecord(credits);
  }

  async updateUserCredits(userId: string, updates: CreditBalanceUpdate): Promise<void> {
    assertRepresentableFields(
      {
        balance: updates.balance,
        bonusCredits: updates.bonusCredits,
        reserved: updates.reserved,
        monthlyLimit: updates.monthlyLimit,
        monthlyUsed: updates.monthlyUsed,
        balanceIncrement: updates.balanceIncrement,
        bonusCreditsIncrement: updates.bonusCreditsIncrement,
        reservedIncrement: updates.reservedIncrement,
        monthlyUsedIncrement: updates.monthlyUsedIncrement,
      },
      { userId, operation: "updateUserCredits" }
    );

    const credits = this.store.users.get(userId);
    if (!credits) {
      throw new Error(`User ${userId} not found`);
    }

    // The entire record is projected onto a candidate before anything is
    // written back. Assigning the absolute fields first and validating the
    // increments afterwards would leave a refused update half-applied — an
    // explicit `monthlyUsed: 5` would stick even though the derived `balance`
    // it was sent with was rejected — and this store has no transaction to
    // undo it. Every numeric field is checked on the candidate, so the record
    // either takes the whole update or none of it.
    const next: PortableUserCredits = { ...credits };

    if (updates.balance !== undefined) next.balance = updates.balance;
    if (updates.bonusCredits !== undefined) next.bonusCredits = updates.bonusCredits;
    if (updates.reserved !== undefined) next.reserved = updates.reserved;
    if (updates.tier !== undefined) next.tier = updates.tier;
    if (updates.monthlyLimit !== undefined) next.monthlyLimit = updates.monthlyLimit;
    if (updates.monthlyUsed !== undefined) next.monthlyUsed = updates.monthlyUsed;
    if (updates.monthlyResetAt !== undefined) {
      next.monthlyResetAt = isoOf(updates.monthlyResetAt);
    }
    if (updates.subscriptionExpiresAt !== undefined) {
      next.subscriptionExpiresAt =
        updates.subscriptionExpiresAt === null
          ? null
          : isoOf(updates.subscriptionExpiresAt);
    }

    // Increments are checked as *results*, not just as arguments: adding a
    // legal 0.01 to a legal 9999999999.99 produces a number the column cannot
    // hold. They apply on top of whatever the absolute fields just set; the SQL
    // adapter is built to match, and the SQL package's
    // `__tests__/integration/adapter-parity.test.ts` pins the two together.
    //
    // `sumAmounts`, not `+`: a float sum can land off the cent grid the ledger
    // validates against, and rejecting a legal increment as `INVALID_AMOUNT` is
    // a worse failure than the overflow this check exists for.
    if (updates.balanceIncrement !== undefined) {
      next.balance = sumAmounts(next.balance, updates.balanceIncrement);
    }
    if (updates.bonusCreditsIncrement !== undefined) {
      next.bonusCredits = sumAmounts(next.bonusCredits, updates.bonusCreditsIncrement);
    }
    if (updates.reservedIncrement !== undefined) {
      next.reserved = sumAmounts(next.reserved, updates.reservedIncrement);
    }
    if (updates.monthlyUsedIncrement !== undefined) {
      next.monthlyUsed = sumAmounts(next.monthlyUsed, updates.monthlyUsedIncrement);
    }

    assertRepresentableFields(
      {
        balance: next.balance,
        bonusCredits: next.bonusCredits,
        reserved: next.reserved,
        monthlyUsed: next.monthlyUsed,
      },
      { userId, operation: "updateUserCredits" }
    );
    assertRepresentableTierAmount(next.monthlyLimit, "monthlyLimit", {
      userId,
      operation: "updateUserCredits",
    });

    next.updatedAt = new Date().toISOString();
    this.store.users.set(userId, next);
  }

  async updateUserTier(userId: string, input: TierUpdateInput): Promise<void> {
    assertRepresentableFields(
      { monthlyLimit: input.monthlyLimit, balance: input.balance, monthlyUsed: input.monthlyUsed },
      { userId, operation: "updateUserTier" }
    );

    const credits = this.store.users.get(userId);
    if (!credits) {
      throw new Error(`User ${userId} not found`);
    }

    credits.tier = input.tier;
    credits.monthlyLimit = input.monthlyLimit;
    // A tier write may lower the balance, but never below what still backs the
    // outstanding holds — see `backedBalanceFloor`. Same clamp as the SQL
    // adapter, so a downgrade cannot strand a live reservation.
    if (input.balance !== undefined) {
      credits.balance = Math.max(
        input.balance,
        backedBalanceFloor(credits.reserved, credits.bonusCredits)
      );
    }
    if (input.monthlyUsed !== undefined) credits.monthlyUsed = input.monthlyUsed;
    if (input.subscriptionExpiresAt !== undefined) {
      if (input.subscriptionExpiresAt === null) {
        credits.subscriptionExpiresAt = null;
      } else {
        credits.subscriptionExpiresAt = input.subscriptionExpiresAt instanceof Date
          ? input.subscriptionExpiresAt.toISOString()
          : input.subscriptionExpiresAt;
      }
    }
    credits.updatedAt = new Date().toISOString();

    this.store.users.set(userId, credits);
  }

  // ==================== Reservations ====================

  async createReservation(input: CreateReservationInput): Promise<PortableReservation> {
    // Same refusal as the SQL adapter: a row written with an amount the ledger
    // cannot honour has no repair path once it exists, and every transition
    // that later locks it would have to refuse anyway.
    assertValidCreditAmount(input.amount, { userId: input.userId, operation: "createReservation" });
    assertUnkeyedDirectReservation(input);

    const now = new Date().toISOString();
    const reservation: PortableReservation = {
      id: generateId(),
      userId: input.userId,
      amount: input.amount,
      operationType: input.operationType,
      status: "reserved",
      createdAt: now,
      expiresAt: input.expiresAt.toISOString(),
    };

    if (!this.store.reservations.has(input.userId)) {
      this.store.reservations.set(input.userId, new Map());
    }
    this.store.reservations.get(input.userId)!.set(reservation.id, reservation);

    return copyRecord(reservation);
  }

  async getReservation(
    userId: string,
    reservationId: string
  ): Promise<PortableReservation | null> {
    const userReservations = this.store.reservations.get(userId);
    if (!userReservations) return null;
    return copyRecord(userReservations.get(reservationId)) ?? null;
  }

  async updateReservationStatus(
    userId: string,
    reservationId: string,
    status: ReservationStatus,
    completedAt?: Date
  ): Promise<void> {
    const userReservations = this.store.reservations.get(userId);
    if (!userReservations) {
      throw new Error(`No reservations found for user ${userId}`);
    }

    const reservation = userReservations.get(reservationId);
    if (!reservation) {
      throw new Error(`Reservation ${reservationId} not found`);
    }

    // A backed hold's status is owned by the transition that settles it, and no
    // row may be reopened: this method assigns a status and nothing else, so on
    // a V2 row it would change the status without the ledger movement the
    // status stands for. See `assertDirectStatusWriteAllowed`.
    assertDirectStatusWriteAllowed(reservation, status);

    reservation.status = status;
    if (completedAt) reservation.completedAt = completedAt.toISOString();

    userReservations.set(reservationId, reservation);
  }

  // ==================== Atomic Operations ====================

  // ==================== V2 boundary ====================
  //
  // As in the Drizzle adapter, V2 is the real implementation and the legacy
  // `*Atomic` methods are adapters over it, so both APIs share one set of
  // guarantees.

  async reserveCreditsV2(input: ReserveCreditsV2Input): Promise<ReserveOutcome> {
    return reserveCreditsV2(this.store, input);
  }

  async commitReservationV2(
    userId: string,
    reservationId: string,
    options?: ReservationTransitionOptions
  ): Promise<CommitOutcome> {
    return commitReservationV2(this.store, userId, reservationId, options);
  }

  async releaseReservationV2(
    userId: string,
    reservationId: string,
    options?: ReservationTransitionOptions
  ): Promise<ReleaseOutcome> {
    return releaseReservationV2(this.store, userId, reservationId, options);
  }

  async expireReservationV2(
    userId: string,
    reservationId: string,
    options?: ExpireReservationV2Options
  ): Promise<ExpireOutcome> {
    return expireReservationV2(this.store, userId, reservationId, options);
  }

  // ==================== Legacy atomic operations ====================

  async reserveCreditsAtomic(
    userId: string,
    amount: number,
    operationType: string,
    expiresAt: Date
  ): Promise<PortableReservation> {
    const outcome = await this.reserveCreditsV2({ userId, amount, operationType, expiresAt });
    if (outcome.outcome === "created" || outcome.outcome === "replayed") {
      return outcome.reservation;
    }
    if (outcome.outcome === "insufficient") {
      throw createInsufficientCreditsError(outcome.required, outcome.available);
    }
    throw createReservationAlreadyProcessedError(outcome.existing.id, outcome.existing.status);
  }

  async commitReservationAtomic(userId: string, reservationId: string): Promise<void> {
    const outcome = await this.commitReservationV2(userId, reservationId);
    if (outcome.outcome === "committed") return;
    if (outcome.outcome === "not_found") throw createReservationNotFoundError(reservationId);
    // Re-delivering a commit for an already-committed reservation stays a no-op.
    if (outcome.terminalStatus === "committed") return;
    throw createReservationAlreadyProcessedError(reservationId, outcome.terminalStatus);
  }

  async releaseReservationAtomic(userId: string, reservationId: string): Promise<void> {
    const outcome = await this.releaseReservationV2(userId, reservationId);
    if (outcome.outcome === "not_found") throw createReservationNotFoundError(reservationId);
    // Releasing an already-terminal reservation is a no-op, as before.
  }

  /**
   * The stored transaction carrying this reference, in *any* user's ledger.
   *
   * Deliberately not scoped to one user. The SQL adapter's unique index covers
   * `payment_ref` alone, so searching only the crediting user's own history made
   * the same reference credit two different accounts here while the SQL adapter
   * treated the second delivery as a duplicate. See `core/payment-ref.ts`.
   */
  private findByPaymentRef(paymentRef: string): PortableTransaction | undefined {
    for (const recorded of this.store.transactions.values()) {
      const hit = recorded.find((transaction) => transaction.paymentRef === paymentRef);
      if (hit) return hit;
    }
    return undefined;
  }

  /** The journal entry written alongside a stored purchase, if there is one. */
  private journalForTransaction(
    transaction: PortableTransaction
  ): PortableJournalEntry | undefined {
    return this.store.journalEntries
      .get(transaction.userId)
      ?.find((entry) => entry.referenceId === transaction.id);
  }

  /**
   * Credit an account, resolving `paymentRef` to created / replayed / conflict.
   *
   * The reference is checked and the transaction is recorded with no `await`
   * between them. `createTransaction` is `async` but its body is synchronous, so
   * under JavaScript's run-to-completion semantics no other caller can observe
   * the gap — which is what stands in for the SQL adapter's unique index.
   *
   * A `replayed` or `conflict` outcome writes nothing at all: the check runs
   * before the balance moves, not after.
   */
  async addCreditsV2(input: AddCreditsV2Input): Promise<AddCreditsOutcome> {
    const { userId, amount, description, options } = input;
    assertValidCreditAmount(amount, { userId, operation: "addCredits" });

    // Empty and whitespace-only strings are not references. Normalised in one
    // place so this adapter and the SQL one agree on which calls carry one.
    const paymentRef = normalizePaymentRef(input.paymentRef);
    const payload: PaymentEventPayload = {
      userId,
      amount,
      type: "purchase",
      source: options?.source ?? "purchase",
      referenceType: options?.referenceType ?? "transaction",
    };

    if (paymentRef) {
      const existing = this.findByPaymentRef(paymentRef);
      if (existing) {
        const journal = this.journalForTransaction(existing);
        // Presence is not enough. A reference that arrives again with a
        // different user, amount or source is a *different* credit event, and
        // reporting it as a replay would credit the first amount and call the
        // second one done.
        const mismatch = describePaymentMismatch(
          {
            userId: existing.userId,
            amount: existing.amount,
            type: existing.type,
            source: journal?.source,
            referenceType: journal?.referenceType,
          },
          payload
        );
        return mismatch === null
          ? { outcome: "replayed", paymentRef, transaction: copyRecord(existing) }
          : { outcome: "conflict", paymentRef, existing: copyRecord(existing), mismatch };
      }
    }

    // After the reference check, never before it: a replay or a conflict must
    // write nothing, including the account row this creates. An absent user is
    // created at tier defaults, matching the SQL adapter's `ensureUserCredits`
    // — the first credit for a not-yet-seeded user (a webhook that outran
    // provisioning) lands instead of throwing in one adapter and landing in the
    // other.
    if (!this.store.users.has(userId)) {
      const tier = getDefaultTier();
      await this.initializeUserCredits(
        userId,
        tier,
        storedMonthlyLimit(getConfigMonthlyLimit(tier))
      );
    }
    const credits = this.store.users.get(userId)!;

    // Project first, mutate second. The transaction write below validates the
    // derived `newBalance`, and if that throws after the balance has already
    // moved the store is left holding half of an operation that reported
    // failure. There is no rollback here, so nothing may change until every
    // derived value is known to be storable.
    const previousTotal = sumAmounts(credits.balance, credits.bonusCredits);
    const nextBonusCredits = sumAmounts(credits.bonusCredits, amount);
    const newTotal = sumAmounts(credits.balance, nextBonusCredits);
    assertRepresentableFields(
      { previousBalance: previousTotal, bonusCredits: nextBonusCredits, newBalance: newTotal },
      { userId, operation: "addCredits" }
    );

    credits.bonusCredits = nextBonusCredits;
    credits.updatedAt = new Date().toISOString();
    this.store.users.set(userId, credits);

    // Recorded through the internal writer: the public `createTransaction`
    // refuses a `paymentRef` precisely so that only this path — which moved the
    // balance above — can claim one.
    const transaction = this.recordTransaction({
      userId,
      type: "purchase",
      amount,
      description,
      paymentRef,
      previousBalance: previousTotal,
      newBalance: newTotal,
    });

    // Journal entry (parity with the Drizzle adapter): a single journal can then
    // serve as the app's credit ledger, including revenue-attribution metadata.
    const journalMetadata = {
      ...(paymentRef ? { paymentRef } : {}),
      ...(options?.metadata ?? {}),
    };
    const entry = await this.createJournalEntry({
      userId,
      entryType: "credit",
      amount,
      balanceAfter: newTotal,
      source: payload.source,
      referenceId: transaction.id ?? paymentRef ?? "unknown",
      referenceType: payload.referenceType,
      description,
      metadata: Object.keys(journalMetadata).length > 0 ? journalMetadata : undefined,
    });

    return paymentRef
      ? { outcome: "created", paymentRef, transaction, journalEntryId: entry.id }
      : { outcome: "created", transaction, journalEntryId: entry.id };
  }

  /**
   * The legacy signature, on top of {@link addCreditsV2}.
   *
   * `Promise<void>` has nowhere to report a conflict, and silently returning is
   * indistinguishable from "credited" — the exact failure this round is closing
   * — so a conflict throws. A genuine replay still returns quietly, because
   * that *is* the idempotent no-op the caller asked for.
   */
  async addCreditsAtomic(
    userId: string,
    amount: number,
    description: string,
    paymentRef?: string,
    options?: AddCreditsAtomicOptions
  ): Promise<void> {
    const outcome = await this.addCreditsV2({
      userId,
      amount,
      description,
      paymentRef,
      options,
    });
    if (outcome.outcome === "conflict") {
      throw createPaymentRefConflictError(outcome.paymentRef, {
        userId,
        mismatch: outcome.mismatch,
        existingUserId: outcome.existing.userId,
      });
    }
  }

  async deductCreditsAtomic(
    userId: string,
    amount: number
  ): Promise<{ previousBalance: number; newBalance: number }> {
    // `amount > 0` alone let 1.005, Infinity and out-of-range values through to
    // arithmetic the `numeric(12, 2)` adapter could never have stored.
    assertValidCreditAmount(amount, { userId, operation: "deductCredits" });

    const credits = this.store.users.get(userId);
    if (!credits) {
      throw new Error(`User credits not found for userId: ${userId}`);
    }

    const available = sumAmounts(credits.balance, credits.bonusCredits, -credits.reserved);
    if (available < amount) {
      throw new Error(
        `Insufficient credits. Available: ${available}, requested: ${amount}`
      );
    }

    // Drain balance first, then bonusCredits — same policy as commit.
    const balanceDeduction = Math.min(credits.balance, amount);
    const bonusDeduction = sumAmounts(amount, -balanceDeduction);

    // Projected and checked before anything moves, for the same reason as
    // `addCreditsAtomic`: there is no rollback in this store.
    const previousBalance = sumAmounts(credits.balance, credits.bonusCredits);
    const nextBalance = sumAmounts(credits.balance, -balanceDeduction);
    const nextBonusCredits = sumAmounts(credits.bonusCredits, -bonusDeduction);
    const newBalance = sumAmounts(previousBalance, -amount);
    assertRepresentableFields(
      { previousBalance, balance: nextBalance, bonusCredits: nextBonusCredits, newBalance },
      { userId, operation: "deductCredits" }
    );

    credits.balance = nextBalance;
    credits.bonusCredits = nextBonusCredits;
    credits.updatedAt = new Date().toISOString();
    this.store.users.set(userId, credits);

    return { previousBalance, newBalance };
  }

  // ==================== Transactions ====================

  async createTransaction(input: CreateTransactionInput): Promise<PortableTransaction> {
    // A record with a `paymentRef` would occupy the global payment boundary
    // without crediting anyone — a later addCredits with the same reference
    // then reports `replayed` and credits nothing. Referenced payments go
    // through addCredits; see `assertUnreferencedDirectTransaction`.
    assertUnreferencedDirectTransaction(input);
    // Always absent after the guard; spelled as the normalised value so a blank
    // string is stored as "no reference", matching the SQL adapter.
    return this.recordTransaction({
      ...input,
      paymentRef: normalizePaymentRef(input.paymentRef),
    });
  }

  /** The unguarded writer, for `addCreditsV2` — which has moved the balance. */
  private recordTransaction(input: CreateTransactionInput): PortableTransaction {
    // Ledger records, not movements: a correction may be negative and a balance
    // may be below zero, so these check what `numeric(12, 2)` can hold.
    assertRepresentableAmount(input.amount, "transaction amount", { userId: input.userId });
    assertRepresentableAmount(input.previousBalance, "transaction previousBalance", {
      userId: input.userId,
    });
    assertRepresentableAmount(input.newBalance, "transaction newBalance", {
      userId: input.userId,
    });

    const transaction: PortableTransaction = {
      id: generateId(),
      userId: input.userId,
      type: input.type,
      amount: input.amount,
      description: input.description,
      paymentRef: input.paymentRef,
      previousBalance: input.previousBalance,
      newBalance: input.newBalance,
      createdAt: new Date().toISOString(),
    };

    if (!this.store.transactions.has(input.userId)) {
      this.store.transactions.set(input.userId, []);
    }
    this.store.transactions.get(input.userId)!.push(transaction);

    return copyRecord(transaction);
  }

  async getTransactions(
    userId: string,
    limit = 50,
    offset = 0
  ): Promise<PortableTransaction[]> {
    const userTransactions = this.store.transactions.get(userId) ?? [];
    // Sort by createdAt descending (most recent first)
    const sorted = [...userTransactions].sort((a, b) => {
      const aDate = toDate(a.createdAt).getTime();
      const bDate = toDate(b.createdAt).getTime();
      return bDate - aDate;
    });
    return copyRecords(sorted.slice(offset, offset + limit));
  }

  // ==================== Usage Logs ====================

  async logUsage(input: CreateUsageLogInput): Promise<PortableUsageLog> {
    assertRepresentableAmount(input.creditsUsed, "creditsUsed", { userId: input.userId });

    const log: PortableUsageLog = {
      id: generateId(),
      userId: input.userId,
      operationType: input.operationType,
      provider: input.provider,
      creditsUsed: input.creditsUsed,
      success: input.success,
      errorMessage: input.errorMessage,
      resourceId: input.resourceId,
      resourceType: input.resourceType,
      requestId: input.requestId,
      metadata: input.metadata ? { ...input.metadata } : input.metadata,
      createdAt: new Date().toISOString(),
    };

    this.store.usageLogs.push(log);
    return copyRecord(log);
  }

  async getUsageLogs(query: UsageLogQuery): Promise<PortableUsageLog[]> {
    let results = [...this.store.usageLogs];

    // Apply filters
    if (query.userId) {
      results = results.filter((log) => log.userId === query.userId);
    }
    if (query.operationType) {
      results = results.filter((log) => log.operationType === query.operationType);
    }
    if (query.success !== undefined) {
      results = results.filter((log) => log.success === query.success);
    }
    if (query.startDate) {
      const startTime = query.startDate.getTime();
      results = results.filter(
        (log) => toDate(log.createdAt).getTime() >= startTime
      );
    }
    if (query.endDate) {
      const endTime = query.endDate.getTime();
      results = results.filter(
        (log) => toDate(log.createdAt).getTime() <= endTime
      );
    }

    // Sort by createdAt descending
    results.sort((a, b) => {
      return toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime();
    });

    // Apply pagination
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    return copyRecords(results.slice(offset, offset + limit));
  }

  async getUsageLogsCount(
    query: Omit<UsageLogQuery, "limit" | "offset">
  ): Promise<number> {
    const results = await this.getUsageLogs({ ...query, limit: Infinity, offset: 0 });
    return results.length;
  }

  // ==================== Journal Entries ====================

  async createJournalEntry(input: CreateJournalEntryInput): Promise<PortableJournalEntry> {
    assertRepresentableAmount(input.amount, "journal amount", { userId: input.userId });
    assertRepresentableAmount(input.balanceAfter, "journal balanceAfter", {
      userId: input.userId,
    });
    assertValidIdempotencyKey(input.idempotencyKey, { userId: input.userId });
    assertPublicJournalKey(input.idempotencyKey, input.userId);

    // The SQL adapter has a partial unique index on `(user_id, idempotency_key)`.
    // Without the equivalent here, a key written through this public method was
    // invisible to the V2 transitions, which would then happily write a *second*
    // row under the same deterministic key — the ledger would record one event
    // twice and the two adapters would disagree about what happened.
    const key =
      input.idempotencyKey !== undefined
        ? scopedKey(input.userId, input.idempotencyKey)
        : undefined;
    if (key !== undefined && this.store.journalKeys.has(key)) {
      throw new CreditError(
        `Journal idempotency key ${input.idempotencyKey} is already used for user ` +
          `${input.userId}. The unique constraint refuses a second entry.`,
        CreditErrorCode.DATABASE_ERROR,
        { userId: input.userId, idempotencyKey: input.idempotencyKey }
      );
    }

    const entry: PortableJournalEntry = {
      id: generateId(),
      userId: input.userId,
      entryType: input.entryType,
      amount: input.amount,
      balanceAfter: input.balanceAfter,
      source: input.source,
      referenceId: input.referenceId,
      referenceType: input.referenceType,
      description: input.description,
      metadata: input.metadata ? { ...input.metadata } : input.metadata,
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date().toISOString(),
    };

    if (!this.store.journalEntries.has(input.userId)) {
      this.store.journalEntries.set(input.userId, []);
    }
    this.store.journalEntries.get(input.userId)!.push(entry);
    if (key !== undefined) this.store.journalKeys.set(key, entry.id);

    return copyRecord(entry);
  }

  async getJournalEntries(query: JournalEntryQuery): Promise<PortableJournalEntry[]> {
    let results = this.store.journalEntries.get(query.userId) ?? [];

    // Apply filters
    if (query.source) {
      results = results.filter((entry) => entry.source === query.source);
    }
    if (query.referenceType) {
      results = results.filter((entry) => entry.referenceType === query.referenceType);
    }
    if (query.startDate) {
      const startTime = query.startDate.getTime();
      results = results.filter(
        (entry) => toDate(entry.createdAt).getTime() >= startTime
      );
    }
    if (query.endDate) {
      const endTime = query.endDate.getTime();
      results = results.filter(
        (entry) => toDate(entry.createdAt).getTime() <= endTime
      );
    }

    // Sort by createdAt descending
    results = [...results].sort((a, b) => {
      return toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime();
    });

    // Apply pagination
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    return copyRecords(results.slice(offset, offset + limit));
  }

  async getJournalEntriesCount(
    query: Omit<JournalEntryQuery, "limit" | "offset">
  ): Promise<number> {
    const results = await this.getJournalEntries({
      ...query,
      limit: Infinity,
      offset: 0,
    });
    return results.length;
  }

  // ==================== Cleanup Operations ====================

  /**
   * Expire every hold whose deadline has passed.
   *
   * Each candidate goes through the guarded {@link expireReservationV2}, which
   * re-checks the status and the deadline under the user's lock. The previous
   * implementation released the hold and then overwrote the status to
   * `expired`, so a commit landing in between got its credits handed back and
   * was then relabelled.
   */
  async findAndExpireReservations(
    _batchSize = 100,
    _maxIterations = 100
  ): Promise<{
    expiredCount: number;
    creditsReleased: number;
    errors: string[];
  }> {
    const asOf = new Date();
    let expiredCount = 0;
    let creditsReleased = 0;
    const errors: string[] = [];

    // Snapshot the candidates first: expiring mutates the maps being iterated.
    const candidates: Array<{ userId: string; reservationId: string }> = [];
    for (const [userId, userReservations] of this.store.reservations) {
      for (const [reservationId, reservation] of userReservations) {
        if (
          reservation.status === "reserved" &&
          toDate(reservation.expiresAt).getTime() < asOf.getTime()
        ) {
          candidates.push({ userId, reservationId });
        }
      }
    }

    for (const candidate of candidates) {
      try {
        const outcome = await this.expireReservationV2(
          candidate.userId,
          candidate.reservationId,
          { asOf }
        );
        if (outcome.outcome === "expired") {
          expiredCount++;
          creditsReleased = sumAmounts(creditsReleased, outcome.amount);
        }
      } catch (error) {
        errors.push(
          `Failed to expire reservation ${candidate.reservationId}: ${error}`
        );
      }
    }

    return { expiredCount, creditsReleased, errors };
  }

  // ==================== Atomic Monthly Reset ====================

  async atomicMonthlyReset(
    userId: string,
    tier: SubscriptionTier,
    expectedResetAt: Date | string
  ): Promise<MonthlyResetResult> {
    const credits = this.store.users.get(userId);
    if (!credits) {
      throw new Error(`User ${userId} not found`);
    }

    // Optimistic locking: check if expectedResetAt matches current value
    const currentResetAt = toDate(credits.monthlyResetAt).getTime();
    const expected = toDate(expectedResetAt).getTime();

    if (currentResetAt !== expected) {
      // Another request already performed the reset
      return { wasReset: false, credits: { ...credits } };
    }

    // Perform the reset
    const newBalance = getConfigMonthlyLimit(tier);
    assertRepresentableTierAmount(newBalance, "monthlyLimit", { userId, tier });
    const nextReset = getNextMonthlyReset();

    // The unlimited contract, from the one place that defines it. This used to
    // read `newBalance === Infinity ? credits.balance : newBalance` — "leave an
    // unlimited balance alone" — which never restored an unlimited account whose
    // balance had been driven to zero. See `monthlyResetBalance`.
    // Floored at what still backs the outstanding holds: a reset that cut
    // `balance + bonusCredits` below `reserved` would strand every live
    // reservation at commit time with INSUFFICIENT_CREDITS. See
    // `backedBalanceFloor`.
    const target = monthlyResetBalance(tier);
    const floor = backedBalanceFloor(credits.reserved, credits.bonusCredits);
    credits.balance =
      target.kind === "atLeast"
        ? Math.max(credits.balance, target.value, floor)
        : Math.max(target.value, floor);
    credits.monthlyUsed = 0;
    credits.monthlyResetAt = nextReset.toISOString();
    credits.updatedAt = new Date().toISOString();

    this.store.users.set(userId, credits);

    return { wasReset: true, credits: { ...credits } };
  }

  // ==================== Subscription Expiry ====================

  async checkAndHandleSubscriptionExpiry(
    userId: string,
    gracePeriodDays = 3
  ): Promise<SubscriptionExpiryResult> {
    const credits = this.store.users.get(userId);
    if (!credits) {
      throw new Error(`User ${userId} not found`);
    }

    // Free tier doesn't expire
    if (isFreeTier(credits.tier) || !credits.subscriptionExpiresAt) {
      return {
        wasDowngraded: false,
        inGracePeriod: false,
        graceDaysRemaining: 0,
        credits: { ...credits },
      };
    }

    const now = new Date();
    const expiresAt = toDate(credits.subscriptionExpiresAt);
    const daysSinceExpiry =
      (now.getTime() - expiresAt.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceExpiry <= 0) {
      // Not expired yet
      return {
        wasDowngraded: false,
        inGracePeriod: false,
        graceDaysRemaining: 0,
        credits: { ...credits },
      };
    }

    if (daysSinceExpiry <= gracePeriodDays) {
      // In grace period
      return {
        wasDowngraded: false,
        inGracePeriod: true,
        graceDaysRemaining: Math.ceil(gracePeriodDays - daysSinceExpiry),
        credits: { ...credits },
      };
    }

    // Grace period expired - downgrade to the configured default tier
    const defaultTier = getDefaultTier();
    // `getConfigMonthlyLimit`, not the raw `monthlyCredits`: in tier *config*
    // zero means unlimited, so reading the field directly would downgrade onto
    // an unlimited default tier with a limit and a balance of zero.
    const configured = getConfigMonthlyLimit(defaultTier);
    assertRepresentableTierAmount(configured, "monthlyLimit", {
      userId,
      tier: defaultTier,
    });
    const limit = storedMonthlyLimit(configured);

    credits.tier = defaultTier;
    credits.monthlyLimit = limit;
    // The downgrade may cut the balance to the new tier's limit, but never
    // below what still backs the outstanding holds — see `backedBalanceFloor`.
    credits.balance = Math.max(
      Math.min(credits.balance, limit),
      backedBalanceFloor(credits.reserved, credits.bonusCredits)
    );
    credits.subscriptionExpiresAt = null;
    credits.updatedAt = new Date().toISOString();

    this.store.users.set(userId, credits);

    return {
      wasDowngraded: true,
      inGracePeriod: false,
      graceDaysRemaining: 0,
      credits: { ...credits },
    };
  }

  // ==================== Testing Utilities ====================

  /**
   * Clear all data (useful for testing)
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Install a yield point inside every V2 critical section (testing only).
   *
   * Unset, the critical sections run start-to-finish synchronously, so
   * concurrent callers never interleave and a concurrency test would pass even
   * with the locking removed. Setting this to a real yield (a macrotask or a
   * barrier) makes callers genuinely overlap, so the tests exercise the lock
   * instead of the event loop. Never call this in production code.
   */
  setSchedulingHook(hook: (() => Promise<void>) | undefined): void {
    this.store.schedulingHook = hook;
  }

  /**
   * Get all users (useful for testing/debugging)
   */
  getAllUsers(): PortableUserCredits[] {
    return copyRecords(Array.from(this.store.users.values()));
  }

  /**
   * Get all reservations for a user (useful for testing)
   */
  getAllReservations(userId: string): PortableReservation[] {
    const userReservations = this.store.reservations.get(userId);
    if (!userReservations) return [];
    return copyRecords(Array.from(userReservations.values()));
  }
}

/**
 * Create a new in-memory repository instance
 * Each call creates a fresh, isolated instance
 */
export function createInMemoryCreditRepository(): InMemoryCreditRepository {
  return new InMemoryCreditRepository();
}
