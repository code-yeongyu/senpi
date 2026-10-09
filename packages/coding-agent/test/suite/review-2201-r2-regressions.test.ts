import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { FallbackCircuitBreaker, fallbackCircuitsFor, monotonicNow } from "../../src/core/retry-fallback/circuit.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const primary = "faux/faux-1";
const fallback = "faux/faux-2";
const settings = {
	retry: {
		enabled: true,
		maxRetries: 0,
		baseDelayMs: 0,
		fallbackChains: { [primary]: [fallback] },
	},
};

afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
	vi.restoreAllMocks();
});

it("retains live agent-directory sharing when another directory is created before the first failure", async () => {
	const first = await createHarness({
		models: [{ id: "faux-1" }, { id: "faux-2" }],
		fallbackNow: () => 0,
		settings,
	});
	harnesses.push(first);
	fallbackCircuitsFor(join(first.tempDir, "unrelated-agent"));
	first.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 503: overloaded" }),
		fauxAssistantMessage("fallback"),
		fauxAssistantMessage("sibling"),
	]);
	await first.session.prompt("open the primary after another agent directory was initialized");
	const sibling = await createHarness({ siblingOf: first, fallbackNow: () => 0, settings });
	harnesses.push(sibling);
	await sibling.session.prompt("the primary must still be shared and open");
	expect(first.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2", "faux-2"]);
});

it("does not let a released old token release a later probe by the same owner", () => {
	const breaker = new FallbackCircuitBreaker();
	breaker.open(primary, { now: 0, cooldownMs: 1000, maxCooldownMs: 3000 });
	const first = breaker.admit(primary, 1000, "same-session");
	if (first.kind !== "probe") throw new Error("expected first probe");
	breaker.release(first.token);
	const replacement = breaker.admit(primary, 1000, "same-session");
	expect(replacement.kind).toBe("probe");
	breaker.release(first.token);
	expect(breaker.admit(primary, 1000, "other-session").kind).toBe("open");
});

it("preserves the Retry-After floor across a hintless failure", () => {
	const breaker = new FallbackCircuitBreaker();
	const window = { cooldownMs: 60_000, maxCooldownMs: 1_800_000 };
	expect(breaker.open(primary, { now: 0, ...window, retryAfterMs: 600_000 })).toBe(600_000);
	expect(breaker.open(primary, { now: 1000, ...window })).toBe(600_000);
});

it("sweeps expired idle selectors but keeps cooldowns and live probes", () => {
	const breaker = new FallbackCircuitBreaker();
	const window = { cooldownMs: 1000, maxCooldownMs: 3000 };
	breaker.open(primary, { now: 0, ...window });
	breaker.open(fallback, { now: 0, ...window });
	breaker.admit(fallback, 1000, "owner");
	breaker.open("faux/cooling", { now: 0, cooldownMs: 1000, maxCooldownMs: 30_000, retryAfterMs: 10_000 });
	breaker.sweep(4000);
	expect(breaker.size).toBe(2);
	expect(breaker.isOpen(fallback, 4000, "sibling")).toBe(true);
	expect(breaker.isOpen("faux/cooling", 4000, "sibling")).toBe(true);
});

it("does not advance the default circuit clock after a wall-clock jump", () => {
	const before = monotonicNow();
	const breaker = new FallbackCircuitBreaker();
	breaker.open(primary, { now: before, cooldownMs: 60_000, maxCooldownMs: 1_800_000 });
	vi.spyOn(Date, "now").mockReturnValue(before + 86_400_000);
	expect(breaker.isOpen(primary, monotonicNow(), "other")).toBe(true);
});
