/**
 * Reader for the server's launch log (`launches.jsonl`). The barrier is proven ONLY by the child's
 * tick pair (`launch_proof{ackTick < invokeTick}`) and by slot reads: a `slot_state` logged before
 * the launch's `launch_ack` was taken while the ack was held and must show zero invocations; one
 * logged after it must show exactly one. Wire order is asserted only for `launch_done` after
 * `launch_proof`. When a proof is logged relative to the invocation or `command_started` is not
 * asserted, since the proof is published independently of the command.
 */

export function parseLaunchLog(text) {
	return text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
}

const isTick = (value) => typeof value === "number" && Number.isFinite(value);

/** `{ ok, failures: [{ launchId, reason, detail? }] }`. */
export function checkLaunchLog(records) {
	const failures = [];
	const fail = (launchId, reason, detail) => failures.push({ launchId, reason, ...(detail ? { detail } : {}) });
	const state = new Map();
	const of = (launchId) => {
		let entry = state.get(launchId);
		if (entry === undefined) {
			entry = { acked: false, proof: false };
			state.set(launchId, entry);
		}
		return entry;
	};
	for (const record of records) {
		const launchId = record.launchId;
		if (typeof launchId !== "string") continue;
		const entry = of(launchId);
		switch (record.type) {
			case "launch_ack":
				entry.acked = true;
				break;
			case "slot_state":
				if (!entry.acked && record.invocations !== 0) fail(launchId, "invoked_while_held", `invocations=${record.invocations}`);
				if (entry.acked && record.invocations !== 1) {
					fail(launchId, "invocation_count_after_release", `invocations=${record.invocations}`);
				}
				break;
			case "launch_proof":
				entry.proof = true;
				if (!isTick(record.ackTick)) fail(launchId, "proof_missing_ack");
				else if (!isTick(record.invokeTick)) fail(launchId, "proof_missing_invoke");
				else if (!(record.ackTick < record.invokeTick)) {
					fail(launchId, "proof_order_violation", `ackTick=${record.ackTick} invokeTick=${record.invokeTick}`);
				}
				break;
			case "launch_done":
				if (!entry.proof) fail(launchId, "done_before_proof");
				break;
			case "job_membership":
				if (record.member !== true) fail(launchId, "job_membership_unproven", JSON.stringify(record.evidence ?? null));
				break;
			default:
				break;
		}
	}
	return { ok: failures.length === 0, failures };
}
