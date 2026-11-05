// senpi#5663 (S12): Gate A and Gate B consent on the batch coordinator, cross-machine only, on the memory store.
import { describe, expect, it } from "vitest";
import { findImplementationGaps } from "../../src/conformance/mapping.ts";
import { CONFORMANCE_REGISTRY } from "../../src/conformance/registry.ts";
import { createMemoryStoreMedium, type MemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import type { StoreConformanceAdapter } from "../../src/durable/testing/store-harness.ts";
import { referenceBatchExecutor } from "../../src/execution/testing/batch-executor.ts";
import { batchHarness, batchPlan, resultOf } from "../../src/execution/testing/batch-harness.ts";
import { CONSENT_CASES, scriptedConsent } from "../../src/execution/testing/consent-cases.ts";

function memoryStore(): StoreConformanceAdapter {
	const media = new Map<string, MemoryStoreMedium>();
	return {
		createMedium: async () => {
			const id = `medium-${media.size}`;
			media.set(id, createMemoryStoreMedium());
			return id;
		},
		open: async (id, options) => {
			const medium = media.get(id);
			if (medium === undefined) throw new Error(`unknown medium ${id}`);
			return openMemoryStore(medium, options);
		},
	};
}

const adapters = () => ({ store: memoryStore(), executor: referenceBatchExecutor });

describe("consent conformance on the memory store", () => {
	for (const [id, run] of CONSENT_CASES) it(id, () => run(adapters()));

	it("registers exactly CONSENT-01 and CONSENT-02, each with an implementation", () => {
		const registry = CONFORMANCE_REGISTRY.filter(({ id }) => id.startsWith("CONSENT-"));
		expect(registry.map(({ id }) => id)).toEqual(["CONSENT-01", "CONSENT-02"]);
		expect(findImplementationGaps(registry, CONSENT_CASES)).toEqual({ unimplemented: [], unregistered: [] });
	});
});

describe("Gate B on the batch coordinator", () => {
	it("an approval binds the frozen digest: the call is released without rerunning its hooks; siblings run", async () => {
		const h = await batchHarness(adapters());
		const approver = scriptedConsent();
		const run = (await h.brain(undefined, "brain", approver.port)).run(
			batchPlan("gate-b-approve", [
				["g", "e1", "gated"],
				["b", "e2"],
			]),
		);
		await approver.asked;
		expect(h.count("body:b")).toBe(0);
		approver.answer("approved");
		expect((await run).outcomes).toEqual([resultOf("g", "gated"), resultOf("b")]);
		expect(approver.requests).toMatchObject([{ executionId: "g", gate: "frozen" }]);
		expect([h.count("hook:g"), h.count("body:g")]).toEqual([1, 1]);
	});

	it("a denial is a per-call blocked result; the other calls run", async () => {
		const h = await batchHarness(adapters());
		const approver = scriptedConsent();
		const run = (await h.brain(undefined, "brain", approver.port)).run(
			batchPlan("gate-b-deny", [
				["g", "e1", "gated"],
				["b", "e2"],
			]),
		);
		await approver.asked;
		approver.answer("denied");
		const result = await run;
		expect(result.decision).toBe("RELEASE");
		expect(result.outcomes).toEqual([
			{ kind: "blocked", result: { reason: "consent_denied", gate: "frozen", answer: "denied" } },
			resultOf("b"),
		]);
		expect(h.count("body:g")).toBe(0);
	});

	it("a brain that dies right after recording an approval asks nobody again: recovery applies the stored answer", async () => {
		const h = await batchHarness(adapters());
		const approver = scriptedConsent();
		const plan = batchPlan("gate-b-crash", [["g", "e1", "gated"]]);
		const first = (await h.brain({ label: "consent:g", at: "after" }, "brain", approver.port)).run(plan);
		await approver.asked;
		approver.answer("approved");
		await expect(first).rejects.toThrow("brain killed around consent:g");
		const recovered = await (await h.brain(undefined, "brain", approver.port)).run(plan);
		expect(recovered.outcomes).toEqual([resultOf("g", "gated")]);
		expect(approver.requests).toHaveLength(1);
		expect([h.count("hook:g"), h.count("body:g")]).toEqual([1, 1]);
	});

	it("an expiry the approver reports before the executor's clock sends nothing: the endpoint expires on its own lease", async () => {
		const h = await batchHarness(adapters());
		const approver = scriptedConsent();
		const run = (await h.brain(undefined, "brain", approver.port)).run(
			batchPlan("gate-b-early-expiry", [["g", "e1", "gated"]]),
		);
		await approver.asked;
		approver.answer("expired");
		expect((await run).outcomes).toEqual([{ kind: "interrupted", reason: "lease_expired", uncertain: true }]);
		expect(await h.ledgerState("e1", "g")).toBe("prepared_awaiting_consent");
		h.advance(120_000);
		const late = await h
			.executor("e1")
			.consent?.({ issuer: "brain", executionId: "g", generation: 1 }, approver.requests[0]?.digest ?? "");
		expect(late).toMatchObject({ kind: "settled", outcome: { reason: "lease_expired" } });
		expect(h.count("body:g")).toBe(0);
	});

	it("an executor with no consent configured never waits: today's freeze path is unchanged", async () => {
		const h = await batchHarness(adapters());
		const result = await (await h.brain()).run(batchPlan("no-consent", [["b", "e1"]]));
		expect(result.outcomes).toEqual([resultOf("b")]);
	});
});

describe("Gate A on the batch coordinator", () => {
	it("a raw call that needs consent is prepared only after approval, and the approved digest covers its frozen call", async () => {
		const h = await batchHarness(adapters());
		const approver = scriptedConsent((name) => name === "ask");
		const run = (await h.brain(undefined, "brain", approver.port)).run(
			batchPlan("gate-a-approve", [["k", "e1", "ask"]]),
		);
		await approver.asked;
		expect(h.count("shim:k")).toBe(0);
		approver.answer("approved");
		expect((await run).outcomes).toEqual([resultOf("k", "ask")]);
		expect(approver.requests).toMatchObject([{ executionId: "k", gate: "raw" }]);
	});

	it("a refused raw call is never prepared and is a blocked per-call result", async () => {
		const h = await batchHarness(adapters());
		const approver = scriptedConsent((name) => name === "ask");
		const run = (await h.brain(undefined, "brain", approver.port)).run(
			batchPlan("gate-a-deny", [
				["k", "e1", "ask"],
				["b", "e2"],
			]),
		);
		await approver.asked;
		approver.answer("denied");
		const result = await run;
		expect(result.outcomes).toEqual([
			{ kind: "blocked", result: { reason: "consent_denied", gate: "raw", answer: "denied" } },
			resultOf("b"),
		]);
		expect(h.count("shim:k")).toBe(0);
	});
});
