import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	acquireFallbackCircuits,
	createFallbackCircuitAccess,
	DEFAULT_CIRCUIT_COOLDOWN_MS,
	DEFAULT_CIRCUIT_MAX_COOLDOWN_MS,
	FallbackCircuitBreaker,
	fallbackCircuitsFor,
	resolveFallbackCircuitSettings,
} from "../../src/core/retry-fallback/circuit.ts";
import type { FallbackLogger } from "../../src/core/retry-fallback/log.ts";

const head = "provider-a/model-x";
const silentLogger: FallbackLogger = { debug() {}, info() {}, warn() {} };
const window = { cooldownMs: 1_000, maxCooldownMs: 3_000 };

describe("FallbackCircuitBreaker", () => {
	it("doubles the cooldown on each consecutive open up to the ceiling", () => {
		const breaker = new FallbackCircuitBreaker();

		expect(breaker.open(head, { now: 0, ...window })).toBe(1_000);
		expect(breaker.open(head, { now: 0, ...window })).toBe(2_000);
		expect(breaker.open(head, { now: 0, ...window })).toBe(3_000);
		expect(breaker.open(head, { now: 0, ...window })).toBe(3_000);
	});

	it("resets the escalation when the circuit closes", () => {
		const breaker = new FallbackCircuitBreaker();
		breaker.open(head, { now: 0, ...window });
		breaker.open(head, { now: 0, ...window });

		breaker.close(head);

		expect(breaker.isOpen(head, 0, "a")).toBe(false);
		expect(breaker.open(head, { now: 0, ...window })).toBe(1_000);
	});

	it("keeps the circuit open until a provider Retry-After longer than the cooldown", () => {
		const breaker = new FallbackCircuitBreaker();
		const ceiling = { cooldownMs: 1_000, maxCooldownMs: 1_800_000 };

		expect(breaker.open(head, { now: 100, ...ceiling, retryAfterMs: 600_000 })).toBe(600_100);
		expect(breaker.isOpen(head, 600_099, "a")).toBe(true);
		expect(breaker.isOpen(head, 600_100, "a")).toBe(false);
	});

	it("keeps an outstanding Retry-After deadline when a later failure carries no hint", () => {
		const breaker = new FallbackCircuitBreaker();
		const ceiling = { cooldownMs: 1_000, maxCooldownMs: 1_800_000 };

		expect(breaker.open(head, { now: 0, ...ceiling, retryAfterMs: 600_000 })).toBe(600_000);
		expect(breaker.open(head, { now: 1_000, ...ceiling })).toBe(600_000);
		expect(breaker.isOpen(head, 599_999, "a")).toBe(true);
	});

	it("bounds a Retry-After longer than the ceiling so one half-open probe is admitted at the ceiling", () => {
		const breaker = new FallbackCircuitBreaker();

		expect(breaker.open(head, { now: 100, ...window, retryAfterMs: 600_000 })).toBe(3_100);
		expect(breaker.admit(head, 3_099, "a")).toEqual({ kind: "open" });
		expect(breaker.admit(head, 3_100, "a").kind).toBe("probe");
		expect(breaker.admit(head, 3_100, "b")).toEqual({ kind: "open" });
	});

	it("admits exactly one probe owner and keeps it exclusive until it settles", () => {
		const breaker = new FallbackCircuitBreaker();
		breaker.open(head, { now: 0, ...window });
		expect(breaker.admit(head, 999, "a")).toEqual({ kind: "open" });

		const first = breaker.admit(head, 1_000, "a");
		expect(first.kind).toBe("probe");
		expect(breaker.admit(head, 1_000, "b")).toEqual({ kind: "open" });
		expect(breaker.admit(head, 1_000_000, "b")).toEqual({ kind: "open" });
		expect(breaker.admit(head, 1_000_000, "a")).toEqual(first);
	});

	it("releases a probe only for the token that holds it", () => {
		const breaker = new FallbackCircuitBreaker();
		breaker.open(head, { now: 0, ...window });
		const first = breaker.admit(head, 1_000, "a");
		if (first.kind !== "probe") throw new Error("expected a probe");

		breaker.release({ ...first.token, owner: "b" });
		expect(breaker.isOpen(head, 1_000, "b")).toBe(true);
		breaker.open(head, { now: 1_000, ...window });
		breaker.release(first.token);
		expect(breaker.admit(head, 3_000, "b").kind).toBe("probe");
		breaker.releaseOwnersWithPrefix("b");
		expect(breaker.admit(head, 3_000, "c").kind).toBe("probe");
	});

	it("sweeps only circuits idle for a full ceiling window after they half-opened", () => {
		const breaker = new FallbackCircuitBreaker();
		breaker.open(head, { now: 0, ...window });
		breaker.open("provider-b/model-y", { now: 0, ...window });
		breaker.admit("provider-b/model-y", 1_000, "a");

		breaker.sweep(3_999);
		expect(breaker.size).toBe(2);
		breaker.sweep(4_000);
		expect(breaker.size).toBe(1);
		expect(breaker.isOpen("provider-b/model-y", 4_000, "b")).toBe(true);
	});

	it("keeps a held breaker's identity while other agent directories come and go", () => {
		const agentDir = join(tmpdir(), "circuit-breaker-held");
		const lease = acquireFallbackCircuits(agentDir);

		fallbackCircuitsFor(`${agentDir}-unrelated`);
		expect(fallbackCircuitsFor(agentDir)).toBe(lease.breaker);

		lease.release();
		lease.release();
		fallbackCircuitsFor(`${agentDir}-another`);
		expect(fallbackCircuitsFor(agentDir)).not.toBe(lease.breaker);
	});

	it("keeps an unheld breaker that still has circuits to share", () => {
		const agentDir = join(tmpdir(), "circuit-breaker-unheld-open");
		const lease = acquireFallbackCircuits(agentDir);
		lease.breaker.open(head, { now: 0, ...window });
		lease.release();

		fallbackCircuitsFor(`${agentDir}-unrelated`);
		expect(fallbackCircuitsFor(agentDir)).toBe(lease.breaker);
	});

	it("shares one breaker per resolved agent directory", () => {
		const agentDir = join(tmpdir(), "circuit-breaker-agent");

		expect(fallbackCircuitsFor(agentDir)).toBe(fallbackCircuitsFor(join(agentDir, "sub", "..")));
		expect(fallbackCircuitsFor(agentDir)).not.toBe(fallbackCircuitsFor(`${agentDir}-other`));
	});
});

describe("resolveFallbackCircuitSettings", () => {
	it("defaults to 60s doubling up to 30 minutes", () => {
		expect(resolveFallbackCircuitSettings(undefined)).toEqual({
			cooldownMs: DEFAULT_CIRCUIT_COOLDOWN_MS,
			maxCooldownMs: DEFAULT_CIRCUIT_MAX_COOLDOWN_MS,
		});
		expect(DEFAULT_CIRCUIT_COOLDOWN_MS).toBe(60_000);
		expect(DEFAULT_CIRCUIT_MAX_COOLDOWN_MS).toBe(1_800_000);
	});

	it("rejects malformed values and never lets the ceiling fall below the first cooldown", () => {
		expect(resolveFallbackCircuitSettings({ circuitCooldownMs: -1, circuitMaxCooldownMs: Number.NaN })).toEqual({
			cooldownMs: DEFAULT_CIRCUIT_COOLDOWN_MS,
			maxCooldownMs: DEFAULT_CIRCUIT_MAX_COOLDOWN_MS,
		});
		expect(resolveFallbackCircuitSettings({ circuitCooldownMs: 5_000, circuitMaxCooldownMs: 1_000 })).toEqual({
			cooldownMs: 5_000,
			maxCooldownMs: 5_000,
		});
	});
});

describe("createFallbackCircuitAccess", () => {
	function access(cooldownMs: number, breaker = new FallbackCircuitBreaker(), maxCooldownMs = cooldownMs) {
		return createFallbackCircuitAccess({
			breaker,
			owner: () => "session-a",
			now: () => 0,
			settings: () => ({ cooldownMs, maxCooldownMs }),
			logger: silentLogger,
		});
	}

	it("opens circuits with the session's clock and settings", () => {
		const circuits = access(1_000);

		circuits.noteFailure(head, {});

		expect(circuits.isOpen(head)).toBe(true);
	});

	it("reads a Retry-After carried as the error-message marker", () => {
		const breaker = new FallbackCircuitBreaker();
		const circuits = access(1_000, breaker, 1_800_000);

		circuits.noteFailure(head, { errorMessage: "503: Provider unavailable (retry-after-ms: 90000)" });

		expect(breaker.isOpen(head, 89_999, "session-b")).toBe(true);
		expect(breaker.isOpen(head, 90_000, "session-b")).toBe(false);
	});

	it("neither opens nor honours circuits when circuitCooldownMs is 0", () => {
		const breaker = new FallbackCircuitBreaker();
		breaker.open(head, { now: 0, ...window });
		const circuits = access(0, breaker);

		circuits.noteFailure("provider-b/model-y", {});

		expect(circuits.isOpen(head)).toBe(false);
		expect(circuits.admit(head)).toEqual({ kind: "closed" });
		expect(breaker.isOpen("provider-b/model-y", 0, "session-a")).toBe(false);
	});
});
