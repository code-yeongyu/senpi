import type { CaseImplementation } from "../../conformance/runner.ts";
import type { StoreValue } from "../../durable/store.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import type { BatchCaseAdapters } from "./batch-executor.ts";
import { BrainKilledError, batchHarness, expectRejects } from "./batch-harness.ts";
import { bindingOf, IDLE_TTL_MS } from "./lifecycle-cases.ts";

type ScopeCase = CaseImplementation<BatchCaseAdapters>;

/** SCOPE-01: the idle TTL never closes a scope that holds a live resource; it closes an idle one that holds none. */
const ttlSparesLive: ScopeCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const scopes = await h.scopes(IDLE_TTL_MS);
	await scopes.open(bindingOf("live"));
	await scopes.open(bindingOf("idle"));
	await scopes.hold("live", "bash_1", "terminal");
	h.advance(IDLE_TTL_MS + 1);
	expectEqual(await scopes.sweepIdle(), ["idle"], "only the scope without live resources closes");
	expectEqual((await scopes.read("live"))?.state, "open", "the live scope stays open");
	await scopes.release("live", "bash_1");
	expectEqual(await scopes.sweepIdle(), [], "a release is activity: the TTL starts again");
	h.advance(IDLE_TTL_MS + 1);
	expectEqual(await scopes.sweepIdle(), ["live"], "then it closes");
};

/**
 * SCOPE-02: a forced close writes every live resource's terminal outcome before the scope closes; a close that dies in
 * between leaves the written outcomes and an open scope, and the next close terminates only what is left.
 */
const forcedCloseOutcomesFirst: ScopeCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const scopes = await h.scopes(IDLE_TTL_MS);
	await scopes.open(bindingOf("A"));
	await scopes.hold("A", "r1", "execution");
	await scopes.hold("A", "r2", "terminal");
	expectEqual(await scopes.close("brain", "A"), { kind: "refused", reason: "live_resources" }, "not without force");
	const terminated: string[] = [];
	const terminate = async (resource: string): Promise<StoreValue> => {
		terminated.push(resource);
		return { reason: "cancelled", resource };
	};
	const dying = await h.scopes(IDLE_TTL_MS, { label: "outcome:r1", at: "after" });
	await expectRejects(dying.close("brain", "A", { force: true, terminate }), BrainKilledError, "dies after r1");
	const midway = await (await h.scopes(IDLE_TTL_MS)).read("A");
	expectEqual([midway?.state, Object.keys(midway?.outcomes ?? {})], ["open", ["r1"]], "r1's outcome, still open");
	const restarted = await h.scopes(IDLE_TTL_MS);
	expectEqual(await restarted.close("brain", "A", { force: true, terminate }), { kind: "closed" }, "closed");
	expectEqual(terminated, ["r1", "r2"], "each resource terminated once");
	const closed = await restarted.read("A");
	expectEqual([closed?.state, Object.keys(closed?.outcomes ?? {}).sort()], ["closed", ["r1", "r2"]], "outcomes first");
};

export const SCOPE_CASES: ReadonlyMap<string, ScopeCase> = new Map([
	["SCOPE-01", ttlSparesLive],
	["SCOPE-02", forcedCloseOutcomesFirst],
]);
