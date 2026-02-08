/**
 * Credits auth providers - barrel exports
 *
 * Provides authentication abstraction for credits system
 */

// Types and interfaces
export type {
  ICreditsAuthProvider,
  CreditsAuthProviderFactory,
  CreditsUser,
} from "./types.js";

// API Key implementation (for admin routes)
export {
  ApiKeyCreditsProvider,
  verifyAdminApiKey,
  createApiKeyProvider,
  verifyBearerToken,
} from "./api-key.js";
