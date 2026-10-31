import assert from "node:assert/strict";
import test from "node:test";
import {
	checkBudget,
	checkDeclarationsAcrossPlacements,
	checkHooksOncePerCall,
	checkNoDanglingCall,
	checkNoEngineError,
	checkNoMarkers,
	checkReopen,
	checkResultsOncePerCall,
	checkTaskChecker,
	checkTaskShape,
	evaluateLiveRun,
	MAX_BUDGET,
	nestedCalls,
} from "./live-invariants.mjs";

const assistant = (id, calls, extra = {}) => ({
	type: "message",
	id,
	message: {
		role: "assistant",
		content: calls.map(([callId, name]) => ({ type: "toolCall", id: callId, name, arguments: {} })),
		stopReason: "toolUse",
		...extra,
	},
});
const result = (id, toolCallId, isError = false) => ({
	type: "message",
	id,
	message: { role: "toolResult", toolCallId, isError },
});
const custom = (id) => ({ type: "custom", id, customType: "pi-rules.scan" });
const hooks = (...ids) =>
	ids.flatMap((toolCallId) => [
		{ event: "PreToolUse", toolCallId },
		{ event: "PostToolUse", toolCallId },
	]);
const started = (...ids) =>
	ids.flatMap((toolCallId) => [
		{ type: "tool_execution_start", toolCallId },
		{ type: "tool_execution_end", toolCallId },
	]);

/** A transcript that meets the task shape: 32 calls over 8 turns, every component used. */
function goodRun() {
	const calls = [
		["r1", "read"],
		["r2", "read"],
		["b1", "bash"],
		["b2", "bash"],
		["e1", "edit"],
		["m1", "mcp_fx_tool_1"],
		["q1", "ask_user_question"],
		["d1", "parse_duration"],
		["t1", "task"],
		...Array.from({ length: 23 }, (_, index) => [`x${index}`, "read"]),
	];
	const entries = [custom("c0")];
	const groups = [calls.slice(0, 2), ...calls.slice(2).map((call) => [call])];
	groups.forEach((group, index) => {
		entries.push(assistant(`a${index}`, group));
		for (const [callId] of group) entries.push(result(`res-${callId}`, callId));
	});
	const ids = calls.map(([id]) => id);
	return {
		placement: "fused",
		entries,
		entriesAfterReopen: [...entries, custom("after")],
		events: started(...ids),
		hookTrace: hooks(...ids),
		turns: 8,
		questions: { asked: 1, answered: 1 },
		meter: { limit: MAX_BUDGET, used: 1000, stopped: false },
		reopen: { before: { sessionId: "s1", messageCount: 10 }, after: { sessionId: "s1", messageCount: 10 } },
		observations: { O3: [{ name: "read" }], O4: { "user-agent": "x" } },
		otherPlacements: [],
		checker: { pass: true, failures: [] },
	};
}

test("a run meeting every SC-LIVE invariant passes", () => {
	const verdict = evaluateLiveRun(goodRun());
	assert.deepEqual(
		verdict.checks.filter((c) => !c.pass),
		[],
	);
	assert.equal(verdict.pass, true);
});

test("B4: a missing, duplicated or reordered result fails", () => {
	const missing = [
		assistant("a", [
			["c1", "read"],
			["c2", "read"],
		]),
		result("r1", "c1"),
	];
	assert.equal(checkResultsOncePerCall(missing).pass, false);
	const twice = [assistant("a", [["c1", "read"]]), result("r1", "c1"), result("r2", "c1")];
	assert.equal(checkResultsOncePerCall(twice).pass, false);
	const reordered = [
		assistant("a", [
			["c1", "read"],
			["c2", "read"],
		]),
		result("r2", "c2"),
		result("r1", "c1"),
	];
	assert.match(checkResultsOncePerCall(reordered).detail.join(), /calls are \[c1,c2\]/);
	const orphan = [result("r1", "nope")];
	assert.equal(checkResultsOncePerCall(orphan).pass, false);
	const ordered = [
		assistant("a", [
			["c1", "read"],
			["c2", "read"],
		]),
		result("r1", "c1"),
		result("r2", "c2"),
	];
	assert.equal(checkResultsOncePerCall(ordered).pass, true);
});

test("an engine error event or an errored assistant message fails", () => {
	assert.equal(checkNoEngineError([{ type: "extension_error" }], []).pass, false);
	assert.equal(checkNoEngineError([{ type: "message_end", message: { stopReason: "error" } }], []).pass, false);
	assert.equal(checkNoEngineError([], [assistant("a", [], { stopReason: "error" })]).pass, false);
	assert.equal(checkNoEngineError([{ type: "message_end", message: { stopReason: "stop" } }], []).pass, true);
});

test("a call that started and never ended is dangling", () => {
	assert.equal(checkNoDanglingCall([{ type: "tool_execution_start", toolCallId: "c1" }]).pass, false);
	assert.equal(checkNoDanglingCall(started("c1")).pass, true);
});

test("an end without a matching start is a violation and does not close another running call", () => {
	const events = [
		{ type: "tool_execution_start", toolCallId: "ev1" },
		{ type: "tool_execution_end", toolCallId: "ghost" },
		{ type: "tool_hook_status", toolCallId: "cm-1", toolName: "bash" },
		{ type: "tool_execution_end", toolCallId: "ev1" },
	];
	assert.deepEqual(checkNoDanglingCall(events).detail, ["call ghost ended without a start"]);
	assert.deepEqual(nestedCalls(events), [{ id: "cm-1", name: "bash", parentId: "ev1" }]);
});

test("G1: a hook missing, firing twice, or firing for an unknown call fails; nested calls count", () => {
	const entries = [assistant("a", [["c1", "read"]]), result("r1", "c1")];
	assert.equal(checkHooksOncePerCall(hooks("c1"), entries, []).pass, true);
	assert.equal(checkHooksOncePerCall([{ event: "PreToolUse", toolCallId: "c1" }], entries, []).pass, false);
	assert.equal(
		checkHooksOncePerCall([...hooks("c1"), { event: "PostToolUse", toolCallId: "c1" }], entries, []).pass,
		false,
	);
	assert.equal(checkHooksOncePerCall([...hooks("c1"), ...hooks("ghost")], entries, []).pass, false);
	const nested = [{ type: "tool_execution_start", toolCallId: "n1", parentToolCallId: "c1" }];
	assert.equal(checkHooksOncePerCall(hooks("c1"), entries, nested).pass, false);
	assert.equal(checkHooksOncePerCall(hooks("c1", "n1"), entries, nested).pass, true);
});

test("calls run inside an eval cell are attributed to the running call and need their own hooks", () => {
	const events = [
		{ type: "tool_execution_start", toolCallId: "ev1" },
		{ type: "tool_hook_status", toolCallId: "ev1", toolName: "eval" },
		{ type: "tool_hook_status", toolCallId: "cm-1", toolName: "bash" },
		{ type: "tool_execution_end", toolCallId: "ev1" },
	];
	assert.deepEqual(nestedCalls(events), [{ id: "cm-1", name: "bash", parentId: "ev1" }]);
	const entries = [assistant("a", [["ev1", "eval"]]), result("r1", "ev1")];
	assert.equal(checkHooksOncePerCall(hooks("ev1"), entries, events).pass, false);
	assert.equal(checkHooksOncePerCall(hooks("ev1", "cm-1"), entries, events).pass, true);
});

test("bash inside eval cells of two different calls counts as sequential bash; one cell does not", () => {
	const run = goodRun();
	const noDirectBash = run.entries.map((entry) =>
		entry.id === "a1"
			? assistant("a1", [["b1", "eval"]])
			: entry.id === "a2"
				? assistant("a2", [["b2", "eval"]])
				: entry,
	);
	const cell = (parent, id) => [
		{ type: "tool_execution_start", toolCallId: parent },
		{ type: "tool_hook_status", toolCallId: id, toolName: "bash" },
		{ type: "tool_execution_end", toolCallId: parent },
	];
	const two = [...cell("b1", "cm-1"), ...cell("b2", "cm-2")];
	assert.equal(checkTaskShape({ ...run, entries: noDirectBash, events: two }).pass, true);
	const one = [...cell("b1", "cm-1"), { type: "tool_hook_status", toolCallId: "cm-2", toolName: "bash" }];
	assert.match(checkTaskShape({ ...run, entries: noDirectBash, events: one }).detail.join(), /sequential bash/);
});

test("O7: a new durable id, a changed message count, an empty or rewritten transcript fails", () => {
	const entries = [custom("e1"), custom("e2")];
	const same = { before: { sessionId: "s", messageCount: 3 }, after: { sessionId: "s", messageCount: 3 } };
	assert.equal(checkReopen(same, entries, [...entries, custom("e3")]).pass, true);
	assert.equal(checkReopen({ ...same, after: { sessionId: "t", messageCount: 3 } }, entries, entries).pass, false);
	assert.equal(checkReopen({ ...same, after: { sessionId: "s", messageCount: 2 } }, entries, entries).pass, false);
	assert.equal(checkReopen(same, [], []).pass, false);
	assert.equal(checkReopen(same, entries, [custom("e1"), custom("x")]).pass, false);
});

test("O3/O4 differences against another placement or the fused reference fail", () => {
	const own = { placement: "fused", observations: { O3: [{ name: "read" }], O4: { a: "1" } } };
	assert.equal(checkDeclarationsAcrossPlacements(own, [], undefined).pass, true);
	assert.equal(checkDeclarationsAcrossPlacements(own, [], { O3: [{ name: "read" }], O4: { a: "1" } }).pass, true);
	assert.equal(checkDeclarationsAcrossPlacements(own, [], { O3: [{ name: "bash" }], O4: { a: "1" } }).pass, false);
	const other = { placement: "split-local", observations: { O3: [{ name: "read" }], O4: { a: "2" } } };
	assert.match(
		checkDeclarationsAcrossPlacements(own, [other], undefined).detail.join(),
		/O4 differs from placement split-local/,
	);
});

test("uncertain, hand_restarted or an abort on fused or split-local fails; prose and other placements do not", () => {
	assert.equal(checkNoMarkers("fused", [{ type: "x", failure: { delivery: "uncertain" } }], []).pass, false);
	assert.equal(checkNoMarkers("split-local", [{ type: "hand_restarted" }], []).pass, false);
	assert.equal(checkNoMarkers("fused", [], [assistant("a", [], { stopReason: "aborted" })]).pass, false);
	assert.equal(
		checkNoMarkers(
			"fused",
			[{ type: "message_end", message: { content: [{ type: "text", text: "uncertain" }] } }],
			[],
		).pass,
		true,
	);
	assert.equal(checkNoMarkers("split-remote", [{ type: "hand_restarted" }], []).pass, true);
});

test("the task shape needs 30 calls over 8 turns and every component", () => {
	const run = goodRun();
	assert.equal(checkTaskShape(run).pass, true);
	assert.match(checkTaskShape({ ...run, turns: 7 }).detail.join(), /7 turns < 8/);
	assert.match(checkTaskShape({ ...run, entries: run.entries.slice(0, 20) }).detail.join(), /tool calls < 30/);
	assert.match(
		checkTaskShape({ ...run, questions: { asked: 1, answered: 0 } }).detail.join(),
		/question answered over RPC/,
	);
	const failedTask = run.entries.map((entry) =>
		entry.message?.toolCallId === "t1" ? result(entry.id, "t1", true) : entry,
	);
	assert.match(checkTaskShape({ ...run, entries: failedTask }).detail.join(), /missing a sub-agent/);
	const serialReads = run.entries.map((entry) => (entry.id === "a0" ? assistant("a0", [["r1", "read"]]) : entry));
	assert.match(checkTaskShape({ ...run, entries: serialReads }).detail.join(), /parallel reads/);
});

test("the budget: a stopped session, an overrun, or a budget above 1,000,000 fails", () => {
	assert.equal(checkBudget({ limit: MAX_BUDGET, used: MAX_BUDGET, stopped: false }).pass, true);
	assert.equal(checkBudget({ limit: MAX_BUDGET, used: 1_200_000, stopped: true }).pass, false);
	assert.equal(checkBudget({ limit: 100, used: 101, stopped: false }).pass, false);
	assert.equal(checkBudget({ limit: MAX_BUDGET + 1, used: 1, stopped: false }).pass, false);
});

test("the fixture checker's verdict decides task.checker", () => {
	assert.equal(checkTaskChecker({ pass: true, failures: [] }).pass, true);
	assert.deepEqual(checkTaskChecker({ pass: false, failures: ["tests: node --test exited 1"] }).detail, [
		"tests: node --test exited 1",
	]);
	assert.equal(checkTaskChecker(undefined).pass, false);
});
