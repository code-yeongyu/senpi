import type { RegisteredCase } from "../../conformance/registry.ts";

const INTRO = "#5661";

export const SEQ_REGISTRY: readonly RegisteredCase[] = [
	{
		id: "SEQ-01",
		impl: "packages/agent/src/execution/testing/seq-cases.ts",
		intro: INTRO,
		adapters: ["store", "executor"],
		expected:
			"sequential mode interleaves prepare and run per call across executors; a crash resumes without rerunning; a stop ends the run unprepared",
	},
	{
		id: "MULTI-FAIR-02",
		impl: "packages/agent/src/execution/testing/multi-seq-cases.ts",
		intro: INTRO,
		adapters: ["store", "executor"],
		expected: "a long sequential batch in session A does not starve session B on the same executor",
	},
	{
		id: "CONSENT-01",
		impl: "packages/agent/src/execution/testing/consent-cases.ts",
		intro: "#5663",
		adapters: ["store", "executor"],
		expected:
			"cross-machine only: the lease expires while a call awaits Gate B consent: lease_expired, uncertain, the batch ABORTed, no successor",
	},
	{
		id: "CONSENT-02",
		impl: "packages/agent/src/execution/testing/consent-cases.ts",
		intro: "#5663",
		adapters: ["store", "executor"],
		expected:
			"cross-machine only: an approval that arrives after the lease expired is rejected; the outcome stays lease_expired",
	},
];
