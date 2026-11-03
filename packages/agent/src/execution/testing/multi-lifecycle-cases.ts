import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import type { BatchCaseAdapters } from "./batch-executor.ts";
import { batchHarness } from "./batch-harness.ts";
import { bindingOf, IDLE_TTL_MS } from "./lifecycle-cases.ts";

/**
 * MULTI-LIFE-01 (Z2, S15): sessions A and B on one endpoint. A's agent_end and turn_start effects are committed to A
 * only; B's events and resources are untouched, and B's calls do not wait on A's lifecycle handler.
 */
const lifecycleStaysInSession: CaseImplementation<BatchCaseAdapters> = async (adapters) => {
	const h = await batchHarness(adapters);
	const scopes = await h.scopes(IDLE_TTL_MS);
	await scopes.open(bindingOf("A", "brain-a"));
	await scopes.open(bindingOf("B", "brain-b"));
	await scopes.hold("B", "computer", "lease");
	const held = Promise.withResolvers<void>();
	const endA = scopes.lifecycle("brain-a", "A", "agent_end", async () => {
		await held.promise;
		return { revoked: "computer" };
	});
	expectEqual(await scopes.call("B", async () => "B ran"), "B ran", "B's call does not wait on A's handler");
	held.resolve();
	await endA;
	await scopes.lifecycle("brain-a", "A", "turn_start", async () => ({ reset: "comment-checker" }));
	expectEqual(
		(await scopes.read("A"))?.events.map(({ kind, effect }) => [kind, effect]),
		[
			["agent_end", { revoked: "computer" }],
			["turn_start", { reset: "comment-checker" }],
		],
		"A's effects in A",
	);
	const b = await scopes.read("B");
	expectEqual([b?.events, b?.resources], [[], { computer: "lease" }], "B is untouched");
	expectEqual(
		await scopes.lifecycle("brain-a", "B", "agent_end", async () => null),
		{ kind: "refused", reason: "not_issuer" },
		"A's brain cannot end B",
	);
};

export const MULTI_LIFECYCLE_CASES: ReadonlyMap<string, CaseImplementation<BatchCaseAdapters>> = new Map([
	["MULTI-LIFE-01", lifecycleStaysInSession],
]);
