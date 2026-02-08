/**
 * Authenticated user information for credits operations
 */
export interface CreditsUser {
  id: string;
  email?: string | null;
  name?: string | null;
}

/**
 * Auth provider interface for credits system
 *
 * Implementations can use any auth system (NextAuth, JWT, API keys, etc.)
 */
export interface ICreditsAuthProvider {
  /**
   * Get the currently authenticated user
   * @returns User information or null if not authenticated
   */
  getCurrentUser(): Promise<CreditsUser | null>;

  /**
   * Verify if a user has admin access for credits management
   * @param userId - User ID to check
   * @returns True if user has admin access
   */
  verifyAdminAccess(userId: string): Promise<boolean>;
}

/**
 * Factory type for creating auth provider instances
 */
export type CreditsAuthProviderFactory = () => ICreditsAuthProvider;
