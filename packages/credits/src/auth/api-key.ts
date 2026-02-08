import type { ICreditsAuthProvider, CreditsUser } from "./types.js";

/**
 * Timing-safe string comparison to prevent timing attacks
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b) {
    return false;
  }

  // Pad strings to same length to prevent length-based timing attacks
  const maxLength = Math.max(a.length, b.length);
  const paddedA = a.padEnd(maxLength);
  const paddedB = b.padEnd(maxLength);

  let result = 0;
  for (let i = 0; i < maxLength; i++) {
    result |= paddedA.charCodeAt(i) ^ paddedB.charCodeAt(i);
  }

  // Also check that lengths were originally equal
  return result === 0 && a.length === b.length;
}

/**
 * Verify a Bearer token from an Authorization header
 *
 * @param header - The Authorization header value (e.g., "Bearer secret123")
 * @param secret - The expected secret value
 * @returns True if token is valid
 */
export function verifyBearerToken(header: string | null, secret: string): boolean {
  if (!header || !secret) {
    return false;
  }

  // Extract token from "Bearer {token}" format
  const token = header.replace(/^Bearer\s+/i, "");

  // Use timing-safe comparison
  return timingSafeEqual(token, secret);
}

/**
 * API Key auth provider for admin routes
 *
 * Uses Bearer token authentication for external API access
 * The API key is stored in CREDITS_ADMIN_API_KEY environment variable
 */
export class ApiKeyCreditsProvider implements ICreditsAuthProvider {
  private readonly apiKey: string | undefined;
  private isValidated = false;

  constructor(authHeader?: string | null, apiKey?: string) {
    this.apiKey = apiKey ?? process.env.CREDITS_ADMIN_API_KEY;

    // Validate the provided auth header using timing-safe comparison
    if (authHeader && this.apiKey) {
      this.isValidated = verifyBearerToken(authHeader, this.apiKey);
    }
  }

  async getCurrentUser(): Promise<CreditsUser | null> {
    if (!this.isValidated) {
      return null;
    }

    // API key auth returns a special "admin" user
    return {
      id: "api-admin",
      email: "api@admin.internal",
      name: "API Admin",
    };
  }

  async verifyAdminAccess(): Promise<boolean> {
    return this.isValidated;
  }
}

/**
 * Verify an API key from a request header
 * @param authHeader - Authorization header value
 * @param apiKey - Optional API key to use (defaults to CREDITS_ADMIN_API_KEY env var)
 * @returns True if API key is valid
 */
export function verifyAdminApiKey(authHeader: string | null, apiKey?: string): boolean {
  if (!authHeader) {
    return false;
  }

  const expectedKey = apiKey ?? process.env.CREDITS_ADMIN_API_KEY;
  if (!expectedKey) {
    console.warn("CREDITS_ADMIN_API_KEY not configured");
    return false;
  }

  // Use timing-safe comparison to prevent timing attacks
  return verifyBearerToken(authHeader, expectedKey);
}

/**
 * Create an API key auth provider from a request
 * @param request - Request object with headers
 * @param apiKey - Optional API key to use
 * @returns API key auth provider
 */
export function createApiKeyProvider(request: Request, apiKey?: string): ApiKeyCreditsProvider {
  const authHeader = request.headers.get("Authorization");
  return new ApiKeyCreditsProvider(authHeader, apiKey);
}
