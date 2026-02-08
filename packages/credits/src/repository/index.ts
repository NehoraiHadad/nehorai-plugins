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
} from "./types";

export { toClientUserCredits } from "./types";

// Shared utilities
export { generateId, toDate, getNextMonthlyReset } from "./utils";

// In-memory implementation (for testing and prototyping)
export {
  InMemoryCreditRepository,
  createInMemoryCreditRepository,
} from "./memory";
