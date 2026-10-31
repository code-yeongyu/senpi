// SC-LIVE G1 (plan §3.4): PreToolUse and PostToolUse fire exactly once per call, joined by session AND call id
// (senpi#5128). Unit-tested on synthetic records in live-hook-invariants.test.mjs.
import { nestedCalls, transcriptCalls } from "./live-transcript.mjs";

const MEMORY_FACTS_ORIGIN = "omo-memory-facts";
const FACTS_RUN_DIR = /^facts-[0-9a-f]{12}-\d+$/;

/**
 * A child session omo's memory starts on its own to record facts, never a user-visible session: omo launches it with
 * taskId = parentSessionId = rootSessionId = `facts-<runId>` and cwd = its run dir `facts-<digest>-<attempt>`
 * (omo packages/omo-senpi/src/components/memory/facts-in-process-launch.ts, facts-run-storage.ts), and senpi persists
 * that ancestry as the header's spawnedBy. Any other or partial origin is not this marker.
 */
function isMemoryFactsSession(header) {
	const { taskId, parentSessionId, rootSessionId } = header?.spawnedBy ?? {};
	const runId = header?.cwd?.split(/[\\/]/).at(-1) ?? "";
	return FACTS_RUN_DIR.test(runId) && taskId === `facts-${runId}` && parentSessionId === taskId && rootSessionId === taskId;
}

/**
 * G1: PreToolUse and PostToolUse fire exactly once per call (top-level, nested-agent and eval-run calls alike) in every
 * user-visible session: the parent and its task sub-agents. Memory facts sessions are excluded (LEAD ruling (a) on
 * senpi#5093) and reported in `excluded`; every other child session is checked.
 */
export function checkHooksOncePerCall(hookTrace, entries, events, sessionTranscripts = []) {
	const failures = [];
	const sessions = new Map();
	const excluded = [];
	for (const transcript of [{ entries }, ...sessionTranscripts]) {
		const header = transcript.entries.find((entry) => entry.type === "session");
		const id = header?.id;
		if (!id || sessions.has(id)) {
			failures.push(`missing or duplicate session transcript ${id}`);
			continue;
		}
		const callIds = new Set(transcriptCalls(transcript.entries).map((call) => call.id));
		// The trusted sandbox extension records engine tool_call ids in the owning session.
		// Eval result details.toolCalls carry DIFFERENT kernel-local ids, not hook ids.
		for (const entry of transcript.entries)
			if (entry.type === "custom" && entry.customType === "live-tool-call" && entry.data?.id)
				callIds.add(entry.data.id);
		const memory = transcript.entries !== entries && isMemoryFactsSession(header);
		if (memory) excluded.push(id);
		sessions.set(id, {
			calls: callIds,
			fired: { PreToolUse: new Map(), PostToolUse: new Map() },
			memory,
		});
	}
	// Eval dispatches are not assistant toolCall blocks. Keep their independent parent RPC execution
	// evidence, but only under an eval call present in THIS parent's transcript, never under another session.
	const parentId = entries.find((entry) => entry.type === "session")?.id;
	const parent = sessions.get(parentId);
	const evalIds = new Set(transcriptCalls(entries).filter((call) => call.name === "eval").map((call) => call.id));
	for (const call of nestedCalls(events)) {
		if (parent && evalIds.has(call.parentId)) parent.calls.add(call.id);
		else if (![...sessions.values()].some((session) => session.calls.has(call.id)))
			failures.push(`nested call ${call.id} has no owning session`);
	}
	for (const line of hookTrace) {
		const session = sessions.get(line.session_id);
		if (!session) {
			failures.push(`${line.event} fired for unknown session ${line.session_id}, call ${line.toolCallId}`);
			continue;
		}
		const { calls, fired } = session;
		if (!fired[line.event]) failures.push(`unexpected hook event ${line.event}`);
		else fired[line.event].set(line.toolCallId, (fired[line.event].get(line.toolCallId) ?? 0) + 1);
		if (!calls.has(line.toolCallId))
			failures.push(`${line.event} fired for unknown call ${line.toolCallId} in session ${line.session_id}`);
	}
	let count = 0;
	for (const [sessionId, { calls, fired, memory }] of sessions) {
		if (memory) continue;
		count += calls.size;
		for (const id of calls)
			for (const event of Object.keys(fired)) {
				const count = fired[event].get(id) ?? 0;
				if (count !== 1) failures.push(`${event} fired ${count} times for ${id} in session ${sessionId}`);
			}
	}
	const checked = `${count} calls in ${sessions.size - excluded.length} sessions, Pre and Post once each`;
	return {
		id: "G1.hooks-once-per-call",
		pass: failures.length === 0,
		detail: failures.length
			? failures
			: excluded.length
				? `${checked}; excluded ${excluded.length} ${MEMORY_FACTS_ORIGIN} session(s): ${excluded.join(", ")}`
				: checked,
		excluded: { origin: MEMORY_FACTS_ORIGIN, count: excluded.length, sessions: excluded },
	};
}
