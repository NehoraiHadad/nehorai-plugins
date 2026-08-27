import type {
  AIProviderType,
  CreditOperationType,
  JournalReferenceType,
  PortableJournalEntry,
  PortableReservation,
  PortableTransaction,
  PortableUsageLog,
  PortableUserCredits,
  ReservationStatus,
  SubscriptionTier,
} from '@nehorai/credits'
import type {
  CreditBalanceRow,
  CreditJournalEntryRow,
  CreditPluginTransactionRow,
  CreditReservationRow,
  CreditUsageLogRow,
} from '../schema/index.js'

/** Coerce a `numeric` column (driver returns a string) to a JS number. */
export function numberValue(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return value
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function dateValue(value: Date | string | null | undefined): Date | null {
  if (!value) return null
  return value instanceof Date ? value : new Date(value)
}

export function iso(value: Date | string | null | undefined): string {
  if (!value) return new Date().toISOString()
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function toUserCredits(row: CreditBalanceRow): PortableUserCredits {
  return {
    userId: row.userId,
    balance: numberValue(row.balance),
    bonusCredits: numberValue(row.bonusCredits),
    reserved: numberValue(row.reserved),
    tier: row.tier as SubscriptionTier,
    monthlyLimit: numberValue(row.monthlyLimit),
    monthlyUsed: numberValue(row.monthlyUsed),
    monthlyResetAt: iso(row.monthlyResetAt),
    subscriptionExpiresAt: row.subscriptionExpiresAt ? iso(row.subscriptionExpiresAt) : null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}

export function toReservation(row: CreditReservationRow): PortableReservation {
  return {
    id: row.id,
    userId: row.userId,
    amount: numberValue(row.amount),
    operationType: row.operationType as CreditOperationType,
    status: row.status as ReservationStatus,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    completedAt: row.completedAt ? iso(row.completedAt) : undefined,
    idempotencyKey: row.idempotencyKey ?? undefined,
    holdPlacedAt: row.holdPlacedAt ? iso(row.holdPlacedAt) : undefined,
  }
}

export function toTransaction(row: CreditPluginTransactionRow): PortableTransaction {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type as PortableTransaction['type'],
    amount: numberValue(row.amount),
    description: row.description,
    paymentRef: row.paymentRef ?? undefined,
    previousBalance: numberValue(row.previousBalance),
    newBalance: numberValue(row.newBalance),
    createdAt: iso(row.createdAt),
  }
}

export function toUsageLog(row: CreditUsageLogRow): PortableUsageLog {
  return {
    id: row.id,
    userId: row.userId,
    operationType: row.operationType as CreditOperationType,
    provider: row.provider as AIProviderType,
    creditsUsed: numberValue(row.creditsUsed),
    success: row.success,
    errorMessage: row.errorMessage ?? undefined,
    resourceId: row.resourceId ?? undefined,
    resourceType: row.resourceType ?? undefined,
    requestId: row.requestId ?? undefined,
    metadata: row.metadata ?? undefined,
    createdAt: iso(row.createdAt),
  }
}

export function toJournalEntry(row: CreditJournalEntryRow): PortableJournalEntry {
  return {
    id: row.id,
    userId: row.userId,
    entryType: row.entryType as 'debit' | 'credit',
    amount: numberValue(row.amount),
    balanceAfter: numberValue(row.balanceAfter),
    source: row.source as PortableJournalEntry['source'],
    referenceId: row.referenceId,
    referenceType: row.referenceType as JournalReferenceType,
    description: row.description,
    metadata: row.metadata ?? undefined,
    idempotencyKey: row.idempotencyKey ?? undefined,
    createdAt: iso(row.createdAt),
  }
}
