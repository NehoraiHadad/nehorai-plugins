import type { CreditSystemConfig } from "./index.js";

/** Interface for external config providers (e.g. Firestore-backed) */
export interface ICreditConfigProvider {
  getConfig(): CreditSystemConfig;
}

let configProvider: ICreditConfigProvider | null = null;

/** Register an external config provider. Called once at app startup. */
export function registerConfigProvider(provider: ICreditConfigProvider): void {
  configProvider = provider;
}

/** Get the registered provider, or null if none registered. */
export function getConfigProvider(): ICreditConfigProvider | null {
  return configProvider;
}

/** Clear registered provider (for testing). */
export function clearConfigProvider(): void {
  configProvider = null;
}
