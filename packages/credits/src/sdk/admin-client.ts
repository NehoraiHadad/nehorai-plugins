/**
 * AdminCreditsClient - Admin REST API client for the credits system
 *
 * Provides administrative access to the credits system for managing
 * user credits, configurations, and subscriptions.
 *
 * @example
 * ```typescript
 * const adminClient = new AdminCreditsClient({
 *   baseUrl: process.env.CREDITS_API_URL,
 *   apiKey: process.env.CREDITS_ADMIN_API_KEY,
 * });
 *
 * // Add credits to a user
 * await adminClient.addCredits("user-123", 100, "Support credit grant");
 *
 * // Update subscription tier
 * await adminClient.updateSubscription("user-123", "premium", "2027-01-01T00:00:00Z");
 *
 * // Update operation costs
 * await adminClient.updateCosts({
 *   story_generation: 8,
 *   image_generation: 12,
 * });
 * ```
 */

import type { AdminCreditsClientConfig, UserCredits } from "./types.js";
import { parseApiError, NetworkError } from "./errors.js";

/**
 * Credits configuration returned by the API
 */
export interface CreditsConfig {
  operationCosts: Record<string, number>;
  tierConfigs: Record<
    string,
    {
      monthlyLimit: number;
      features: string[];
    }
  >;
}

/**
 * Response from listing users
 */
export interface ListUsersResponse {
  users: Array<{
    userId: string;
    balance: number;
    bonusCredits?: number;
    tier: string;
    monthlyUsed?: number;
  }>;
  hasMore: boolean;
  total?: number;
}

/**
 * Options for listing users
 */
export interface ListUsersOptions {
  page?: number;
  limit?: number;
  tier?: string;
  search?: string;
}

export class AdminCreditsClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: AdminCreditsClientConfig) {
    // Ensure baseUrl doesn't have trailing slash
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.fetchFn = config.fetch ?? fetch;
  }

  /**
   * Make an authenticated admin request to the API
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

    // Build headers with admin API key
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
    };

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
   * Get a specific user's credits
   *
   * @param userId - ID of the user
   * @returns User's credit information
   * @throws AuthorizationError if API key is invalid
   */
  async getUserCredits(userId: string): Promise<UserCredits> {
    return this.request<UserCredits>(`/api/admin/credits/users/${userId}`);
  }

  /**
   * Add credits to a user's account
   *
   * Credits are added to bonusCredits, which don't expire on monthly reset.
   *
   * @param userId - ID of the user
   * @param amount - Amount of credits to add
   * @param description - Reason for adding credits
   * @throws AuthorizationError if API key is invalid
   */
  async addCredits(
    userId: string,
    amount: number,
    description: string
  ): Promise<void> {
    await this.request<{ message: string; newBalance: number }>(
      `/api/admin/credits/users/${userId}/add`,
      {
        method: "POST",
        body: { amount, description },
      }
    );
  }

  /**
   * Update a user's subscription tier
   *
   * @param userId - ID of the user
   * @param tier - New subscription tier
   * @param expiresAt - Optional expiration date (ISO 8601)
   * @throws AuthorizationError if API key is invalid
   */
  async updateSubscription(
    userId: string,
    tier: string,
    expiresAt?: string
  ): Promise<void> {
    const body: { tier: string; expiresAt?: string } = { tier };
    if (expiresAt) {
      body.expiresAt = expiresAt;
    }

    await this.request<{ message: string }>(
      `/api/admin/credits/users/${userId}/subscription`,
      {
        method: "PUT",
        body,
      }
    );
  }

  /**
   * Get the current credits configuration
   *
   * @returns Credits system configuration
   * @throws AuthorizationError if API key is invalid
   */
  async getConfig(): Promise<CreditsConfig> {
    return this.request<CreditsConfig>("/api/admin/credits/config");
  }

  /**
   * Update operation costs
   *
   * @param costs - New operation costs (operation type -> cost)
   * @throws AuthorizationError if API key is invalid
   */
  async updateCosts(costs: Record<string, number>): Promise<void> {
    await this.request<{ message: string }>("/api/admin/credits/config/costs", {
      method: "PUT",
      body: { operationCosts: costs },
    });
  }

  /**
   * List all users with their credits
   *
   * @param options - Pagination and filtering options
   * @returns Paginated list of users
   * @throws AuthorizationError if API key is invalid
   */
  async listUsers(options?: ListUsersOptions): Promise<ListUsersResponse> {
    return this.request<ListUsersResponse>("/api/admin/credits/users", {
      params: {
        page: options?.page,
        limit: options?.limit,
        tier: options?.tier,
        search: options?.search,
      },
    });
  }

  /**
   * Deduct credits from a user's account
   *
   * @param userId - ID of the user
   * @param amount - Amount of credits to deduct
   * @param description - Reason for deducting credits
   * @throws AuthorizationError if API key is invalid
   */
  async deductCredits(
    userId: string,
    amount: number,
    description: string
  ): Promise<void> {
    await this.request<{ message: string; newBalance: number }>(
      `/api/admin/credits/users/${userId}/deduct`,
      {
        method: "POST",
        body: { amount, description },
      }
    );
  }

  /**
   * Get usage statistics for a user
   *
   * @param userId - ID of the user
   * @param options - Optional date range
   * @returns Usage statistics
   * @throws AuthorizationError if API key is invalid
   */
  async getUserStats(
    userId: string,
    options?: { startDate?: string; endDate?: string }
  ): Promise<{
    totalCreditsUsed: number;
    operationBreakdown: Record<string, number>;
    successRate: number;
  }> {
    return this.request<{
      totalCreditsUsed: number;
      operationBreakdown: Record<string, number>;
      successRate: number;
    }>(`/api/admin/credits/users/${userId}/stats`, {
      params: {
        startDate: options?.startDate,
        endDate: options?.endDate,
      },
    });
  }
}
