import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigFromEnv } from "../../src";

describe("CREDITS_OPERATION_COSTS", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function load(value: string) {
    vi.stubEnv("CREDITS_OPERATION_COSTS", value);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    return { costs: loadConfigFromEnv().operationCosts, warn };
  }

  it.each([
    ["a negative cost", '{"good":5,"conversation":-1}'],
    ["a cost off the cent grid", '{"good":5,"conversation":1.005}'],
    ["a cost above the ledger maximum", '{"good":5,"conversation":10000000000}'],
    ["a string cost", '{"good":5,"conversation":"5"}'],
    ["a null cost", '{"good":5,"conversation":null}'],
    ["a nested cost", '{"good":5,"conversation":{"cost":5}}'],
    ["an array", "[1,2]"],
    ["an empty array", "[]"],
    ["a number", "5"],
    ["a string", '"5"'],
    ["null", "null"],
  ])("ignores the whole variable and warns on %s", (_name, value) => {
    const { costs, warn } = load(value);

    expect(costs).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("CREDITS_OPERATION_COSTS");
  });

  it("keeps the warning for JSON that does not parse", () => {
    const { costs, warn } = load("{not json");

    expect(costs).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("Failed to parse");
  });

  it.each([0, 0.01, 1.5, 9_999_999_999.99])("accepts a cost of %d without a warning", (cost) => {
    const { costs, warn } = load(JSON.stringify({ conversation: cost }));

    expect(costs?.conversation).toBe(cost);
    expect(warn).not.toHaveBeenCalled();
  });

  it("merges a valid map over the defaults", () => {
    const { costs, warn } = load('{"audio_generation":10}');

    expect(costs?.audio_generation).toBe(10);
    expect(Object.keys(costs ?? {}).length).toBeGreaterThan(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps the default prices when an off-grid price is set at import", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    const clean = await import("../../src");
    const defaults = clean.getConfig().operationCosts;

    vi.stubEnv("CREDITS_OPERATION_COSTS", JSON.stringify({ conversation: 1.005 }));
    vi.resetModules();
    const credits = await import("../../src");

    expect(credits.getConfig().operationCosts).toEqual(defaults);
    expect(warn).toHaveBeenCalled();
  });
});
