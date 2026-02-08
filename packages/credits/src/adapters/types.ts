/**
 * Adapter types for the credits system
 *
 * Defines the interface for framework-specific adapters that wrap
 * credit operations with different execution strategies.
 */

import type { PortableReservation, WithCreditsOptions } from "../core/types.js";
import type { CreditsUser, ICreditsAuthProvider } from "../auth/types.js";
import type { ICreditRepository } from "../repository/types.js";
import type { DeferredExecutor } from "../core/index.js";

/**
 * Generic action result type
 */
export interface ActionResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Handler function signature for credit-wrapped actions
 */
export type CreditActionHandler<TInput, TOutput> = (
  user: CreditsUser,
  data: TInput,
  reservation: PortableReservation
) => Promise<ActionResult<TOutput>>;

/**
 * Configuration for creating a credits adapter
 */
export interface CreditsAdapterConfig {
  /** Repository for credit operations */
  repository: ICreditRepository;
  /** Auth provider for user authentication */
  authProvider: ICreditsAuthProvider;
  /** Deferred executor for background tasks */
  deferred: DeferredExecutor;
  /** Operation cost lookup table */
  operationCosts: Record<string, number>;
}

/**
 * Interface for credits adapters
 */
export interface CreditsAdapter {
  /**
   * Wrap an action function with credit handling
   */
  withCredits<TInput, TOutput>(
    options: WithCreditsOptions,
    handler: CreditActionHandler<TInput, TOutput>
  ): (data: TInput) => Promise<ActionResult<TOutput>>;
}
