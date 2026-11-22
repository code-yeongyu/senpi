import type { RegisteredCase } from "../../conformance/registry.ts";

const NEST_IMPL = "packages/agent/src/execution/testing/nest-cases.ts";
const CANCEL_IMPL = "packages/agent/src/execution/testing/cancel-cases.ts";
const KILL_NEST_IMPL = "packages/agent/src/execution/testing/kill-nest.ts";

const nestCase = (id: string, impl: string, expected: string): RegisteredCase => ({
	id,
	impl,
	intro: "#5669",
	adapters: ["store", "executor"],
	expected,
});

export const NEST_REGISTRY: readonly RegisteredCase[] = [
	nestCase("NEST-01", NEST_IMPL, "a nested request from another hand or naming a forged parent is refused"),
	nestCase(
		"NEST-02",
		NEST_IMPL,
		"a replayed nested request returns the same child, after a restart too; debited once",
	),
	nestCase("NEST-03", NEST_IMPL, "sibling children over the parent's budget are refused at the reservation"),
	nestCase("NEST-04", NEST_IMPL, "a request naming another generation or scope of the parent is refused"),
	nestCase(
		"NEST-05",
		NEST_IMPL,
		"a preflight cross-plane call is admitted under the preparation-phase nested set only",
	),
	nestCase("NEST-06", NEST_IMPL, "release widens the nested set to the body phase"),
	nestCase(
		"NEST-07",
		NEST_IMPL,
		"a detached cell is admitted against its registered activity, within its subset, and refused after it ends",
	),
	nestCase("NEST-08", NEST_IMPL, "an activity's children debit its own budget and the parent's reservation"),
	nestCase(
		"NEST-09",
		NEST_IMPL,
		"the nested set expires with the parent's lease and renewals, never past its lifetime",
	),
	nestCase("CANCEL-01", CANCEL_IMPL, "a parent cancel committed first refuses the child parent_terminal"),
	nestCase(
		"CANCEL-02",
		CANCEL_IMPL,
		"a child admitted first exists; the parent cancel durably cascades to it until delivered",
	),
	nestCase(
		"KILL-NEST-01",
		KILL_NEST_IMPL,
		"a brain killed before a child admission is durable admits it once on retry",
	),
	nestCase("KILL-NEST-02", KILL_NEST_IMPL, "a brain killed after a child admission is durable returns the same child"),
	nestCase("KILL-NEST-03", KILL_NEST_IMPL, "a brain killed around the cancel cascade re-sends it until recorded"),
];
