import type {
  PortableJournalEntry,
  PortableReservation,
  PortableTransaction,
  PortableUsageLog,
  PortableUserCredits,
} from "../../core/types.js";
import { KeyedMutex } from "./mutex.js";

/**
 * Backing state for {@link InMemoryCreditRepository}.
 *
 * Split out so the V2 transition logic can operate on the same state without
 * the repository class having to expose its internals publicly.
 */
export class MemoryStore {
  readonly users = new Map<string, PortableUserCredits>();
  readonly reservations = new Map<string, Map<string, PortableReservation>>();
  readonly transactions = new Map<string, PortableTransaction[]>();
  usageLogs: PortableUsageLog[] = [];
  readonly journalEntries = new Map<string, PortableJournalEntry[]>();

  /** Stands in for the reservations table's partial unique index. */
  readonly reservationKeys = new Map<string, string>();
  /** Stands in for the journal table's partial unique index. */
  readonly journalKeys = new Map<string, string>();

  /** Stands in for the database's per-user row locks. */
  readonly locks = new KeyedMutex();

  /**
   * Test-only yield point, awaited between reading state and mutating it.
   *
   * Unset in production, so the critical sections stay synchronous and this
   * costs nothing. Tests set it to a real macrotask yield, which forces
   * concurrent callers to interleave at exactly the spot a database would have
   * them contend — turning the lock above from decoration into the thing the
   * concurrency tests actually depend on.
   */
  schedulingHook?: () => Promise<void>;

  clear(): void {
    this.users.clear();
    this.reservations.clear();
    this.transactions.clear();
    this.usageLogs = [];
    this.journalEntries.clear();
    this.reservationKeys.clear();
    this.journalKeys.clear();
  }
}

/**
 * Composite map key standing in for a two-column unique index.
 *
 * The separator is a newline because it cannot appear in a user id and is
 * vanishingly unlikely in a caller-supplied idempotency key, so two distinct
 * pairs cannot collide into one entry.
 */
export function scopedKey(userId: string, key: string): string {
  return `${userId}\n${key}`;
}
