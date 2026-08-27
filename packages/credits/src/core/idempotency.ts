/**
 * Validation for caller-supplied idempotency keys.
 *
 * The keys are enforced by a *partial* unique index (`WHERE idempotency_key IS
 * NOT NULL`), so "no key" and "a key" are genuinely different states and the
 * boundary between them has to be unambiguous. An empty string sat in between:
 * the SQL adapter stored it — occupying a row in the unique index — while every
 * `if (key)` check read it as absent, so the key was written but never
 * deduplicated anything, and the in-memory adapter ignored it outright. Two
 * adapters, two behaviours, neither of them the one the caller asked for.
 *
 * Rejecting is preferred over trimming. Normalising `" job-1 "` to `"job-1"`
 * would mean two callers who sent different strings silently share a hold, and
 * a caller whose key is accidentally whitespace would rather hear about it than
 * have it quietly repaired.
 */

import { CreditError, CreditErrorCode } from "./errors.js";

/** A usable key: a string with at least one non-whitespace character. */
export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Reject an unusable idempotency key before anything is written.
 *
 * `undefined` is allowed and means "no key" — that is the legacy, at-least-once
 * behaviour, and it is a valid choice. Only a key that was *supplied* and
 * cannot work is an error.
 */
export function assertValidIdempotencyKey(
  value: unknown,
  context?: Record<string, unknown>
): asserts value is string | undefined {
  if (value === undefined || value === null) return;
  if (isValidIdempotencyKey(value)) return;
  throw new CreditError(
    typeof value === "string"
      ? "An idempotency key was supplied but is empty or whitespace-only. It " +
        "cannot deduplicate anything, so it was rejected rather than stored " +
        "as a key that never matches. Omit the key for at-least-once " +
        "behaviour, or send a meaningful one."
      : `Idempotency key must be a string (got ${typeof value})`,
    CreditErrorCode.INVALID_IDEMPOTENCY_KEY,
    { idempotencyKey: value, ...context }
  );
}

/**
 * Namespace the V2 reservation transitions own. Public writes may not use it.
 *
 * A transition that finds its deterministic key already present treats an
 * exactly-matching row as its own retry and reuses it. That is correct against
 * a row the transition itself wrote — and a hole if any caller can write one.
 * A caller who pre-seeds `reservation:<id>:commit` with a plausible-looking
 * entry would have the commit adopt it: the reservation flips to committed and
 * the balance moves, while the only journal row is the caller's, never written
 * by the transition and not necessarily describing what it did.
 *
 * Reserving the prefix removes the premise. Nothing outside the transitions can
 * create a key in it, so an existing key is either the transition's own retry
 * or corruption — and corruption is refused.
 */
export const RESERVED_JOURNAL_KEY_PREFIX = "reservation:";

/** True when a key belongs to the namespace the V2 transitions own. */
export function isReservedJournalKey(key: unknown): boolean {
  return typeof key === "string" && key.startsWith(RESERVED_JOURNAL_KEY_PREFIX);
}

/**
 * Refuse a public journal write that claims a key in the reserved namespace.
 *
 * Called from the adapters' public `createJournalEntry`, never from the
 * transitions themselves — they are the ones the namespace belongs to.
 */
export function assertPublicJournalKey(key: unknown, userId: string): void {
  if (!isReservedJournalKey(key)) return;
  throw new CreditError(
    `Idempotency keys starting with "${RESERVED_JOURNAL_KEY_PREFIX}" are reserved for ` +
      'the V2 reservation transitions and cannot be written directly. Use a key of ' +
      'your own, or commit/release/expire the reservation through the V2 methods.',
    CreditErrorCode.INVALID_IDEMPOTENCY_KEY,
    { userId, idempotencyKey: key, reason: "reserved_namespace" }
  );
}
