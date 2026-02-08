/**
 * CreditsClient - REST API client for the credits system
 *
 * Provides a type-safe interface for consuming credits API endpoints
 * from external services or other applications.
 *
 * @example
 * ```typescript
 * const client = new CreditsClient({
 *   baseUrl: process.env.CREDITS_API_URL,
 *   getAuthToken: async () => session.accessToken,
 * });
 *
 * // Check if user has sufficient credits
 * const check = await client.checkAvailability("story_generation");
 * if (!check.hasCredits) {
 *   console.log("Insufficient credits");
 *   return;
 * }
 *
 * // Two-phase commit pattern
 * const reservation = await client.reserve("story_generation");
 * try {
 *   const result = await doExpensiveWork();
 *   await client.commit(reservation.reservationId);
 *   return result;
 * } catch (error) {
 *   await client.release(reservation.reservationId);
 *   throw error;
 * }
 * ```
 */

import type {
  CreditsClientConfig,
  UserCredits,
  CreditCheckResult,
  ReservationResult,
  UsageHistoryResponse,
  PaginationOptions,
} from "./types.js";
import { parseApiError, NetworkError } from "./errors.js";

export class CreditsClient {
  private readonly baseUrl: string;
  private readonly getAuthToken?: () => Promise<string>;
  private readonly fetchFn: typeof fetch;

  constructor(config: CreditsClientConfig) {
    // Ensure baseUrl doesn't have trailing slash
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.getAuthToken = config.getAuthToken;
    this.fetchFn = config.fetch ?? fetch;
  }

  /**
   * Make an authenticated request to the API
   */
  private async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "DELETE";
      body?: unknown;
      params?: Record<string, string | number | undefined>;
    } = {}
  ): Promise<T> {
    const { method = "GET", body, params } = options;

    // Build URL with query params
    let url = `${this.baseUrl}${path}`;
    if (params) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          searchParams.set(key, String(value));
        }
      }
      const queryString = searchParams.toString();
      if (queryString) {
        url += `?${queryString}`;
      }
    }

    // Build headers
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Add auth token if available
    if (this.getAuthToken) {
      try {
        const token = await this.getAuthToken();
        if (token) {
          headers["Authorization"] = `Bearer ${token}`;
        }
      } catch {
        // Auth token not available, proceed without it
      }
    }

    // Make the request
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new NetworkError(
        error instanceof Error ? error.message : "Network request failed",
        error instanceof Error ? error : undefined
      );
    }

    // Parse response
    const responseBody = (await response.json()) as {
      data?: T;
      error?: { code?: string; message?: string; details?: unknown };
    };

    // Handle errors
    if (!response.ok) {
      throw parseApiError(response.status, responseBody);
    }

    // Return data
    return responseBody.data as T;
  }

  /**
   * Get the current user's credit balance
   *
   * @returns User's credit information
   * @throws AuthenticationError if not authenticated
   */
  async getBalance(): Promise<UserCredits> {
    return this.request<UserCredits>("/api/v1/credits/balance");
  }

  /**
   * Check if the user has sufficient credits for an operation
   *
   * @param operationType - Type of operation to check
   * @param customCost - Optional custom cost to check against
   * @returns Credit availability status
   * @throws AuthenticationError if not authenticated
   */
  async checkAvailability(
    operationType: string,
    customCost?: number
  ): Promise<CreditCheckResult> {
    return this.request<CreditCheckResult>("/api/v1/credits/availability", {
      params: {
        operationType,
        customCost: customCost?.toString(),
      },
    });
  }

  /**
   * Reserve credits for an operation
   *
   * This is the first step in the two-phase commit pattern.
   * Reserved credits are held for 5 minutes before expiring.
   *
   * @param operationType - Type of operation
   * @param options - Optional reservation options
   * @returns Reservation details including ID and expiry
   * @throws InsufficientCreditsError if not enough credits
   * @throws AuthenticationError if not authenticated
   */
  async reserve(
    operationType: string,
    options?: {
      customCost?: number;
      resourceId?: string;
      resourceType?: string;
    }
  ): Promise<ReservationResult> {
    return this.request<ReservationResult>("/api/v1/credits/reserve", {
      method: "POST",
      body: {
        operationType,
        ...options,
      },
    });
  }

  /**
   * Commit a reservation (deduct credits)
   *
   * This is the second step in the two-phase commit pattern.
   * Call this after your operation succeeds.
   *
   * @param reservationId - ID of the reservation to commit
   * @throws ReservationNotFoundError if reservation doesn't exist
   * @throws ReservationExpiredError if reservation has expired
   * @throws AuthenticationError if not authenticated
   */
  async commit(reservationId: string): Promise<void> {
    await this.request<{ message: string }>("/api/v1/credits/commit", {
      method: "POST",
      body: { reservationId },
    });
  }

  /**
   * Release a reservation (refund credits)
   *
   * Call this if your operation fails after reserving credits.
   *
   * @param reservationId - ID of the reservation to release
   * @throws ReservationNotFoundError if reservation doesn't exist
   * @throws AuthenticationError if not authenticated
   */
  async release(reservationId: string): Promise<void> {
    await this.request<{ message: string }>("/api/v1/credits/release", {
      method: "POST",
      body: { reservationId },
    });
  }

  /**
   * Get usage history for the current user
   *
   * @param options - Optional pagination options
   * @returns Paginated list of usage entries
   * @throws AuthenticationError if not authenticated
   */
  async getHistory(options?: PaginationOptions): Promise<UsageHistoryResponse> {
    return this.request<UsageHistoryResponse>("/api/v1/credits/history", {
      params: {
        page: options?.page,
        limit: options?.limit,
      },
    });
  }

  /**
   * Get the available credits (balance + bonus - reserved)
   *
   * Convenience method that calculates available credits from balance.
   *
   * @returns Number of available credits
   * @throws AuthenticationError if not authenticated
   */
  async getAvailableCredits(): Promise<number> {
    const balance = await this.getBalance();
    return balance.balance + balance.bonusCredits - balance.reserved;
  }

  /**
   * Execute an operation with automatic credit handling
   *
   * This is a convenience method that handles the full two-phase commit
   * pattern automatically.
   *
   * @param operationType - Type of operation
   * @param operation - The operation to execute
   * @param options - Optional reservation options
   * @returns Result of the operation
   * @throws InsufficientCreditsError if not enough credits
   * @throws AuthenticationError if not authenticated
   *
   * @example
   * ```typescript
   * const result = await client.withCredits(
   *   "story_generation",
   *   async () => {
   *     return generateStory(data);
   *   }
   * );
   * ```
   */
  async withCredits<T>(
    operationType: string,
    operation: () => Promise<T>,
    options?: {
      customCost?: number;
      resourceId?: string;
      resourceType?: string;
    }
  ): Promise<T> {
    const reservation = await this.reserve(operationType, options);

    try {
      const result = await operation();
      await this.commit(reservation.reservationId);
      return result;
    } catch (error) {
      // Always attempt to release on failure
      try {
        await this.release(reservation.reservationId);
      } catch {
        // Ignore release errors, original error is more important
      }
      throw error;
    }
  }
}
