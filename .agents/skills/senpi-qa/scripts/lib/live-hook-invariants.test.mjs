import assert from "node:assert/strict";
import test from "node:test";
import { checkHooksOncePerCall } from "./live-hook-invariants.mjs";
import { assistant, hooks, result, started } from "./live-test-fixtures.mjs";
import { nestedCalls } from "./live-transcript.mjs";

// senpi#5128: a shared hook trace must be joined by session AND call, never by call alone.
const parentEntries = [{ type: "session", id: "s1" }, assistant("a", [["c1", "read"]]), result("r1", "c1")];
const childEntries = [{ type: "session", id: "child" }, assistant("b", [["c1", "read"]]), result("r2", "c1")];
const childHooks = hooks("c1").map((line) => ({ ...line, session_id: "child" }));
for (const { name, trace, children = [], events = [], pass, failure } of [
	{ name: "parent-only calls", trace: hooks("c1"), pass: true },
	{ name: "sub-agent calls in their own session, even with the same call id", trace: [...hooks("c1"), ...childHooks],
		children: [{ entries: childEntries }], pass: true },
	{ name: "phantom id", trace: [...hooks("c1"), ...hooks("ghost")], pass: false, failure: /unknown call ghost/ },
	{ name: "duplicate Pre", trace: [...hooks("c1"), hooks("c1")[0]], pass: false, failure: /PreToolUse fired 2 times/ },
	{ name: "missing Post", trace: [hooks("c1")[0]], pass: false, failure: /PostToolUse fired 0 times/ },
	{ name: "unknown session", trace: [...hooks("c1"), ...childHooks], pass: false, failure: /unknown session child/ },
	{ name: "missing session attribution", trace: hooks("c1").map(({ session_id, ...line }) => line),
		pass: false, failure: /unknown session/ },
	{ name: "call in the wrong session", trace: [...hooks("c1"), ...hooks("ghost").map((line) => ({ ...line, session_id: "child" }))],
		children: [{ entries: childEntries }], pass: false, failure: /unknown call ghost in session child/ },
	{ name: "child with missing Post", trace: [...hooks("c1"), childHooks[0]], children: [{ entries: childEntries }],
		pass: false, failure: /PostToolUse fired 0 times for c1 in session child/ },
	{ name: "execution start cannot legitimize a phantom transcript call", trace: [...hooks("c1"), ...hooks("ghost")],
		events: started("ghost"), pass: false, failure: /unknown call ghost/ },
]) {
	test(`G1 per session: ${name}`, () => {
		const verdict = checkHooksOncePerCall(trace, parentEntries, events, children);
		assert.equal(verdict.pass, pass);
		if (failure) assert.match(verdict.detail.join("; "), failure);
	});
}

test("non-eval nested ids require an owning session and its once-per-call hooks", () => {
	const entries = [{ type: "session", id: "s1" }, assistant("a", [["task1", "task"]])];
	const events = [
		{ type: "tool_execution_start", toolCallId: "task1" },
		{ type: "tool_hook_status", toolCallId: "c1", toolName: "read" },
		{ type: "tool_execution_end", toolCallId: "task1" },
	];
	const missing = checkHooksOncePerCall(hooks("task1"), entries, events);
	assert.equal(missing.pass, false);
	assert.match(missing.detail.join("; "), /nested call c1 has no owning session/);
	assert.equal(checkHooksOncePerCall([...hooks("task1"), ...childHooks], entries, events,
		[{ entries: childEntries }]).pass, true);
	assert.equal(checkHooksOncePerCall([...hooks("task1"), childHooks[0]], entries, events,
		[{ entries: childEntries }]).pass, false);
	assert.equal(checkHooksOncePerCall([...hooks("task1"), ...childHooks, childHooks[0]], entries, events,
		[{ entries: childEntries }]).pass, false);
});

test("child eval calls use only that session's independent engine evidence", () => {
	const entries = [
		{ type: "session", id: "child" },
		assistant("a", [["ev-child", "eval"]]),
		{ ...result("r", "ev-child"), message: {
			...result("r", "ev-child").message,
			details: { toolCalls: [{ callId: "kernel-local", name: "read", ok: true }] },
		} },
		{ type: "custom", customType: "live-tool-call", data: { id: "cm-child", name: "read" } },
	];
	const trace = hooks("ev-child", "cm-child").map((line) => ({ ...line, session_id: "child" }));
	assert.equal(checkHooksOncePerCall([...hooks("c1"), ...trace], parentEntries, [], [{ entries }]).pass, true);
	assert.equal(checkHooksOncePerCall([...hooks("c1"), ...trace.slice(0, -1)], parentEntries, [],
		[{ entries }]).pass, false);
	assert.equal(checkHooksOncePerCall([...hooks("c1"), ...trace, trace[2]], parentEntries, [],
		[{ entries }]).pass, false);
	assert.equal(checkHooksOncePerCall([...hooks("c1"), ...trace, ...hooks("cm-child")], parentEntries, [],
		[{ entries }]).pass, false);
	const forged = entries.filter((entry) => entry.customType !== "live-tool-call");
	assert.equal(checkHooksOncePerCall([...hooks("c1"), ...trace], parentEntries, [],
		[{ entries: forged }]).pass, false);
	const unknown = hooks("ghost").map((line) => ({ ...line, session_id: "child" }));
	assert.equal(checkHooksOncePerCall([...hooks("c1"), ...trace, ...unknown], parentEntries, [],
		[{ entries }]).pass, false);
	const kernel = hooks("kernel-local").map((line) => ({ ...line, session_id: "child" }));
	assert.equal(checkHooksOncePerCall([...hooks("c1"), ...trace, ...kernel], parentEntries, [],
		[{ entries }]).pass, false);
});

test("calls run inside an eval cell are attributed to the running call and need their own hooks", () => {
	const events = [
		{ type: "tool_execution_start", toolCallId: "ev1" },
		{ type: "tool_hook_status", toolCallId: "ev1", toolName: "eval" },
		{ type: "tool_hook_status", toolCallId: "cm-1", toolName: "bash" },
		{ type: "tool_execution_end", toolCallId: "ev1" },
	];
	assert.deepEqual(nestedCalls(events), [{ id: "cm-1", name: "bash", parentId: "ev1" }]);
	const entries = [{ type: "session", id: "s1" }, assistant("a", [["ev1", "eval"]]), result("r1", "ev1")];
	assert.equal(checkHooksOncePerCall(hooks("ev1"), entries, events).pass, false);
	assert.equal(checkHooksOncePerCall(hooks("ev1", "cm-1"), entries, events).pass, true);
});

// LEAD ruling (a) on senpi#5093: G1 covers user-visible sessions. A facts-recorder session that omo's memory starts on
// its own (taskId = parentSessionId = rootSessionId = `facts-<runId>`, cwd = the run dir) is a REPORTED exclusion;
// a session with any other or a partial origin is still checked.
const FACTS_RUN = "facts-0123456789ab-1";
const factsAncestry = { parentSessionId: `facts-${FACTS_RUN}`, rootSessionId: `facts-${FACTS_RUN}`, taskId: `facts-${FACTS_RUN}` };
const header = (id, extra = {}) => ({ type: "session", id, cwd: "/box/work", ...extra });
const taskChild = [header("child", { spawnedBy: { parentSessionId: "s1", rootSessionId: "s1", taskId: "st_child" } }),
	assistant("b", [["c1", "read"]]), result("r2", "c1")];
const memory = [header("mem", { cwd: `/box/.omo/memory/agents/a/runtime/facts/runs/${FACTS_RUN}`, spawnedBy: factsAncestry }),
	assistant("m", [["f1", "record_fact"]]), result("rm", "f1")];
const odd = (extra) => [header("odd", extra), assistant("o", [["o1", "read"]]), result("ro", "o1")];
const memoryExcluded = { origin: "omo-memory-facts", count: 1, sessions: ["mem"] };

test("G1 excludes and reports a memory facts session; parent and task sub-agent stay once per call", () => {
	const trace = [...hooks("c1"), ...childHooks];
	const verdict = checkHooksOncePerCall(trace, parentEntries, [], [{ entries: taskChild }, { entries: memory }]);
	assert.deepEqual(verdict.detail, "2 calls in 2 sessions, Pre and Post once each; excluded 1 omo-memory-facts session(s): mem");
	assert.equal(verdict.pass, true);
	assert.deepEqual(verdict.excluded, memoryExcluded);
	const noChildPost = checkHooksOncePerCall([...hooks("c1"), childHooks[0]], parentEntries, [],
		[{ entries: taskChild }, { entries: memory }]);
	assert.match(noChildPost.detail.join("; "), /PostToolUse fired 0 times for c1 in session child/);
	assert.deepEqual(noChildPost.excluded, memoryExcluded);
	const parentTwice = checkHooksOncePerCall([...trace, hooks("c1")[0]], parentEntries, [], [{ entries: memory }]);
	assert.match(parentTwice.detail.join("; "), /PreToolUse fired 2 times for c1 in session s1/);
	assert.deepEqual(checkHooksOncePerCall(trace, parentEntries, [], [{ entries: taskChild }]).excluded,
		{ origin: "omo-memory-facts", count: 0, sessions: [] });
});

for (const [name, extra] of [
	["no spawnedBy", {}],
	["a facts task id under a real parent", { spawnedBy: { ...factsAncestry, parentSessionId: "s1", rootSessionId: "s1" } }],
	["a facts ancestry whose cwd is another run", { cwd: "/box/runs/facts-ffffffffffff-2", spawnedBy: factsAncestry }],
	["a kibitzer sidecar", { spawnedBy: { parentSessionId: "s1", rootSessionId: "s1", taskId: "kibitzer-s1-1" } }],
]) {
	test(`G1 still fails an unknown-origin session without hooks: ${name}`, () => {
		const verdict = checkHooksOncePerCall([...hooks("c1")], parentEntries, [], [{ entries: memory }, { entries: odd(extra) }]);
		assert.equal(verdict.pass, false);
		assert.deepEqual(verdict.detail, ["PreToolUse fired 0 times for o1 in session odd", "PostToolUse fired 0 times for o1 in session odd"]);
		assert.deepEqual(verdict.excluded, memoryExcluded);
	});
}
