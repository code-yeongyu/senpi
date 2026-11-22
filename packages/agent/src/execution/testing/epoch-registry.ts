import type { RegisteredCase } from "../../conformance/registry.ts";
import { KILL_EPOCH_DECLARATIONS } from "./kill-epoch.ts";

const epochCase = (id: string, impl: string, expected: string): RegisteredCase => ({
	id,
	impl,
	intro: "#5729",
	adapters: ["store", "transport", "executor"],
	expected,
});
const EPOCH_IMPL = "packages/agent/src/execution/testing/epoch-cases.ts";
export const EPOCH_REGISTRY: readonly RegisteredCase[] = [
	epochCase(
		"EPOCH-01",
		EPOCH_IMPL,
		"a barrier holding the floor ACK while the new owner dispatches: 0 effects, then once",
	),
	epochCase("EPOCH-02", EPOCH_IMPL, "two concurrent CAS claims: exactly one owner; only its calls run"),
	epochCase(
		"EPOCH-03",
		EPOCH_IMPL,
		"an old owner's delayed prepare, release or invoke after the new owner's first call is refused",
	),
	epochCase(
		"MULTI-EPOCH-01",
		"packages/agent/src/execution/testing/multi-epoch-cases.ts",
		"one session's epoch bump leaves the other sessions' scopes on the hand untouched",
	),
	...KILL_EPOCH_DECLARATIONS.map(({ id, expected }) =>
		epochCase(id, "packages/agent/src/execution/testing/kill-epoch.ts", expected),
	),
];
