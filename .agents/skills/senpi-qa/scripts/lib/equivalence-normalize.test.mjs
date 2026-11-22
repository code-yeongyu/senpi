import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createNormalizer, diffNormalized, directoryRoots } from "./equivalence-normalize.mjs";

const U1 = "01a18140-5eea-72cf-aab6-4bbe9aa427cc";
const U2 = "9d3636a4-3e1f-4346-9fa5-23e139d0478b";

test("uuids map one-to-one by first occurrence, inside any string", () => {
	const normalize = createNormalizer();
	const out = normalize({ a: U2, b: `session ${U1} after ${U2}`, c: [U1.toUpperCase()] });
	assert.deepEqual(out, { a: "<uuid:1>", b: "session <uuid:2> after <uuid:1>", c: ["<uuid:2>"] });
});

test("values under id keys map per namespace; distinct ids stay distinct and equal ids stay equal", () => {
	const normalize = createNormalizer();
	const out = normalize([
		{ id: "e46cfa05", parentId: null },
		{ id: "7db5c4e5", parentId: "e46cfa05", sessionId: U1 },
		{ toolCallId: "call_1", content: [{ type: "toolCall", id: "call_1" }] },
	]);
	assert.deepEqual(out, [
		{ id: "<id:1>", parentId: null },
		{ id: "<id:2>", parentId: "<id:1>", sessionId: "<uuid:1>" },
		{ toolCallId: "<id:3>", content: [{ type: "toolCall", id: "<id:3>" }] },
	]);
});

test("an id seen under an id key gets the same token where it is embedded in other text; word-like ids are not searched", () => {
	const normalize = createNormalizer();
	const out = normalize([{ id: "d1303e80" }, { turnKey: "1:d1303e80" }, { id: "reader" }, { text: "the reader" }]);
	assert.deepEqual(out, [{ id: "<id:1>" }, { turnKey: "1:<id:1>" }, { id: "<id:2>" }, { text: "the reader" }]);
});

test("a value under an id key that is not a bare uuid is one id, owner ids with a pid prefix included", () => {
	const normalize = createNormalizer();
	const out = normalize([{ ownerId: `47635:${U1}` }, { ownerId: `55542:${U1}` }, { sessionId: U1 }]);
	assert.deepEqual(out, [{ ownerId: "<id:1>" }, { ownerId: "<id:2>" }, { sessionId: "<uuid:1>" }]);
});

test("merged ids are visible: two different raw ids never share a token", () => {
	const normalize = createNormalizer();
	const distinct = normalize([{ id: "aaaa1111" }, { id: "bbbb2222" }]);
	const merged = normalize([{ id: "aaaa1111" }, { id: "aaaa1111" }]);
	assert.notDeepEqual(distinct, merged);
});

test("timestamps become their rank of appearance per namespace across ISO, file-name and date forms and epoch numbers", () => {
	const normalize = createNormalizer();
	const out = normalize({
		timestamp: "2026-10-28T06:44:04.205Z",
		since: "2026-10-28T06:44:01.898Z",
		file: "2026-10-28T06-44-01-898Z_x.jsonl",
		date: "<current_date>2026-10-28</current_date>",
		message: { timestamp: 1793169845436 },
		entries: [{ timestamp: "2026-10-28T06:44:09.000Z" }, { timestamp: "2026-10-28T06:44:08.000Z" }],
		count: 1793169845436,
	});
	assert.deepEqual(out, {
		timestamp: "<ts:timestamp:1>",
		since: "<ts:since:1>",
		file: "<ts:file:1>_x.jsonl",
		date: "<current_date><ts:date:1></current_date>",
		message: { timestamp: "<ts:message.timestamp:1>" },
		entries: [{ timestamp: "<ts:entries.timestamp:1>" }, { timestamp: "<ts:entries.timestamp:2>" }],
		count: 1793169845436,
	});
});

test("wall-clock values never cause a difference: ties, gaps and clock races normalize alike", () => {
	const normalize = createNormalizer();
	const tie = normalize([{ at: 1793169845436 }, { at: 1793169845436 }, { startedAtMs: 1793169845437 }]);
	const gap = normalize([{ at: 1793169845436 }, { at: 1793169845437 }, { startedAtMs: 1793169845436 }]);
	assert.deepEqual(tie, gap);
	assert.deepEqual(gap, [{ at: "<ts:at:1>" }, { at: "<ts:at:2>" }, { startedAtMs: "<ts:startedAtMs:1>" }]);
	assert.deepEqual(normalize([{ at: 1 }]), [{ at: 1 }]);
});

test("content-addressed blob ids map one-to-one by field, and only at those fields", () => {
	const normalize = createNormalizer();
	const out = normalize({
		id: "entry-1",
		conversationState: {
			rootPromptMessagesJson: ["L7/T3UHG6bQTLK3q=", "KJu71vy2TD317VOe="],
			turns: ["L7/T3UHG6bQTLK3q="],
		},
		spec: { turns: ["E12-FIRST"] },
	});
	assert.deepEqual(out, {
		id: "<id:1>",
		conversationState: { rootPromptMessagesJson: ["<id:2>", "<id:3>"], turns: ["<id:2>"] },
		spec: { turns: ["E12-FIRST"] },
	});
});

test("durations are dropped, measurement values become <measured> with their keys kept, nothing else changes", () => {
	const normalize = createNormalizer();
	const out = normalize({
		durationMs: 12,
		elapsed: 3,
		toolDurationMs: 9,
		generationMs: 25,
		queued_ms: 4,
		structuredContent: { exit_code: 0, wall_time_seconds: 0.1 },
		memory: { liveBytes: 7, rssBytes: 9, heapUsedBytes: 1, heapTotalBytes: 2, externalBytes: 3 },
		timeoutMs: 5000,
		text: "took 12ms",
	});
	assert.deepEqual(out, {
		structuredContent: { exit_code: 0 },
		memory: {
			liveBytes: "<measured>",
			rssBytes: "<measured>",
			heapUsedBytes: "<measured>",
			heapTotalBytes: "<measured>",
			externalBytes: "<measured>",
		},
		timeoutMs: 5000,
		text: "took 12ms",
	});
	// A measurement that appears in one observation and not the other is a difference.
	assert.equal(diffNormalized(normalize({ memory: { liveBytes: 7 } }), normalize({ memory: {} })).length, 1);
});

test("the detached-cell elapsed label in a status text becomes <elapsed>; nothing else in a status text changes", () => {
	const normalize = createNormalizer();
	// Every form the codemode eval-status formatter emits (formatElapsedSeconds), single- and multi-cell heads.
	const tokenized = [
		["↗ js · G4 detached nested calls (0s)", "↗ js · G4 detached nested calls (<elapsed>)"],
		["↗ js · G4 detached nested calls (1s)", "↗ js · G4 detached nested calls (<elapsed>)"],
		["↗ js · a cell that never finishes (59s)", "↗ js · a cell that never finishes (<elapsed>)"],
		["↗ py · cell (3m)", "↗ py · cell (<elapsed>)"],
		["↗ js · cell (2h)", "↗ js · cell (<elapsed>)"],
		["↗ js · cell (2h 30m)", "↗ js · cell (<elapsed>)"],
		["↗ eval 2: first, second (1d 2h 3m)", "↗ eval 2: first, second (<elapsed>)"],
	];
	for (const [statusText, expected] of tokenized)
		assert.equal(normalize({ statusText }).statusText, expected, statusText);
	const untouched = [
		"↗ js · queued cell (queued)",
		"↗ js · cell (1s) and more",
		"↗ js · cell (1m 2s)",
		"↗ js · cell (12ms)",
		"Sending (1s)",
		"Steering - reaches the agent at its next step",
		"",
	];
	for (const statusText of untouched) assert.equal(normalize({ statusText }).statusText, statusText, statusText);
	// Only the statusText field: the same text under another key is compared as produced.
	assert.equal(normalize({ text: "↗ js · cell (1s)" }).text, "↗ js · cell (1s)");
	// 0s and 1s of the same cell compare equal.
	assert.deepEqual(
		diffNormalized(normalize({ statusText: "↗ js · c (1s)" }), normalize({ statusText: "↗ js · c (0s)" })),
		[],
	);
});

test("roots and host facts are replaced longest first; other text is never masked", () => {
	const normalize = createNormalizer({
		roots: [
			{ prefix: "/tmp/run/box-ab12", token: "<sandbox>" },
			{ prefix: "/tmp/run", token: "<scratch>" },
			{ prefix: "http://127.0.0.1:50123", token: "<model-server>" },
			{ prefix: "", token: "<ignored>" },
		],
		hostFacts: [{ value: "Darwin 25.6.0", token: "<host:kernel>" }],
	});
	const out = normalize({
		cwd: "/tmp/run/box-ab12/work",
		other: "/tmp/run/elsewhere",
		url: "http://127.0.0.1:50123/v1/chat/completions",
		os: "- OS: darwin (kernel Darwin 25.6.0)",
		hex: "deadbeef cafe0001",
	});
	assert.deepEqual(out, {
		cwd: "<sandbox>/work",
		other: "<scratch>/elsewhere",
		url: "<model-server>/v1/chat/completions",
		os: "- OS: darwin (kernel <host:kernel>)",
		hex: "deadbeef cafe0001",
	});
});

test("a directory root reached through a symlink tokenizes in its allocated and its resolved form", (t) => {
	const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "eq-roots-")));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const real = join(scratch, "real");
	const link = join(scratch, "link");
	mkdirSync(real);
	symlinkSync(real, link);
	const normalize = createNormalizer({ roots: directoryRoots(link, "<sandbox>", { keyed: "<sandbox-key>" }) });
	assert.deepEqual(
		normalize({
			allocated: `${link}/work`,
			resolved: `${real}/work`,
			sessionKey: `--${real.replaceAll("/", "-")}-work--`,
		}),
		{ allocated: "<sandbox>/work", resolved: "<sandbox>/work", sessionKey: "--<sandbox-key>-work--" },
	);
});

test("token maps and ranks are scoped to one normalize() call", () => {
	const normalize = createNormalizer();
	assert.deepEqual(normalize({ id: "x1" }), { id: "<id:1>" });
	assert.deepEqual(normalize({ id: "y2" }), { id: "<id:1>" });
});

test("diffNormalized reports array order, missing keys and value changes by path", () => {
	assert.deepEqual(diffNormalized({ a: [1, 2], b: { c: 1 } }, { a: [1, 2], b: { c: 1 } }), []);
	assert.deepEqual(diffNormalized({ a: [1, 2] }, { a: [2, 1] }), [
		{ path: "$.a[0]", golden: 1, actual: 2 },
		{ path: "$.a[1]", golden: 2, actual: 1 },
	]);
	assert.deepEqual(diffNormalized({ a: 1 }, { a: 1, b: 2 }), [{ path: "$.b", golden: undefined, actual: 2 }]);
	assert.deepEqual(diffNormalized({ a: [1] }, { a: [] }), [{ path: "$.a[0]", golden: 1, actual: undefined }]);
});

// #5682 made a tool call's `session_lifecycle` (activity `tool`) follow the assistant `message_end` and `entry_appended`
// it reflects. A golden recorded before that change still has the lifecycle first; #5764 (E29) slipped through a manual
// re-record, so every golden on every platform is checked here. Only runs with a non-empty `events` stream count as checked.
function staleLifecycleOrder(goldenRoot) {
	const stale = [];
	let checked = 0;
	for (const platform of readdirSync(goldenRoot)) {
		for (const file of readdirSync(join(goldenRoot, platform)).filter((name) => /^E\d+\.json$/.test(name))) {
			const observations = JSON.parse(readFileSync(join(goldenRoot, platform, file), "utf8")).observations ?? {};
			for (const [key, runs] of Object.entries(observations)) {
				for (const [run, entry] of (Array.isArray(runs) ? runs : []).entries()) {
					const events = entry?.events;
					if (!Array.isArray(events) || events.length === 0) continue;
					checked += 1;
					for (let index = 0; index + 1 < events.length; index++) {
						const event = events[index];
						const next = events[index + 1];
						if (
							event?.type === "session_lifecycle" &&
							event.lifecycle?.activity?.kind === "tool" &&
							next?.type === "message_end" &&
							next.message?.role === "assistant"
						)
							stale.push(`${platform}/${file} ${key}[${run}].events[${index}]`);
					}
				}
			}
		}
	}
	return { checked, stale };
}

test("every EQ golden puts a tool-activity session_lifecycle after the assistant message_end it reflects", () => {
	const { checked, stale } = staleLifecycleOrder(
		join(dirname(fileURLToPath(import.meta.url)), "../../scenarios/fused-equivalence/golden"),
	);
	assert.ok(checked > 0, "no golden event streams were checked");
	assert.deepEqual(stale, []);
});

test("the golden order check counts only runs it actually inspected", () => {
	const root = mkdtempSync(join(tmpdir(), "eq-golden-order-"));
	try {
		mkdirSync(join(root, "linux-x64"));
		writeFileSync(join(root, "linux-x64", "E99.json"), JSON.stringify({ observations: { O6: [{}, { events: [] }], O1: [{ method: "GET" }] } }));
		assert.deepEqual(staleLifecycleOrder(root), { checked: 0, stale: [] });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
