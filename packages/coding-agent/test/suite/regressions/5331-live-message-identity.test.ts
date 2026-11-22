import { dirname } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { settledMember } from "../../../src/modes/rpc/compact-catalog-settled.ts";
import type { WireRecord } from "../rpc-session-status-support.ts";
import { compareAdmissionGoldens } from "./4272-admission-golden-support.ts";
import {
	assistantEnd,
	joinsOf,
	liveLines,
	liveRecords,
	liveRun,
	reconnect,
	recoveredRows,
	STAMP_KEYS,
} from "./5331-live-identity-support.ts";

// senpi#5331, RULING-120: with the compact-updates flag on, a `compact_events` peer's copy of a live `message_end`
// carries `messageId` + `terminalSequence`, `entry_appended` carries `owningMessageId` and `transcript_write_failed`
// carries `messageId`: the ids the settled overlay pages for that message. Every other copy keeps its bytes.

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ends = (records: readonly WireRecord[]) => records.filter((record) => record.type === "message_end");
const owned = (records: readonly WireRecord[]) =>
	records.filter((record) => record.type === "entry_appended" && record.owningMessageId !== undefined);
const entryId = (record: WireRecord) => (record.entry as { id?: unknown } | undefined)?.id;
/**
 * The golden's records: ends, failed writes and message entries (hook state entries carry per-run keys). How many
 * streaming records a run accepts varies, so `terminalSequence` is pinned as its rank among the run's stamped ends, and
 * the timing measure `generationMs` is dropped.
 */
function goldenRecords(records: readonly WireRecord[]): unknown[] {
	const ranks = [...new Set(records.map((record) => record.terminalSequence).filter((value) => value !== undefined))];
	const timeless = (value: unknown): unknown =>
		Array.isArray(value)
			? value.map(timeless)
			: typeof value === "object" && value !== null
				? Object.fromEntries(
						Object.entries(value)
							.filter(([key]) => key !== "generationMs")
							.map(([key, item]) => [
								key,
								key === "terminalSequence" ? ranks.indexOf(item) + 1 : timeless(item),
							]),
					)
				: value;
	return records
		.filter(
			(record) =>
				record.type !== "entry_appended" || (record.entry as { type?: unknown } | undefined)?.type === "message",
		)
		.map(timeless);
}

it("RULING-120 (2) #5331 the live message_end, entry_appended and transcript_write_failed join their settled overlay rows by id across a reconnect and a recovery cut", async () => {
	const run = await liveRun("1");
	try {
		const live = liveRecords(run.compact, run.routing);
		const refused = assistantEnd(live, "refused answer");
		const failed = live.find((record) => record.type === "transcript_write_failed") ?? expect.unreachable();
		expect(failed.messageId, "the failed write names the refused message").toBe(refused.messageId);
		expect(owned(live).map((record) => record.owningMessageId)).toContain(
			assistantEnd(live, "persisted answer").messageId,
		);
		await reconnect(run, "compact", "compact-again");
		const rows = await recoveredRows(run, "compact-again");
		const joins = joinsOf(rows);
		for (const entry of owned(live))
			expect(joins).toContainEqual({ messageId: entry.owningMessageId, entryId: entryId(entry) });
		for (const end of ends(live).filter((record) => record !== refused))
			expect(
				joins.map((join) => join.messageId),
				"every persisted message_end has its join row",
			).toContain(end.messageId);
		const terminalSequence = refused.terminalSequence;
		expect(typeof terminalSequence).toBe("number");
		expect(rows.get(`settled/${settledMember(Number(terminalSequence))}`)).toMatchObject({
			messageId: refused.messageId,
			terminalSequence,
			status: "failed",
		});
	} finally {
		await run.host[Symbol.asyncDispose]();
	}
}, 600_000);

it("RULING-120 (3) #5331 the ids are opaque, the same live and after recovery for the message's lifetime, and never reused", async () => {
	const run = await liveRun("1");
	try {
		const first = ends(liveRecords(run.compact, run.routing));
		const ids = first.map((record) => record.messageId);
		expect(ids.length, "the custom, user and assistant ends of three prompts").toBeGreaterThanOrEqual(6);
		expect(new Set(ids).size, "one id per message").toBe(ids.length);
		for (const id of ids) {
			expect(String(id)).toMatch(UUID);
			for (const text of ["first", "second", "third", "answer"]) expect(String(id)).not.toContain(text);
		}
		const sequences = first.map((record) => Number(record.terminalSequence));
		expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
		expect(new Set(sequences).size).toBe(sequences.length);
		const again = await reconnect(run, "compact", "compact-a");
		const before = await recoveredRows(run, "compact-a");
		await run.prompt("fourth", "later answer");
		const after = await recoveredRows(run, "compact-a");
		// Every member row keeps its id and value; the epoch's own `identity/identity` row moves with each record.
		for (const [key, value] of before)
			if (key !== "identity/identity") expect(after.get(key), `${key} kept its id and row`).toEqual(value);
		const fresh = ends(liveRecords(again, run.routing)).map((record) => record.messageId);
		expect(fresh.length, "the fourth prompt's ends").toBeGreaterThanOrEqual(2);
		for (const id of fresh) expect(ids, "a later message never reuses an id").not.toContain(id);
		expect(joinsOf(after).map((join) => join.messageId)).toEqual(expect.arrayContaining(fresh));
	} finally {
		await run.host[Symbol.asyncDispose]();
	}
}, 600_000);

it("RULING-120 (1) #5331 legacy and flag-off records keep their bytes; a flag-on compact copy is that line plus the stamp only", async () => {
	const on = await liveRun("1");
	try {
		const compact = liveLines(on.compact, on.routing);
		// The legacy opener also saw what the session wrote before the compact peer attached.
		const legacy = liveLines(on.legacy, on.routing).slice(-compact.length);
		expect(compact.map(({ record }) => record.type)).toEqual(legacy.map(({ record }) => record.type));
		for (const [index, { line, record }] of legacy.entries()) {
			for (const key of STAMP_KEYS) expect(record, `legacy ${record.type} has no ${key}`).not.toHaveProperty(key);
			const copy = compact[index] ?? expect.unreachable();
			const stamp = Object.fromEntries(
				STAMP_KEYS.filter((key) => key in copy.record).map((key) => [key, copy.record[key]]),
			);
			const expected = { message_end: ["messageId", "terminalSequence"], transcript_write_failed: ["messageId"] }[
				String(record.type)
			];
			if (expected) expect(Object.keys(stamp), `${record.type} stamp`).toEqual(expected);
			const suffix = Object.keys(stamp).length === 0 ? "" : `,${JSON.stringify(stamp).slice(1, -1)}`;
			expect(copy.line, `${record.type} bytes`).toBe(`${line.slice(0, -1)}${suffix}}`);
		}
		expect(owned(compact.map(({ record }) => record)).length).toBeGreaterThan(0);
	} finally {
		await on.host[Symbol.asyncDispose]();
	}
	vi.unstubAllEnvs();
	vi.useRealTimers();
	const off = await liveRun("0");
	try {
		const compact = liveLines(off.compact, off.routing);
		const legacy = liveLines(off.legacy, off.routing).slice(-compact.length);
		expect(compact.length).toBeGreaterThan(0);
		expect(
			compact.map(({ line }) => line),
			"flag off: the same bytes",
		).toEqual(legacy.map(({ line }) => line));
		for (const { record } of legacy) for (const key of STAMP_KEYS) expect(record).not.toHaveProperty(key);
	} finally {
		await off.host[Symbol.asyncDispose]();
	}
}, 600_000);

it("RULING-120 (5) #5331 golden i: the live records a compact peer receives beside a legacy peer's", async () => {
	const run = await liveRun("1");
	try {
		await compareAdmissionGoldens(
			{
				"i-live-identity.json": {
					compact: goldenRecords(liveRecords(run.compact, run.routing)),
					legacy: goldenRecords(liveRecords(run.legacy, run.routing)),
				},
			},
			dirname(run.host.cwd),
		);
	} finally {
		await run.host[Symbol.asyncDispose]();
	}
}, 600_000);
