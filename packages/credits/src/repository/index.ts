/**
 * Credits repository - barrel exports
 *
 * Provides database-agnostic interface for credits storage
 */

// Types and interfaces
export type {
  ICreditRepository,
  CreditRepositoryFactory,
  CreateReservationInput,
  CreateTransactionInput,
  CreateUsageLogInput,
  CreateJournalEntryInput,
  UsageLogQuery,
  JournalEntryQuery,
  CreditBalanceUpdate,
  TierUpdateInput,
  AddCreditsAtomicOptions,
} from "./types.js";

export {
  toClientUserCredits,
  supportsCreditsV2,
  supportsIdempotentCredit,
} from "./types.js";

// V2 boundary (idempotent, race-safe reservations)
export type {
  ICreditRepositoryV2,
  ICreditRepositoryCreditsV2,
  AddCreditsV2Input,
  ReserveCreditsV2Input,
  ReservationTransitionOptions,
  ExpireReservationV2Options,
} from "./v2-types.js";
export { reservationJournalKey } from "./v2-types.js";
export {
  reserveThroughRepository,
  commitThroughRepository,
  releaseThroughRepository,
  addCreditsThroughRepository,
} from "./flow.js";

// Shared utilities
export { generateId, toDate, getNextMonthlyReset } from "./utils.js";

// In-memory implementation (for testing and prototyping)
export {
  InMemoryCreditRepository,
  createInMemoryCreditRepository,
} from "./memory/index.js";
