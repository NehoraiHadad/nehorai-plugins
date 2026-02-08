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
} from "./types.js";

export { toClientUserCredits } from "./types.js";

// Shared utilities
export { generateId, toDate, getNextMonthlyReset } from "./utils.js";

// In-memory implementation (for testing and prototyping)
export {
  InMemoryCreditRepository,
  createInMemoryCreditRepository,
} from "./memory/index.js";
