// SC-LIVE invariant checker (plan §3.4, P0-05g): pure checks over one live-session run record. Each check returns
// { id, pass, detail }; evaluateLiveRun() runs them all and passes only when every one passes. Nothing here talks to a
// model or a process, so the checks are unit-tested on synthetic records (live-invariants.test.mjs);
// G1 lives in live-hook-invariants.mjs.
import { diffNormalized } from "./equivalence-normalize.mjs";
import { checkHooksOncePerCall } from "./live-hook-invariants.mjs";
import { messages, nestedCalls, toolResults, transcriptCalls } from "./live-transcript.mjs";

const MIN_TOOL_CALLS = 30;
const MIN_TURNS = 8;
export const MAX_BUDGET = 1_000_000;
const QUESTION_TOOLS = new Set(["ask_user_question", "request_user_input"]);
/** RPC events that report an engine failure (plus any assistant message that stopped with "error"). */
const ENGINE_ERROR_EVENTS = new Set(["extension_error", "continuation_error", "model_config_error"]);
/** Placements on which no uncertain / hand_restarted / abort marker may appear (plan §3.4). */
const MARKER_FREE_PLACEMENTS = new Set(["fused", "split-local"]);
const MARKER_VALUES = new Set(["uncertain", "hand_restarted"]);
/** Free-text fields a model writes: a marker word inside them is prose, not an engine state. */
const PROSE_KEYS = new Set(["text", "thinking", "arguments", "input", "content", "delta", "partialJson", "message"]);

const check = (id, failures, detail) => ({
	id,
	pass: failures.length === 0,
	detail: failures.length ? failures : detail,
});

/** B4: every call has exactly one result, and each assistant message's results are persisted in its call order. */
export function checkResultsOncePerCall(entries) {
	const failures = [];
	const list = messages(entries).map(({ message }) => message);
	const calls = transcriptCalls(entries);
	const counts = new Map(calls.map((call) => [call.id, 0]));
	for (const result of toolResults(entries)) {
		if (!counts.has(result.toolCallId)) failures.push(`result without a call: ${result.toolCallId}`);
		else counts.set(result.toolCallId, counts.get(result.toolCallId) + 1);
	}
	for (const [id, count] of counts) if (count !== 1) failures.push(`call ${id} has ${count} results`);
	list.forEach((message, index) => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) return;
		const expected = message.content.filter((part) => part?.type === "toolCall").map((part) => part.id);
		if (!expected.length) return;
		const following = [];
		for (let next = index + 1; next < list.length && list[next].role === "toolResult"; next++)
			following.push(list[next].toolCallId);
		if (JSON.stringify(following) !== JSON.stringify(expected))
			failures.push(`results after message ${index} are [${following}] but its calls are [${expected}]`);
	});
	return check("B4.results-once-in-order", failures, `${calls.length} calls, each with one result in source order`);
}

/** No engine error event, and no assistant message that stopped with "error". */
export function checkNoEngineError(events, entries) {
	const failures = [];
	for (const event of events) {
		if (ENGINE_ERROR_EVENTS.has(event.type)) failures.push(`event ${event.type}`);
		if (event.type === "message_end" && event.message?.stopReason === "error")
			failures.push("assistant message_end stopReason=error");
	}
	for (const { message } of messages(entries))
		if (message.role === "assistant" && message.stopReason === "error")
			failures.push("persisted assistant stopReason=error");
	return check("engine.no-error", failures, "no engine error event");
}

/** Every started tool execution (the session's and nested ones) has ended, and every end follows its start. */
export function checkNoDanglingCall(events) {
	const failures = [];
	const open = new Map();
	let started = 0;
	for (const { type, toolCallId: id } of events) {
		if (type === "tool_execution_start") {
			started++;
			open.set(id, (open.get(id) ?? 0) + 1);
		} else if (type === "tool_execution_end") {
			if (open.get(id)) open.set(id, open.get(id) - 1);
			else failures.push(`call ${id} ended without a start`);
		}
	}
	for (const [id, count] of open) if (count > 0) failures.push(`call ${id} started and never ended`);
	return check("engine.no-dangling-call", failures, `${started} started, all ended`);
}

/** O7: the transcript reopens with the same durable id and message count, and every persisted entry is kept. */
export function checkReopen(reopen, entries, entriesAfterReopen) {
	const failures = [];
	const { before = {}, after = {} } = reopen ?? {};
	if (!before.sessionId || before.sessionId !== after.sessionId)
		failures.push(`durable id ${before.sessionId} -> ${after.sessionId}`);
	if (!(before.messageCount > 0) || before.messageCount !== after.messageCount)
		failures.push(`message count ${before.messageCount} -> ${after.messageCount}`);
	const ids = (list) => list.map((entry) => entry?.id ?? null);
	if (!entries.length) failures.push("transcript is empty");
	if (JSON.stringify(ids(entriesAfterReopen).slice(0, entries.length)) !== JSON.stringify(ids(entries)))
		failures.push("reopen did not keep every persisted entry in place");
	return check("O7.reopen", failures, `${entries.length} entries, id and ${before.messageCount} messages kept`);
}

/** O3/O4: declarations and sanitized headers equal across the run's placements and, for fused, the reference run. */
export function checkDeclarationsAcrossPlacements(own, others = [], reference) {
	const failures = [];
	const compare = (label, other) => {
		for (const id of ["O3", "O4"]) {
			const rows = diffNormalized(other?.[id], own.observations?.[id]);
			if (rows.length)
				failures.push(
					`${id} differs from ${label}: ${rows
						.slice(0, 3)
						.map((row) => row.path)
						.join(", ")}`,
				);
		}
	};
	for (const other of others) compare(`placement ${other.placement}`, other.observations);
	if (reference && own.placement === "fused") compare("the reference run", reference);
	const compared = others.length + (reference && own.placement === "fused" ? 1 : 0);
	return check(
		"O3O4.across-placements",
		failures,
		compared ? `equal to ${compared} run(s)` : "recorded (nothing to compare yet)",
	);
}

function findMarkers(value, path, found) {
	if (typeof value === "string") {
		if (MARKER_VALUES.has(value)) found.push(`${path}=${value}`);
	} else if (Array.isArray(value)) value.forEach((item, index) => findMarkers(item, `${path}[${index}]`, found));
	else if (value && typeof value === "object")
		for (const [key, child] of Object.entries(value)) {
			if (key === "stopReason" && child === "aborted") found.push(`${path}.stopReason=aborted`);
			if (MARKER_VALUES.has(key)) found.push(`${path}.${key}`);
			if (!(PROSE_KEYS.has(key) && typeof child === "string")) findMarkers(child, `${path}.${key}`, found);
		}
	return found;
}

/** No uncertain, hand_restarted or abort marker on fused or split-local. */
export function checkNoMarkers(placement, events, entries) {
	if (!MARKER_FREE_PLACEMENTS.has(placement)) return check("markers.none", [], `not required on ${placement}`);
	const failures = [...findMarkers(events, "events", []), ...findMarkers(entries, "entries", [])].slice(0, 20);
	return check("markers.none", failures, "no uncertain, hand_restarted or abort marker");
}

/** The SC-LIVE task shape: >= 30 tool calls over >= 8 turns, using every required component. */
export function checkTaskShape({ entries, events = [], turns, questions }) {
	const calls = transcriptCalls(entries);
	const results = new Map(toolResults(entries).map((result) => [result.toolCallId, result]));
	const ok = (call) => results.get(call.id)?.isError === false;
	const byMessage = (name) => new Set(calls.filter((call) => call.name === name).map((call) => call.messageIndex));
	const perMessage = (name) =>
		[...byMessage(name)].map((index) => calls.filter((c) => c.messageIndex === index && c.name === name).length);
	// Bash runs as a direct call or inside an eval cell; "sequential" = bash in at least two different top-level calls.
	const bashParents = new Set([
		...calls.filter((call) => call.name === "bash" && ok(call)).map((call) => call.id),
		...nestedCalls(events)
			.filter((call) => call.name === "bash" && calls.some((parent) => parent.id === call.parentId && ok(parent)))
			.map((call) => call.parentId),
	]);
	const failures = [];
	if (calls.length < MIN_TOOL_CALLS) failures.push(`${calls.length} tool calls < ${MIN_TOOL_CALLS}`);
	if (turns < MIN_TURNS) failures.push(`${turns} turns < ${MIN_TURNS}`);
	const required = {
		"parallel reads": perMessage("read").some((count) => count >= 2),
		"sequential bash": bashParents.size >= 2,
		"an edit": calls.some((call) => call.name === "edit" && ok(call)),
		"an MCP fixture call": calls.some((call) => call.name.startsWith("mcp_") && ok(call)),
		"a question answered over RPC":
			calls.some((call) => QUESTION_TOOLS.has(call.name) && ok(call)) && questions?.answered > 0,
		"the with-deps tool": calls.some((call) => call.name === "parse_duration" && ok(call)),
		"a sub-agent": calls.some((call) => call.name === "task" && ok(call)),
	};
	for (const [what, met] of Object.entries(required)) if (!met) failures.push(`missing ${what}`);
	return check("task.shape", failures, `${calls.length} tool calls over ${turns} turns, every component used`);
}

/** The budget: at most MAX_BUDGET tokens, and the harness never had to stop the session. */
export function checkBudget(meter) {
	const failures = [];
	if (!(meter?.limit > 0) || meter.limit > MAX_BUDGET)
		failures.push(`budget ${meter?.limit} outside 1..${MAX_BUDGET}`);
	if (meter?.stopped) failures.push(`stopped at the budget: ${meter.used} of ${meter.limit} tokens`);
	else if (!(meter?.used <= meter?.limit)) failures.push(`${meter?.used} tokens > ${meter?.limit}`);
	return check("budget", failures, `${meter?.used} of ${meter?.limit} tokens`);
}

export function checkTaskChecker(verdict) {
	return check(
		"task.checker",
		verdict?.pass ? [] : (verdict?.failures ?? ["checker did not run"]),
		"fixture checker passed",
	);
}

/** Run every SC-LIVE invariant over one run record. */
export function evaluateLiveRun(record) {
	const checks = [
		checkResultsOncePerCall(record.entries),
		checkNoEngineError(record.events, record.entries),
		checkNoDanglingCall(record.events),
		checkHooksOncePerCall(record.hookTrace, record.entries, record.events, record.sessionTranscripts),
		checkReopen(record.reopen, record.entries, record.entriesAfterReopen),
		checkDeclarationsAcrossPlacements(record, record.otherPlacements, record.reference),
		checkNoMarkers(record.placement, record.events, record.entries),
		checkTaskShape(record),
		checkBudget(record.meter),
		checkTaskChecker(record.checker),
	];
	return { pass: checks.every((c) => c.pass), checks };
}
