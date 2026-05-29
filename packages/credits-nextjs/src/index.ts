/**
 * @nehorai/credits-nextjs - Next.js adapter for the credits system
 *
 * Provides Next.js-specific integrations:
 * - Deferred execution using next/server after()
 * - NextAuth integration for authentication
 * - withCredits HOF for server actions
 *
 * @example
 * ```typescript
 * import { withCredits, nextJsDeferred } from '@nehorai/credits-nextjs';
 *
 * // Create a server action with credit handling
 * export const generateStory = withCredits(
 *   { operationType: 'story_generation' },
 *   async (user, data, reservation) => {
 *     const story = await generateStoryContent(data);
 *     return { success: true, data: story };
 *   }
 * );
 * ```
 */

// Re-export everything from core credits package
export * from "@nehorai/credits";

// ==================== Next.js Deferred Executor ====================

import type { DeferredExecutor } from "@nehorai/credits";

/**
 * Create a Next.js deferred executor
 *
 * This factory allows the adapter to be used without importing next/server
 * directly, making it compatible with different bundling scenarios.
 *
 * @param afterFn - The after() function from next/server
 * @returns DeferredExecutor instance
 */
export function createNextJsDeferredExecutor(
  afterFn: (fn: () => Promise<void>) => void
): DeferredExecutor {
  return {
    defer(fn: () => Promise<void>): void {
      afterFn(fn);
    },
  };
}

// ==================== NextAuth Auth Provider ====================

import type { ICreditsAuthProvider, CreditsUser } from "@nehorai/credits";

/**
 * Configuration for NextAuth credentials provider
 */
export interface NextAuthCreditsProviderConfig {
  /**
   * Function to get the current user from NextAuth session
   * This allows the provider to work with any NextAuth configuration
   */
  getCurrentUser: () => Promise<{ id: string; email?: string | null; name?: string | null } | null>;

  /**
   * Optional list of admin user IDs or emails
   * If not provided, no users will have admin access
   */
  adminUsers?: Set<string> | string[];
}

/**
 * NextAuth implementation of ICreditsAuthProvider
 *
 * Uses the provided getCurrentUser function for authentication.
 * This makes it compatible with any NextAuth configuration.
 */
export class NextAuthCreditsProvider implements ICreditsAuthProvider {
  private readonly getCurrentUserFn: NextAuthCreditsProviderConfig["getCurrentUser"];
  private readonly adminUsers: Set<string>;

  constructor(config: NextAuthCreditsProviderConfig) {
    this.getCurrentUserFn = config.getCurrentUser;
    this.adminUsers = config.adminUsers instanceof Set
      ? config.adminUsers
      : new Set(config.adminUsers ?? []);
  }

  async getCurrentUser(): Promise<CreditsUser | null> {
    const user = await this.getCurrentUserFn();

    if (!user?.id) {
      return null;
    }

    return {
      id: user.id,
      email: user.email ?? null,
      name: user.name ?? null,
    };
  }

  async verifyAdminAccess(userId: string): Promise<boolean> {
    // Check if user ID is in admin list
    if (this.adminUsers.has(userId)) {
      return true;
    }

    // Also check by email if available
    const user = await this.getCurrentUserFn();
    if (user?.email && this.adminUsers.has(user.email)) {
      return true;
    }

    return false;
  }
}

/**
 * Create a NextAuth credentials provider
 *
 * @param config - Provider configuration
 * @returns NextAuth credentials provider instance
 */
export function createNextAuthCreditsProvider(
  config: NextAuthCreditsProviderConfig
): NextAuthCreditsProvider {
  return new NextAuthCreditsProvider(config);
}

// ==================== With Credits HOF ====================

import type {
  CreditsAdapterConfig,
  ActionResult,
  PortableReservation,
  WithCreditsOptions,
  AIProviderType,
} from "@nehorai/credits";
import {
  commitReservationWithJournal,
  releaseReservationWithJournal,
  reserveCreditsForOperation,
  isPreviewMode,
  createDummyReservation,
} from "@nehorai/credits";

/**
 * Handler function type for withCredits
 */
export type CreditActionHandler<TInput, TOutput> = (
  user: CreditsUser,
  data: TInput,
  reservation: PortableReservation
) => Promise<ActionResult<TOutput>>;

/**
 * Overridable user-facing error messages returned by the wrapped action.
 */
export interface WithCreditsErrorMessages {
  /** Returned when the auth provider yields no authenticated user. */
  unauthorized?: string;
  /** Fallback when reservation fails with a non-Error throw. */
  reserveFailed?: string;
  /** Fallback when the handler throws a non-Error value. */
  unexpected?: string;
}

/**
 * Context passed to the {@link WithCreditsConfig.afterCommit} hook.
 */
export interface AfterCommitContext {
  userId: string;
  operationType: string;
  /** Credits committed (deducted) for this operation. */
  cost: number;
  reservationId: string;
  requestId: string;
}

/**
 * Context passed to the {@link WithCreditsConfig.onError} hook.
 */
export interface ActionErrorContext {
  userId: string;
  operationType: string;
  /** The value thrown by the handler (already released + logged). */
  error: unknown;
  requestId: string;
}

/**
 * Configuration for withCredits
 */
export interface WithCreditsConfig extends Omit<CreditsAdapterConfig, "operationCosts"> {
  /**
   * Operation cost lookup table, or a getter returning one.
   *
   * Pass a getter when costs are loaded dynamically (e.g. from remote
   * config) so each request reads a fresh table instead of a value
   * captured when the wrapper was first created.
   */
  operationCosts: Record<string, number> | (() => Record<string, number>);
  /**
   * Function to generate request IDs
   * Defaults to timestamp-based ID
   */
  generateRequestId?: () => string;
  /**
   * Provider string recorded on usage logs. Defaults to `"gemini"`.
   * Lets multi-provider apps attribute usage to the real provider.
   */
  usageProvider?: string;
  /**
   * Reservation time-to-live in milliseconds. When omitted, the core
   * helper's default (5 minutes) is used.
   */
  reservationExpiryMs?: number;
  /** Override the default English error messages. */
  errorMessages?: WithCreditsErrorMessages;
  /**
   * Invoked after a reservation is successfully committed — use for side
   * effects such as low-balance notifications. Thrown errors are swallowed
   * so a post-commit side effect can never turn a committed action into a
   * failure.
   */
  afterCommit?: (ctx: AfterCommitContext) => void | Promise<void>;
  /**
   * Invoked when the wrapped handler throws, after the reservation has been
   * released and usage logged. Replaces the default `console.error` so
   * consumers can route the failure to their own logger.
   */
  onError?: (ctx: ActionErrorContext) => void;
}

/**
 * Generate a simple request ID
 */
function defaultGenerateRequestId(): string {
  const timestamp = Date.now();
  const randomPart = Math.random().toString(36).substring(2, 14);
  return `req_${timestamp}_${randomPart}`;
}

/**
 * Create a withCredits higher-order function
 *
 * This factory creates a withCredits function configured for your application.
 * Use this when you want full control over the configuration.
 *
 * @param config - Configuration for the adapter
 * @returns A withCredits HOF
 */
export function createWithCredits(config: WithCreditsConfig) {
  const {
    repository,
    authProvider,
    deferred,
    operationCosts,
    generateRequestId = defaultGenerateRequestId,
    usageProvider = "gemini",
    reservationExpiryMs,
    errorMessages,
    afterCommit,
    onError,
  } = config;

  const resolveOperationCosts =
    typeof operationCosts === "function" ? operationCosts : () => operationCosts;

  function getOperationCost(operationType: string): number {
    return resolveOperationCosts()[operationType] ?? 0;
  }

  function logUsage(params: {
    userId: string;
    operationType: string;
    creditsUsed: number;
    success: boolean;
    errorMessage?: string;
    resourceId?: string;
    resourceType?: string;
    requestId: string;
  }): void {
    deferred.defer(async () => {
      await repository.logUsage({
        userId: params.userId,
        operationType: params.operationType,
        // Core's AIProviderType is currently the literal "gemini"; the cast lets
        // multi-provider consumers record any provider until core widens the type.
        provider: usageProvider as AIProviderType,
        creditsUsed: params.creditsUsed,
        success: params.success,
        errorMessage: params.errorMessage,
        resourceId: params.resourceId,
        resourceType: params.resourceType,
        requestId: params.requestId,
      });
    });
  }

  /**
   * Higher-order function that wraps a server action with credit handling
   *
   * Flow:
   * 1. Authenticate user
   * 2. Calculate credit cost
   * 3. Reserve credits (prevents double-spending)
   * 4. Execute action
   * 5. On success: Commit reservation (deduct credits)
   * 6. On failure: Release reservation (refund credits)
   */
  return function withCredits<TInput, TOutput>(
    options: WithCreditsOptions,
    handler: CreditActionHandler<TInput, TOutput>
  ): (data: TInput) => Promise<ActionResult<TOutput>> {
    return async (data: TInput): Promise<ActionResult<TOutput>> => {
      const requestId = generateRequestId();

      // Authenticate
      const user = await authProvider.getCurrentUser();
      if (!user?.id) {
        return {
          success: false,
          error: errorMessages?.unauthorized ?? "Authentication required",
        };
      }

      // Handle preview mode - skip credit handling entirely
      if (isPreviewMode(data)) {
        const dummyReservation = createDummyReservation(user.id, options.operationType);
        return handler(user, data, dummyReservation);
      }

      // Calculate cost
      const cost = options.customCost ?? getOperationCost(options.operationType);

      // Reserve credits
      let reservation: PortableReservation;
      try {
        reservation = await reserveCreditsForOperation(
          repository,
          user.id,
          cost,
          options.operationType,
          reservationExpiryMs
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : errorMessages?.reserveFailed ?? "Failed to reserve credits";
        logUsage({
          userId: user.id,
          operationType: options.operationType,
          creditsUsed: 0,
          success: false,
          errorMessage: message,
          resourceId: options.resourceId,
          resourceType: options.resourceType,
          requestId,
        });
        return { success: false, error: message };
      }

      // Execute action
      try {
        const result = await handler(user, data, reservation);

        if (result.success) {
          await commitReservationWithJournal(repository, user.id, reservation.id);
          logUsage({
            userId: user.id,
            operationType: options.operationType,
            creditsUsed: cost,
            success: true,
            resourceId: options.resourceId,
            resourceType: options.resourceType,
            requestId,
          });
          if (afterCommit) {
            try {
              await afterCommit({
                userId: user.id,
                operationType: options.operationType,
                cost,
                reservationId: reservation.id,
                requestId,
              });
            } catch {
              // A post-commit side effect must never fail a committed action.
            }
          }
        } else {
          await releaseReservationWithJournal(repository, user.id, reservation.id);
          logUsage({
            userId: user.id,
            operationType: options.operationType,
            creditsUsed: 0,
            success: false,
            errorMessage: result.error,
            resourceId: options.resourceId,
            resourceType: options.resourceType,
            requestId,
          });
        }

        return result;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : errorMessages?.unexpected ?? "An unexpected error occurred";
        await releaseReservationWithJournal(repository, user.id, reservation.id);
        logUsage({
          userId: user.id,
          operationType: options.operationType,
          creditsUsed: 0,
          success: false,
          errorMessage: message,
          resourceId: options.resourceId,
          resourceType: options.resourceType,
          requestId,
        });
        if (onError) {
          onError({
            userId: user.id,
            operationType: options.operationType,
            error,
            requestId,
          });
        } else {
          console.error("Action error:", error);
        }
        return { success: false, error: message };
      }
    };
  };
}

/**
 * Create a credits wrapper factory for creating operation-specific wrappers
 *
 * @param config - Base configuration for all wrappers
 * @returns A factory function for creating operation-specific wrappers
 */
export function createCreditsWrapperFactory(config: WithCreditsConfig) {
  const withCredits = createWithCredits(config);

  return function createCreditsWrapper(
    defaultOptions: Partial<WithCreditsOptions>
  ) {
    return function <TInput, TOutput>(
      handler: CreditActionHandler<TInput, TOutput>,
      additionalOptions?: Partial<WithCreditsOptions>
    ): (data: TInput) => Promise<ActionResult<TOutput>> {
      const mergedOptions = {
        ...defaultOptions,
        ...additionalOptions,
      } as WithCreditsOptions;

      return withCredits(mergedOptions, handler);
    };
  };
}
