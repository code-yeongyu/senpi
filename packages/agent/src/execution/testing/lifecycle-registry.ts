import type { RegisteredCase } from "../../conformance/registry.ts";

const LIFECYCLE_IMPL = "packages/agent/src/execution/testing/lifecycle-cases.ts";
const SCOPE_IMPL = "packages/agent/src/execution/testing/scope-cases.ts";
const MULTI_LIFE_IMPL = "packages/agent/src/execution/testing/multi-lifecycle-cases.ts";

const lifecycleCase = (id: string, impl: string, expected: string): RegisteredCase => ({
	id,
	impl,
	intro: "#5681",
	adapters: ["store", "executor"],
	expected,
});

export const LIFECYCLE_REGISTRY: readonly RegisteredCase[] = [
	lifecycleCase(
		"LIFECYCLE-01",
		LIFECYCLE_IMPL,
		"a call after a lifecycle event runs only once the event's effect committed",
	),
	lifecycleCase("LIFECYCLE-02", LIFECYCLE_IMPL, "only the scope's issuer submits lifecycle events or closes it"),
	lifecycleCase("LIFECYCLE-03", LIFECYCLE_IMPL, "a closed scope admits no lifecycle event and is not reopened"),
	lifecycleCase("SCOPE-01", SCOPE_IMPL, "the idle TTL never closes a scope that holds live resources"),
	lifecycleCase("SCOPE-02", SCOPE_IMPL, "a forced close writes every live resource's outcome before the scope closes"),
	lifecycleCase("MULTI-LIFE-01", MULTI_LIFE_IMPL, "A's agent_end and turn_start effects stay in A; B is untouched"),
];
