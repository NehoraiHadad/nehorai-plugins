/**
 * SDK error classes
 *
 * Provides typed error handling for SDK operations.
 */

import { SDKErrorCode, type SDKErrorCodeType } from "./types.js";

/**
 * Base error class for SDK errors
 */
export class CreditsSDKError extends Error {
  public readonly code: SDKErrorCodeType;
  public readonly details?: Record<string, unknown>;
  public readonly statusCode?: number;

  constructor(
    message: string,
    code: SDKErrorCodeType,
    options?: {
      details?: Record<string, unknown>;
      statusCode?: number;
      cause?: Error;
    }
  ) {
    super(message, { cause: options?.cause });
    this.name = "CreditsSDKError";
    this.code = code;
    this.details = options?.details;
    this.statusCode = options?.statusCode;
  }

  /**
   * Check if this is a specific error type
   */
  is(code: SDKErrorCodeType): boolean {
    return this.code === code;
  }

  /**
   * Create a JSON representation for logging
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      details: this.details,
      statusCode: this.statusCode,
    };
  }
}

/**
 * Error thrown when a network request fails
 */
export class NetworkError extends CreditsSDKError {
  constructor(message: string, cause?: Error) {
    super(message, SDKErrorCode.NETWORK_ERROR, { cause });
    this.name = "NetworkError";
  }
}

/**
 * Error thrown when authentication fails
 */
export class AuthenticationError extends CreditsSDKError {
  constructor(message: string = "Authentication required") {
    super(message, SDKErrorCode.AUTHENTICATION_ERROR, { statusCode: 401 });
    this.name = "AuthenticationError";
  }
}

/**
 * Error thrown when authorization fails
 */
export class AuthorizationError extends CreditsSDKError {
  constructor(message: string = "Access denied") {
    super(message, SDKErrorCode.AUTHORIZATION_ERROR, { statusCode: 403 });
    this.name = "AuthorizationError";
  }
}

/**
 * Error thrown when credits are insufficient
 */
export class InsufficientCreditsError extends CreditsSDKError {
  public readonly available: number;
  public readonly required: number;

  constructor(available: number, required: number) {
    super(
      `Insufficient credits: available ${available}, required ${required}`,
      SDKErrorCode.INSUFFICIENT_CREDITS,
      {
        statusCode: 402,
        details: { available, required },
      }
    );
    this.name = "InsufficientCreditsError";
    this.available = available;
    this.required = required;
  }
}

/**
 * Error thrown when a reservation is not found
 */
export class ReservationNotFoundError extends CreditsSDKError {
  public readonly reservationId: string;

  constructor(reservationId: string) {
    super(
      `Reservation not found: ${reservationId}`,
      SDKErrorCode.RESERVATION_NOT_FOUND,
      {
        statusCode: 404,
        details: { reservationId },
      }
    );
    this.name = "ReservationNotFoundError";
    this.reservationId = reservationId;
  }
}

/**
 * Error thrown when a reservation has expired
 */
export class ReservationExpiredError extends CreditsSDKError {
  public readonly reservationId: string;

  constructor(reservationId: string) {
    super(
      `Reservation expired: ${reservationId}`,
      SDKErrorCode.RESERVATION_EXPIRED,
      {
        statusCode: 410,
        details: { reservationId },
      }
    );
    this.name = "ReservationExpiredError";
    this.reservationId = reservationId;
  }
}

/**
 * Error thrown for validation failures
 */
export class ValidationError extends CreditsSDKError {
  public readonly field?: string;

  constructor(message: string, field?: string) {
    super(message, SDKErrorCode.VALIDATION_ERROR, {
      statusCode: 400,
      details: field ? { field } : undefined,
    });
    this.name = "ValidationError";
    this.field = field;
  }
}

/**
 * Error thrown for server errors
 */
export class ServerError extends CreditsSDKError {
  constructor(message: string = "Internal server error") {
    super(message, SDKErrorCode.SERVER_ERROR, { statusCode: 500 });
    this.name = "ServerError";
  }
}

/**
 * Parse an API error response into the appropriate SDK error
 */
export function parseApiError(
  statusCode: number,
  body: { error?: { code?: string; message?: string; details?: unknown } }
): CreditsSDKError {
  const errorCode = body.error?.code || "";
  const errorMessage = body.error?.message || "An error occurred";
  const details = body.error?.details as Record<string, unknown> | undefined;

  switch (statusCode) {
    case 401:
      return new AuthenticationError(errorMessage);
    case 403:
      return new AuthorizationError(errorMessage);
    case 402:
      // Parse insufficient credits details
      if (details?.available !== undefined && details?.required !== undefined) {
        return new InsufficientCreditsError(
          details.available as number,
          details.required as number
        );
      }
      return new CreditsSDKError(errorMessage, SDKErrorCode.INSUFFICIENT_CREDITS, {
        statusCode,
        details,
      });
    case 404:
      if (errorCode === "RESERVATION_NOT_FOUND" && details?.reservationId) {
        return new ReservationNotFoundError(details.reservationId as string);
      }
      return new CreditsSDKError(errorMessage, SDKErrorCode.RESERVATION_NOT_FOUND, {
        statusCode,
        details,
      });
    case 410:
      if (errorCode === "RESERVATION_EXPIRED" && details?.reservationId) {
        return new ReservationExpiredError(details.reservationId as string);
      }
      return new CreditsSDKError(errorMessage, SDKErrorCode.RESERVATION_EXPIRED, {
        statusCode,
        details,
      });
    case 400:
    case 422:
      return new ValidationError(errorMessage, details?.field as string | undefined);
    case 500:
    default:
      if (statusCode >= 500) {
        return new ServerError(errorMessage);
      }
      return new CreditsSDKError(errorMessage, SDKErrorCode.UNKNOWN_ERROR, {
        statusCode,
        details,
      });
  }
}
