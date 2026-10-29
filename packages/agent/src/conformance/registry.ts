export const ADAPTER_KINDS = ["store", "wake", "transport", "executor", "host"] as const;

export type AdapterKind = (typeof ADAPTER_KINDS)[number];

/** One conformance case: where it is implemented, which change introduced it, what it needs, and what it proves. */
export interface RegisteredCase {
	/** Unique upper-case ID, for example `STORE-01` or `KILL-STORE-01`. */
	readonly id: string;
	/** Repository-relative path of the TypeScript file that implements the case. */
	readonly impl: string;
	/** The change that introduced the case (a pull request such as `#4727`). */
	readonly intro: string;
	readonly adapters: readonly AdapterKind[];
	readonly expected: string;
}

/**
 * Every case of the durable-core conformance suite (packages/agent/docs/durable-core-adr.md). A change that adds cases
 * registers each of them here, with its mapping, in the same change.
 */
const STORE_CASES_IMPL = "packages/agent/src/durable/testing/store-cases.ts";
const KILL_STORE_IMPL = "packages/agent/src/durable/testing/kill-store.ts";
const WAKE_CASES_IMPL = "packages/agent/src/durable/testing/wake-cases.ts";
const MULTI_HOST_IMPL = "packages/agent/src/durable/testing/multi-host-cases.ts";
const KILL_WAKE_IMPL = "packages/agent/src/durable/testing/kill-wake.ts";
const TRANSPORT_CASES_IMPL = "packages/agent/src/transport/testing/transport-cases.ts";
const MULTI_CASES_IMPL = "packages/agent/src/transport/testing/multi-cases.ts";
const FAULT_CASES_IMPL = "packages/agent/src/transport/testing/fault-cases.ts";
const transportCase = (id: string, impl: string, expected: string): RegisteredCase => ({
	id,
	impl,
	intro: "#4741",
	adapters: ["transport"],
	expected,
});
const faultCase = (n: number, profile: string): RegisteredCase =>
	transportCase(
		`FAULT-TRANSPORT-0${n}`,
		FAULT_CASES_IMPL,
		`${profile} profile: lane order kept, committed frames delivered once, resume from the last ACK`,
	);
const wakeCase = (id: string, impl: string, expected: string): RegisteredCase => ({
	id,
	impl,
	intro: "#4735",
	adapters: ["store", "wake"],
	expected,
});
const storeCase = (id: string, impl: string, expected: string): RegisteredCase => ({
	id,
	impl,
	intro: "#4730",
	adapters: ["store"],
	expected,
});

export const CONFORMANCE_REGISTRY: readonly RegisteredCase[] = [
	storeCase(
		"STORE-01",
		STORE_CASES_IMPL,
		"a commit adopts once, after its batch is durable; every instance sees each batch whole",
	),
	storeCase(
		"STORE-02",
		STORE_CASES_IMPL,
		"a cut at every write point of a commit leaves nothing of it durable, with no adopt and no seq burned",
	),
	storeCase(
		"STORE-03",
		STORE_CASES_IMPL,
		"concurrent admissions run one at a time in admission order; a refused mutation releases the line",
	),
	storeCase(
		"STORE-04",
		STORE_CASES_IMPL,
		"an old owner's delayed commit or claim after the new owner's first commit is refused and changes nothing",
	),
	storeCase(
		"STORE-05",
		STORE_CASES_IMPL,
		"claim + import across hosts is whole, idempotent and tail-only; a diverged log is refused atomically",
	),
	storeCase(
		"STORE-06",
		STORE_CASES_IMPL,
		"minted IDs are unique; record and document scans, deletes and duplicate-ID refusal behave as specified",
	),
	storeCase(
		"STORE-07",
		STORE_CASES_IMPL,
		"a claim raises the epoch by exactly one; a claim that skips an epoch is refused and changes nothing",
	),
	storeCase(
		"KILL-STORE-01",
		KILL_STORE_IMPL,
		"everywhere: kill before a commit; after restart nothing is durable and the batch commits with the same IDs",
	),
	storeCase(
		"KILL-STORE-02",
		KILL_STORE_IMPL,
		"everywhere: kill after a commit is durable; after restart it is whole, stable IDs, and a retry applies nothing",
	),
	storeCase(
		"KILL-STORE-03",
		KILL_STORE_IMPL,
		"everywhere: kill before a claim; after restart the epoch is unchanged and the claim succeeds",
	),
	storeCase(
		"KILL-STORE-04",
		KILL_STORE_IMPL,
		"everywhere: kill after a claim is durable; after restart the new epoch holds and the old one is fenced",
	),
	storeCase(
		"KILL-STORE-05",
		KILL_STORE_IMPL,
		"everywhere: kill before an import; after restart nothing is imported and the import succeeds",
	),
	storeCase(
		"KILL-STORE-06",
		KILL_STORE_IMPL,
		"everywhere: kill after an import is durable; after restart it is whole and a re-import adds nothing",
	),
	wakeCase(
		"WAKE-01",
		WAKE_CASES_IMPL,
		"pre-arm: a recovery alarm is durable before admitted work starts and before a new instance resumes",
	),
	wakeCase(
		"WAKE-02",
		WAKE_CASES_IMPL,
		"update: after each commit the alarm is min(heartbeat if active, earliest wake), cleared only when idle",
	),
	wakeCase(
		"WAKE-03",
		WAKE_CASES_IMPL,
		"resume: a fire re-arms before resume, runs due work once, and an early fire is harmless",
	),
	wakeCase(
		"WAKE-RET-01",
		WAKE_CASES_IMPL,
		"retention: an alarm survives host restarts and reopened instances, fires once, and is cleared after the work",
	),
	wakeCase("MULTI-HOST-01", MULTI_HOST_IMPL, "many sessions on one host instance: records and wakes stay per session"),
	wakeCase(
		"KILL-WAKE-01",
		KILL_WAKE_IMPL,
		"everywhere: kill during admit's alarm write; nothing is durable and a retried admission runs once",
	),
	wakeCase(
		"KILL-WAKE-02",
		KILL_WAKE_IMPL,
		"everywhere: kill after admit's arm, before work; the alarm fires harmlessly and ends cleared",
	),
	wakeCase(
		"KILL-WAKE-03",
		KILL_WAKE_IMPL,
		"everywhere: kill between a commit and its alarm update; the pre-armed heartbeat recovers the wake, run once",
	),
	wakeCase(
		"KILL-WAKE-04",
		KILL_WAKE_IMPL,
		"everywhere: eviction during the update's alarm write; the heartbeat recovers the wake, run once",
	),
	wakeCase(
		"KILL-WAKE-05",
		KILL_WAKE_IMPL,
		"everywhere: kill after a fire's re-arm, before resume; the next fire runs the due work once",
	),
	wakeCase(
		"KILL-WAKE-06",
		KILL_WAKE_IMPL,
		"everywhere: kill after a resumed task's commit is durable; the task never runs twice and the alarm clears",
	),
	wakeCase(
		"KILL-WAKE-07",
		KILL_WAKE_IMPL,
		"everywhere: eviction during the alarm clear after the work; the next fire is harmless and clears it",
	),
	wakeCase(
		"KILL-WAKE-08",
		KILL_WAKE_IMPL,
		"everywhere: a concurrent fire's updates cannot clear an uncommitted admission's heartbeat; a kill after its commit recovers the wake, run once",
	),
	transportCase(
		"TRANSPORT-01",
		TRANSPORT_CASES_IMPL,
		"order: frames on each lane are delivered in send order, each once",
	),
	transportCase(
		"TRANSPORT-02",
		TRANSPORT_CASES_IMPL,
		"resume: after the carrier drops and re-attaches, each lane continues from its last ACK; nothing lost or repeated",
	),
	transportCase(
		"TRANSPORT-03",
		TRANSPORT_CASES_IMPL,
		"backpressure: a stalled receiver bounds its lane's senders; sends resolve in order once it drains",
	),
	transportCase("MULTI-LANE-01", MULTI_CASES_IMPL, "N scopes over one transport keep per-scope order and interleave"),
	transportCase(
		"MULTI-FAIR-01",
		MULTI_CASES_IMPL,
		"a stalled or long lane in A does not starve B: B is delivered within a bounded number of A's frames",
	),
	transportCase(
		"MULTI-FAIR-02",
		MULTI_CASES_IMPL,
		"a frame lost on one lane is resent on that lane's own deadline: another lane's ACK progress never postpones it",
	),
	faultCase(1, "slow"),
	faultCase(2, "lossy"),
	faultCase(3, "laggy"),
	faultCase(4, "flap"),
	faultCase(5, "drop-reattach"),
];
