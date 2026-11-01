import { dirname } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { WireRecord } from "../rpc-session-status-support.ts";
import { compareAdmissionGoldens } from "./4272-admission-golden-support.ts";
import {
	CALL_STAMPS,
	type CallRun,
	callLines,
	callName,
	callRecords,
	callRun,
	compactCalls,
	GHOST,
	REUSED,
	rowsOf,
} from "./5346-live-call-identity-support.ts";

// senpi#5346, RULING-123: with the compact-updates flag on, a `compact_events` peer's copy of a live call record
// (`toolcall_*` updates, `tool_execution_start/update/end`, `tool_hook_status`) carries the `runtimeItemKey` of the
// call the host changed with it, the key that call's snapshot entry carries, or `callUnknown: true` when the host
// changed no call. Every other copy keeps its bytes.

let run: CallRun;
beforeAll(async () => {
	run = await callRun("1");
}, 600_000);
afterAll(async () => {
	await run?.host[Symbol.asyncDispose]();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const TEST_EXTENSION = "<inline:1>";
const callsOf = (name: string) => compactCalls(run).filter((record) => callName(record) === name);
const keysOf = (records: readonly WireRecord[]) => [...new Set(records.map((record) => record.runtimeItemKey))];
const streamKind = (record: WireRecord) => (record.assistantMessageEvent as { type?: unknown } | undefined)?.type;
const kindOf = (record: WireRecord) => String(streamKind(record) ?? record.type);
const terminalOf = (row: Record<string, unknown>) =>
	(row.payload as { terminal?: Record<string, unknown> } | undefined)?.terminal;

/**
 * The golden's records: every call record except `toolcall_delta` (its chunking is the provider's), hooks of the test
 * extension only (builtin hooks come and go with the builtin set). Keys are pinned as their rank and `hookRunId`
 * (a host-wide hook counter) is masked; the snapshot rows keep the fields that identify their call.
 */
function golden(): unknown {
	const keep = (record: WireRecord) =>
		streamKind(record) !== "toolcall_delta" &&
		(record.type !== "tool_hook_status" || record.extensionPath === TEST_EXTENSION);
	const compact = compactCalls(run).filter(keep);
	const ranks: unknown[] = [
		...new Set(compact.map((record) => record.runtimeItemKey).filter((key) => key !== undefined)),
	];
	const rank = (key: unknown) => `call-${ranks.indexOf(key) + 1}`;
	const pinned = (record: WireRecord): WireRecord => ({
		...record,
		...("hookRunId" in record ? { hookRunId: "<hook-run>" } : {}),
		...("runtimeItemKey" in record ? { runtimeItemKey: rank(record.runtimeItemKey) } : {}),
	});
	return {
		compact: compact.map(pinned),
		legacy: callRecords(run.legacy, run.routing).filter(keep).map(pinned),
		snapshot: {
			calls: rowsOf(run, "calls").map((row) => ({
				runtimeItemKey: rank(row.runtimeItemKey),
				toolCallId: row.toolCallId,
				requestedName: row.requestedName,
				phase: row.phase,
			})),
			settled: rowsOf(run, "settled").map((row) => ({
				runtimeItemKey: rank(row.runtimeItemKey),
				role: row.role,
				status: row.status,
				toolCallId: terminalOf(row)?.toolCallId,
			})),
		},
	};
}

it("RULING-123 (2) #5346 golden j: live call records join their snapshot entries by runtimeItemKey across a reconnect", async () => {
	const [readKey] = keysOf(callsOf("read"));
	const [probeKey] = keysOf(callsOf("probe"));
	const probe = (records: readonly WireRecord[]) => records.filter((record) => callName(record) === "probe");
	expect(keysOf(probe(callRecords(run.compact, run.routing))), "before the reconnect").toEqual([probeKey]);
	expect(keysOf(probe(callRecords(run.again, run.routing))), "after the reconnect").toEqual([probeKey]);
	expect(rowsOf(run, "calls")).toEqual([
		expect.objectContaining({ runtimeItemKey: probeKey, toolCallId: REUSED, phase: "executing" }),
	]);
	expect(rowsOf(run, "settled").find((row) => row.runtimeItemKey === readKey)).toMatchObject({
		role: "toolResult",
		status: "failed",
	});
	await compareAdmissionGoldens({ "j-live-call-identity.json": golden() }, dirname(run.host.cwd));
}, 600_000);

it("RULING-123 (3) #5346 a call's key is opaque, the same on every record for the call's lifetime, and never reused", () => {
	const keys = ["read", "probe"].map((name) => {
		const records = callsOf(name);
		const [key, ...others] = keysOf(records);
		expect(others, `${name}: one key on every record`).toEqual([]);
		expect(typeof key).toBe("string");
		for (const text of [REUSED, name, "note", "two"]) expect(String(key)).not.toContain(text);
		return key;
	});
	expect(new Set(keys).size, "one key per call").toBe(keys.length);
	expect(new Set(callsOf("probe").map(kindOf))).toEqual(
		new Set([
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"tool_execution_start",
			"tool_hook_status",
			"tool_execution_update",
			"tool_execution_end",
		]),
	);
	const cut = [...rowsOf(run, "calls"), ...rowsOf(run, "settled")].map((row) => row.runtimeItemKey);
	expect(new Set(cut), "every key the snapshot pages is a live call's key").toEqual(new Set(keys));
});

it("RULING-123 (6) #5346 two calls reusing one toolCallId get different keys, and each live record joins its own entry", () => {
	const read = callsOf("read");
	const probe = callsOf("probe");
	const started = (records: readonly WireRecord[]) =>
		records.find((record) => record.type === "tool_execution_start")?.toolCallId;
	expect([started(read), started(probe)]).toEqual([REUSED, REUSED]);
	const [readKey] = keysOf(read);
	const [probeKey] = keysOf(probe);
	expect(readKey).not.toBe(probeKey);
	const entries = new Map(
		[...rowsOf(run, "calls"), ...rowsOf(run, "settled")].map((row) => [row.runtimeItemKey, row] as const),
	);
	for (const record of read)
		expect(terminalOf(entries.get(record.runtimeItemKey) ?? {}), kindOf(record)).toMatchObject({
			toolCallId: REUSED,
			toolName: "read",
		});
	for (const record of probe)
		expect(entries.get(record.runtimeItemKey), kindOf(record)).toMatchObject({
			toolCallId: REUSED,
			requestedName: "probe",
		});
});

it("RULING-123 (7) #5346 a hook record that belongs to no call says callUnknown; every other call record names its call", () => {
	const ghost = callsOf(GHOST);
	expect(ghost.length).toBeGreaterThan(0);
	for (const record of ghost) {
		expect(record).toMatchObject({ type: "tool_hook_status", toolCallId: GHOST, callUnknown: true });
		expect(record).not.toHaveProperty("runtimeItemKey");
	}
	for (const record of compactCalls(run).filter((item) => callName(item) !== GHOST)) {
		expect(typeof record.runtimeItemKey, kindOf(record)).toBe("string");
		expect(record).not.toHaveProperty("callUnknown");
	}
	const legacyGhost = callRecords(run.legacy, run.routing).filter((record) => callName(record) === GHOST);
	expect(legacyGhost.length).toBe(ghost.length);
	for (const record of legacyGhost) for (const key of CALL_STAMPS) expect(record).not.toHaveProperty(key);
});

it("RULING-123 (1) #5346 legacy and flag-off call records keep their bytes; a flag-on compact copy is that line plus the stamp only", async () => {
	const legacy = callLines(run.legacy, run.routing);
	const legacyBytes = new Set(legacy.map(({ line }) => line));
	const compact = [...callLines(run.compact, run.routing), ...callLines(run.again, run.routing)];
	expect(compact.length).toBeGreaterThan(0);
	for (const { line, record } of compact) {
		const stamp = Object.fromEntries(CALL_STAMPS.filter((key) => key in record).map((key) => [key, record[key]]));
		expect(Object.keys(stamp), `${kindOf(record)} carries one stamp`).toHaveLength(1);
		const suffix = `,${JSON.stringify(stamp).slice(1, -1)}}`;
		expect(line.endsWith(suffix), `${kindOf(record)} ends with its stamp`).toBe(true);
		expect(legacyBytes.has(`${line.slice(0, -suffix.length)}}`), `${kindOf(record)} bytes`).toBe(true);
	}
	for (const { record } of legacy) for (const key of CALL_STAMPS) expect(record).not.toHaveProperty(key);
	const off = await callRun("0");
	try {
		const offLegacy = new Set(callLines(off.legacy, off.routing).map(({ line }) => line));
		const offCompact = [...callLines(off.compact, off.routing), ...callLines(off.again, off.routing)];
		expect(offCompact.length).toBeGreaterThan(0);
		for (const { line, record } of offCompact) {
			expect(offLegacy.has(line), `flag off: ${kindOf(record)} keeps its bytes`).toBe(true);
			for (const key of CALL_STAMPS) expect(record).not.toHaveProperty(key);
		}
	} finally {
		await off.host[Symbol.asyncDispose]();
	}
}, 600_000);
