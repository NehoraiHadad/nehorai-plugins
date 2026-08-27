import { eq, sql } from 'drizzle-orm'
import {
  CreditError,
  CreditErrorCode,
  assertRepresentableFields,
  assertValidCreditAmount,
  describePaymentMismatch,
  normalizePaymentRef,
  sumAmounts,
  type AddCreditsOutcome,
  type AddCreditsV2Input,
  type PaymentEventPayload,
} from '@nehorai/credits'
import {
  creditBalances,
  creditJournalEntries,
  creditPluginTransactions,
  type CreditPluginTransactionRow,
} from '../schema/index.js'
import { withTx, type DrizzleLikeDB } from './db.js'
import { lockUserCredits } from './ensure-user.js'
import { toTransaction } from './mappers.js'
import { rejectOverflowAsAmountError } from './v2/shared.js'

/**
 * Credit an account, resolving `paymentRef` to created / replayed / conflict.
 *
 * `paymentRef` is a *global* idempotency boundary, not a per-user one: the same
 * provider reference must name the same credit event whoever presents it. The
 * arbiter is the partial unique index on `payment_ref`, so the decision is made
 * by PostgreSQL under concurrency rather than by a read-then-write that two
 * sessions can both win.
 *
 * Order matters. The transaction row - the thing the index guards - is inserted
 * *before* the balance moves, so a replay or a conflict writes nothing at all.
 * The previous implementation checked with a SELECT, credited, and only then
 * inserted; two concurrent callers both saw an empty SELECT, and the loser
 * either double-credited or aborted with the balance already changed.
 */
export async function addCreditsV2(
  db: DrizzleLikeDB,
  input: AddCreditsV2Input
): Promise<AddCreditsOutcome> {
  const { userId, amount, description, options } = input
  assertValidCreditAmount(amount, { userId, operation: 'addCredits' })

  // Empty and whitespace-only strings are not references. Normalised in one
  // place so this adapter and the in-memory one agree on which calls carry one:
  // a blank string used to skip the duplicate check (falsy) and then be stored,
  // where it occupied an index slot that could never be matched again.
  const paymentRef = normalizePaymentRef(input.paymentRef)
  const payload: PaymentEventPayload = {
    userId,
    amount,
    type: 'purchase',
    source: options?.source ?? 'purchase',
    referenceType: options?.referenceType ?? 'transaction',
  }

  return rejectOverflowAsAmountError(
    userId,
    'addCredits',
    ['bonusCredits', 'previousBalance', 'newBalance'],
    () =>
      withTx(db, async (tx) => {
        // Locked, then derived, then validated, then written. The update used
        // to be an expression (`bonus_credits + amount`) evaluated by
        // PostgreSQL, which meant the only thing that could catch an unstorable
        // result was SQLSTATE 22003 - and 22003 does not say which expression
        // produced it, so a failure in the derived transaction total was
        // reported as a `bonusCredits` overflow.
        const credits = await lockUserCredits(tx, userId)
        const previousBalance = sumAmounts(credits.balance, credits.bonusCredits)
        const nextBonusCredits = sumAmounts(credits.bonusCredits, amount)
        const newBalance = sumAmounts(credits.balance, nextBonusCredits)
        assertRepresentableFields(
          { previousBalance, bonusCredits: nextBonusCredits, newBalance },
          { userId, operation: 'addCredits' }
        )

        const inserted = await insertTransaction(tx, {
          userId,
          amount,
          description,
          paymentRef,
          previousBalance,
          newBalance,
        })

        if (!inserted) {
          if (!paymentRef) {
            // Without a reference no arbiter can match, so DO NOTHING cannot
            // have fired and an empty RETURNING is unexplained.
            throw new CreditError(
              `Credit transaction insert returned no row for user ${userId}`,
              CreditErrorCode.DATABASE_ERROR,
              { userId }
            )
          }
          return resolveExistingPayment(tx, paymentRef, payload)
        }

        await tx
          .update(creditBalances)
          .set({ bonusCredits: String(nextBonusCredits), updatedAt: new Date() })
          .where(eq(creditBalances.userId, userId))

        const journalMetadata = {
          ...(paymentRef ? { paymentRef } : {}),
          ...(options?.metadata ?? {}),
        }

        const journal = await tx
          .insert(creditJournalEntries)
          .values({
            userId,
            entryType: 'credit',
            amount: String(amount),
            balanceAfter: String(newBalance),
            source: payload.source,
            referenceId: inserted.id ?? paymentRef ?? 'unknown',
            referenceType: payload.referenceType,
            description,
            metadata: Object.keys(journalMetadata).length > 0 ? journalMetadata : undefined,
          })
          .returning()

        const transaction = toTransaction(inserted)
        const journalEntryId = journal[0]?.id
        return paymentRef
          ? { outcome: 'created' as const, paymentRef, transaction, journalEntryId }
          : { outcome: 'created' as const, transaction, journalEntryId }
      })
  )
}

interface TransactionInsert {
  userId: string
  amount: number
  description: string
  paymentRef?: string
  previousBalance: number
  newBalance: number
}

/**
 * Insert the purchase row, letting the unique index arbitrate a repeat.
 *
 * The conflict clause is only attached when a reference is actually present.
 * That keeps the failure mode honest in both directions: an unreferenced credit
 * never depends on the index existing, while a referenced one does - and if the
 * index is missing or has drifted, PostgreSQL raises SQLSTATE 42P10 ("no unique
 * or exclusion constraint matching the ON CONFLICT specification") rather than
 * silently inserting a duplicate. Deduplication that cannot be performed is
 * reported, never assumed.
 */
async function insertTransaction(
  tx: DrizzleLikeDB,
  input: TransactionInsert
): Promise<CreditPluginTransactionRow | undefined> {
  const values = {
    userId: input.userId,
    type: 'purchase' as const,
    amount: String(input.amount),
    description: input.description,
    paymentRef: input.paymentRef,
    previousBalance: String(input.previousBalance),
    newBalance: String(input.newBalance),
  }

  if (!input.paymentRef) {
    const rows = await tx.insert(creditPluginTransactions).values(values).returning()
    return rows[0]
  }

  const rows = await tx
    .insert(creditPluginTransactions)
    .values(values)
    .onConflictDoNothing({
      target: creditPluginTransactions.paymentRef,
      where: sql`payment_ref is not null`,
    })
    .returning()
  return rows[0]
}

/**
 * Decide whether the row already holding this reference is the same event.
 *
 * Presence is not enough. A reference that arrives again for a different user,
 * a different amount or a different source names a *different* credit event,
 * and reporting it as a replay would credit the first amount and call the
 * second one done. The comparison is against the raw stored `numeric`, so a row
 * that a wider legacy column let past the cent grid cannot pass as equal.
 */
async function resolveExistingPayment(
  tx: DrizzleLikeDB,
  paymentRef: string,
  payload: PaymentEventPayload
): Promise<AddCreditsOutcome> {
  const rows = await tx
    .select()
    .from(creditPluginTransactions)
    .where(eq(creditPluginTransactions.paymentRef, paymentRef))
    .limit(1)

  const existing = rows[0]
  if (!existing) {
    // The reference holder rolled back between our INSERT and this SELECT.
    // Retrying is the correct response, so say so instead of guessing.
    throw new CreditError(
      `Payment reference ${paymentRef} conflicted but no transaction was found`,
      CreditErrorCode.TRANSIENT_ERROR,
      { userId: payload.userId, paymentRef }
    )
  }

  const journalRows = await tx
    .select()
    .from(creditJournalEntries)
    .where(eq(creditJournalEntries.referenceId, existing.id))
    .limit(1)
  const journal = journalRows[0]

  const mismatch = describePaymentMismatch(
    {
      userId: existing.userId,
      amount: existing.amount,
      type: existing.type,
      source: journal?.source,
      referenceType: journal?.referenceType,
    },
    payload
  )

  const transaction = toTransaction(existing)
  return mismatch === null
    ? { outcome: 'replayed', paymentRef, transaction }
    : { outcome: 'conflict', paymentRef, existing: transaction, mismatch }
}
