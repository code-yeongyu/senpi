import type { RegisteredCase } from "../../conformance/registry.ts";
import { KILL_HAND_DECLARATIONS } from "./kill-hand.ts";

const HAND_INTRO = "#5482";
const handCase = (id: string, impl: string, expected: string): RegisteredCase => ({
	id,
	impl,
	intro: HAND_INTRO,
	adapters: ["store", "transport", "executor"],
	expected,
});
const KILL_HAND_IMPL = "packages/agent/src/execution/testing/kill-hand.ts";
const MULTI_HAND_IMPL = "packages/agent/src/execution/testing/multi-hand-cases.ts";
const FAULT_HAND_IMPL = "packages/agent/src/execution/testing/fault-hand-cases.ts";
export const HAND_REGISTRY: readonly RegisteredCase[] = [
	...KILL_HAND_DECLARATIONS.map(({ id, expected }) => handCase(id, KILL_HAND_IMPL, expected)),
	handCase(
		"MULTI-HAND-01",
		MULTI_HAND_IMPL,
		"N scopes batch at once on one hand; each scope's calls start in lane order",
	),
	handCase(
		"MULTI-KILL-01",
		MULTI_HAND_IMPL,
		"cross-machine: a hand killed with several scopes in flight; each ends hand_restarted, uncertain, never rerun",
	),
	...["slow", "lossy", "laggy", "flap", "drop-reattach"].map((profile, index) =>
		handCase(
			`FAULT-HAND-0${index + 1}`,
			FAULT_HAND_IMPL,
			`${profile} profile: every call settles with its unfaulted result, runs once, per-scope order kept`,
		),
	),
	handCase(
		"FAULT-HAND-MULTI-01",
		FAULT_HAND_IMPL,
		"hand unreachable past the resume window: dependent calls pause, then each scope resumes exactly once",
	),
];
