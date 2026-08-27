import { eq } from 'drizzle-orm'
import {
  getConfigMonthlyLimit,
  getDefaultTier,
  getNextMonthlyReset,
  storedMonthlyLimit,
  type PortableUserCredits,
  type SubscriptionTier,
} from '@nehorai/credits'
import { creditBalances } from '../schema/index.js'
import type { DrizzleLikeDB } from './db.js'
import { toUserCredits } from './mappers.js'

/**
 * Get the user's balance row, creating it at tier defaults if absent.
 *
 * Uses insert-then-reread rather than a bare select so two concurrent first
 * operations for the same user cannot both decide the row is missing:
 * `onConflictDoNothing` makes the loser a no-op that then reads the winner's row.
 */
export async function ensureUserCredits(
  db: DrizzleLikeDB,
  userId: string,
  // The *configured* default, not a hard-coded 'free': an app is free to
  // configure a different default tier, and hard-coding here would auto-create
  // users onto a tier the in-memory adapter (and the downgrade path) never
  // uses.
  tier: SubscriptionTier = getDefaultTier()
): Promise<PortableUserCredits> {
  const existing = await db
    .select()
    .from(creditBalances)
    .where(eq(creditBalances.userId, userId))
    .limit(1)
  if (existing[0]) return toUserCredits(existing[0])

  // `storedMonthlyLimit`, not a local `isFinite ? x : 0`: coercing the
  // unlimited sentinel to zero here would auto-create an unlimited user with no
  // allowance and no credits — the opposite of the tier they are on — and would
  // diverge from both `initializeUserCredits` implementations.
  const initialBalance = storedMonthlyLimit(getConfigMonthlyLimit(tier))
  const inserted = await db
    .insert(creditBalances)
    .values({
      userId,
      tier,
      balance: String(initialBalance),
      monthlyLimit: String(initialBalance),
      monthlyResetAt: getNextMonthlyReset(),
    })
    .onConflictDoNothing()
    .returning()

  if (inserted[0]) return toUserCredits(inserted[0])

  const afterConflict = await db
    .select()
    .from(creditBalances)
    .where(eq(creditBalances.userId, userId))
    .limit(1)
  if (!afterConflict[0]) {
    throw new Error(`Failed to initialize credits for user ${userId}`)
  }
  return toUserCredits(afterConflict[0])
}

/**
 * Ensure the row exists, then lock it for the caller's transaction.
 *
 * The atomic balance operations derive several stored values from what they
 * read — the new bonus total, the transaction's previous and new balance, the
 * journal's `balanceAfter` — and every one of them has to be validated before
 * anything is written, so that a refusal names the field that actually failed
 * instead of guessing. Validating a value read at time T and writing at time
 * T+1 is only sound if the row cannot change in between, which is what
 * `FOR UPDATE` buys: concurrent callers serialize on the lock rather than
 * racing, exactly as the expression-based updates used to make them do.
 */
export async function lockUserCredits(
  tx: DrizzleLikeDB,
  userId: string
): Promise<PortableUserCredits> {
  await ensureUserCredits(tx, userId)
  const credits = await lockUserCreditsIfPresent(tx, userId)
  if (!credits) throw new Error(`User credits not found for user ${userId}`)
  return credits
}

/**
 * The same lock, for an operation that must not create the row.
 *
 * `deductCreditsAtomic` reports a missing ledger as a distinct failure that
 * callers match on, so it cannot go through {@link lockUserCredits}.
 */
export async function lockUserCreditsIfPresent(
  tx: DrizzleLikeDB,
  userId: string
): Promise<PortableUserCredits | null> {
  const rows = await tx
    .select()
    .from(creditBalances)
    .where(eq(creditBalances.userId, userId))
    .for('update')
    .limit(1)
  return rows[0] ? toUserCredits(rows[0]) : null
}
