import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getConfigOperationCost,
  getOperationCostsWithLabels,
  initializeConfig,
  isValidOperationType,
  resetConfig,
} from "../../src";

const ENV_WITH_ZERO = JSON.stringify({ audio_generation: 10, name_pronunciation_preview: 0 });

describe("operationCosts schema", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetConfig();
  });

  it("accepts a cost of 0 and keeps it distinct from an unset cost", () => {
    initializeConfig({ operationCosts: { free_op: 0 } });

    expect(getConfigOperationCost("free_op")).toBe(0);
    expect(isValidOperationType("free_op")).toBe(true);
    expect(getOperationCostsWithLabels().free_op.cost).toBe(0);
    expect(() => getConfigOperationCost("never_configured")).toThrow("Unknown operation type");
  });

  it.each([-1, -0.01])("still rejects a negative cost (%d)", (cost) => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => initializeConfig({ operationCosts: { bad_op: cost } })).toThrow(
      "Invalid credit system configuration"
    );
  });

  it.each([0.5, 2.5, 1.005])("leaves non-integer behaviour unchanged (%d)", (cost) => {
    initializeConfig({ operationCosts: { fractional_op: cost } });

    expect(getConfigOperationCost("fractional_op")).toBe(cost);
  });
});

describe("importing the package with CREDITS_OPERATION_COSTS set", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // Each entry point bundles its own copy of the config module and validates on
  // import, so `adapters` could throw even where the root entry does not.
  it.each(["../../src", "../../src/adapters"])("%s does not throw on a 0 entry", async (entry) => {
    vi.stubEnv("CREDITS_OPERATION_COSTS", ENV_WITH_ZERO);
    vi.resetModules();

    await expect(import(entry)).resolves.toBeDefined();
  });

  it("exposes the 0 entry from the env var", async () => {
    vi.stubEnv("CREDITS_OPERATION_COSTS", ENV_WITH_ZERO);
    vi.resetModules();

    const credits = await import("../../src");

    expect(credits.getOperationCost("name_pronunciation_preview")).toBe(0);
    expect(credits.getOperationCost("audio_generation")).toBe(10);
  });

  it("ignores the variable on a negative entry, rather than failing the import", async () => {
    vi.stubEnv("CREDITS_OPERATION_COSTS", JSON.stringify({ bad_op: -1 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();

    const credits = await import("../../src");

    expect(credits.isValidOperationType("bad_op")).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
