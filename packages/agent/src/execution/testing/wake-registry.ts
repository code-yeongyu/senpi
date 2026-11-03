import type { RegisteredCase } from "../../conformance/registry.ts";

const WAKE_EXEC_IMPL = "packages/agent/src/execution/testing/wake-exec-cases.ts";
const KILL_WAKEX_IMPL = "packages/agent/src/execution/testing/kill-wakex.ts";

const wakeCase = (id: string, impl: string, expected: string): RegisteredCase => ({
	id,
	impl,
	intro: "#5675",
	adapters: ["store", "executor"],
	expected,
});

export const WAKE_EXEC_REGISTRY: readonly RegisteredCase[] = [
	wakeCase("WAKE-EXEC-01", WAKE_EXEC_IMPL, "a wake is durable on the hand, committed on the brain, acked, taken once"),
	wakeCase(
		"WAKE-EXEC-02",
		WAKE_EXEC_IMPL,
		"a re-offered wake whose ack was lost is deduplicated by event id and acked",
	),
	wakeCase("WAKE-EXEC-03", WAKE_EXEC_IMPL, "un-acked wakes are re-offered on reconnect in offer order"),
	wakeCase(
		"WAKE-EXEC-04",
		WAKE_EXEC_IMPL,
		"a wake from a hand not bound to its scope commits nothing and is never acked",
	),
	wakeCase("WAKE-EXEC-05", WAKE_EXEC_IMPL, "an un-acked wake lives until scope close plus 7 days, then wake_expired"),
	wakeCase("KILL-WAKEX-01", KILL_WAKEX_IMPL, "a hand killed before the outbox commit leaves nothing to re-offer"),
	wakeCase("KILL-WAKEX-02", KILL_WAKEX_IMPL, "a hand killed after the outbox commit re-offers the wake once"),
	wakeCase(
		"KILL-WAKEX-03",
		KILL_WAKEX_IMPL,
		"a brain killed before the inbox commit sent no ack; the re-offer delivers once",
	),
	wakeCase("KILL-WAKEX-04", KILL_WAKEX_IMPL, "a brain killed after the inbox commit dedups the re-offer and acks it"),
	wakeCase(
		"KILL-WAKEX-05",
		KILL_WAKEX_IMPL,
		"a hand killed before recording the ack re-offers; the duplicate is acked",
	),
	wakeCase("KILL-WAKEX-06", KILL_WAKEX_IMPL, "a brain killed before recording a take hands the same wake over again"),
];
