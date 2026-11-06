import { createUserNotFoundError } from "@nehorai/credits";
import type { PortableUserCredits, SubscriptionTier } from "@nehorai/credits";
import { createHash } from "node:crypto";
import type {
  DocumentData,
  DocumentReference,
  Transaction,
  UpdateData,
} from "firebase-admin/firestore";
import { toISOString } from "./shared.js";

/**
 * The balance document as stored.
 */
export interface FirestoreUserCredits {
  userId: string;
  balance: number;
  bonusCredits?: number;
  reserved: number;
  tier: SubscriptionTier;
  monthlyLimit: number;
  monthlyUsed: number;
  monthlyResetAt: unknown;
  subscriptionExpiresAt?: unknown;
  /** See `PortableUserCredits.expiredHoldBacking`. Missing on older documents. */
  expiredHoldBacking?: number;
  /** See `PortableUserCredits.signupGrant`. Missing on older documents. */
  signupGrant?: number;
  createdAt: unknown;
  updatedAt: unknown;
}

/**
 * Convert the stored document to portable format
 */
export function toPortableCredits(data: FirestoreUserCredits): PortableUserCredits {
  return {
    userId: data.userId,
    balance: data.balance,
    bonusCredits: data.bonusCredits ?? 0,
    reserved: data.reserved,
    tier: data.tier,
    monthlyLimit: data.monthlyLimit,
    monthlyUsed: data.monthlyUsed,
    monthlyResetAt: toISOString(data.monthlyResetAt),
    subscriptionExpiresAt: data.subscriptionExpiresAt
      ? toISOString(data.subscriptionExpiresAt)
      : null,
    ...(data.expiredHoldBacking !== undefined
      ? { expiredHoldBacking: data.expiredHoldBacking }
      : {}),
    ...(data.signupGrant !== undefined ? { signupGrant: data.signupGrant } : {}),
    createdAt: toISOString(data.createdAt),
    updatedAt: toISOString(data.updatedAt),
  };
}

/**
 * Whether a credit or a reserve may create a missing account.
 */
export interface AccountSeedOptions {
  /**
   * Default true. False makes these paths throw `USER_NOT_FOUND` for a missing
   * account and write nothing, so only `initializeUserCredits` creates accounts.
   */
  seedMissingAccounts?: boolean;
}

/** Call inside the transaction, before any write, when the account is missing. */
export function assertMayCreateAccount(userId: string, options?: AccountSeedOptions): void {
  if (options?.seedMissingAccounts === false) throw createUserNotFoundError(userId);
}

/**
 * A caller's document updated in the same transaction as a credit, and only when
 * that credit applies. A missing document fails the transaction, so no credit lands
 * for an order that is not there.
 */
export interface CallerDocUpdate {
  ref: DocumentReference;
  data: UpdateData<DocumentData>;
}

export function applyCallerDocUpdate(transaction: Transaction, update?: CallerDocUpdate): void {
  if (update) transaction.update(update.ref, update.data);
}

/** A document id for a caller key, which may contain `/`. */
export function deterministicDocId(prefix: string, key: string): string {
  return `${prefix}-${createHash("sha256").update(key).digest("hex")}`;
}
