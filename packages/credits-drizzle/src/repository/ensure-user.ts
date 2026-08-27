import { eq } from 'drizzle-orm'
import {
  getConfigMonthlyLimit,
  getNextMonthlyReset,
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
  tier: SubscriptionTier = 'free'
): Promise<PortableUserCredits> {
  const existing = await db
    .select()
    .from(creditBalances)
    .where(eq(creditBalances.userId, userId))
    .limit(1)
  if (existing[0]) return toUserCredits(existing[0])

  const monthlyLimit = getConfigMonthlyLimit(tier)
  const initialBalance = Number.isFinite(monthlyLimit) ? monthlyLimit : 0
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
