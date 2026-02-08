/**
 * Generic credits adapter - framework agnostic
 *
 * This adapter uses standard JavaScript APIs and works in any
 * JavaScript environment (Node.js, browser, etc.).
 */

import type { PortableReservation, WithCreditsOptions } from "../core/types.js";
import type { ActionResult, CreditsAdapter, CreditsAdapterConfig, CreditActionHandler } from "./types.js";
import {
  commitReservationWithJournal,
  releaseReservationWithJournal,
  reserveCreditsForOperation,
} from "../core/operations.js";

/**
 * Generate a unique request ID
 */
function generateRequestId(): string {
  const timestamp = Date.now();
  const randomPart = Math.random().toString(36).substring(2, 14);
  return `req_${timestamp}_${randomPart}`;
}

/**
 * Create a generic credits adapter
 *
 * This adapter:
 * - Authenticates users via the provided auth provider
 * - Reserves credits before action execution
 * - Commits credits on success, releases on failure
 * - Logs usage asynchronously via the deferred executor
 */
export function createGenericAdapter(config: CreditsAdapterConfig): CreditsAdapter {
  const { repository, authProvider, deferred, operationCosts } = config;

  function getOperationCost(operationType: string): number {
    return operationCosts[operationType] ?? 0;
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
        provider: "gemini",
        creditsUsed: params.creditsUsed,
        success: params.success,
        errorMessage: params.errorMessage,
        resourceId: params.resourceId,
        resourceType: params.resourceType,
        requestId: params.requestId,
      });
    });
  }

  return {
    withCredits<TInput, TOutput>(
      options: WithCreditsOptions,
      handler: CreditActionHandler<TInput, TOutput>
    ): (data: TInput) => Promise<ActionResult<TOutput>> {
      return async (data: TInput): Promise<ActionResult<TOutput>> => {
        const requestId = generateRequestId();

        // Authenticate
        const user = await authProvider.getCurrentUser();
        if (!user?.id) {
          return { success: false, error: "Authentication required" };
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
            options.operationType
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to reserve credits";
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
          const message = error instanceof Error ? error.message : "An unexpected error occurred";
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
          console.error("Action error:", error);
          return { success: false, error: message };
        }
      };
    },
  };
}

function isPreviewMode(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    "preview" in data &&
    (data as Record<string, unknown>).preview === true
  );
}

function createDummyReservation(userId: string, operationType: string): PortableReservation {
  return {
    id: "preview-mode",
    userId,
    amount: 0,
    operationType,
    status: "released",
    createdAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
  };
}
