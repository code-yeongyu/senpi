// senpi#6594: one session's retained-record writes and clears land in the order they were issued.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { clearHandoverParkedSession, readHandoverParkedSessions } from "../../../src/modes/rpc/host-handover-parked.ts";
import type { RouterContext } from "../../../src/modes/rpc/session-router-context.ts";
import {
	clearRetainedRecord,
	followRetainedRecord,
	recordRetainedSession,
} from "../../../src/modes/rpc/session-router-residency.ts";
import type { RpcSessionEntry } from "../../../src/modes/rpc/session-registry-types.ts";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function switchedSession() {
	const root = await mkdtemp(join(tmpdir(), "retained-record-order-"));
	dirs.push(root);
	const before = join(root, "before.jsonl");
	const after = join(root, "after.jsonl");
	const entry = {
		sessionId: "session-a",
		sessionPath: after,
		recordedPath: before,
		retainOnDisconnect: true,
		state: "open",
		durableSessionId: "durable-a",
	} as unknown as RpcSessionEntry;
	const host = {
		handoverParkedDir: root,
		defaults: {},
		registry: { peek: () => entry },
	} as unknown as RouterContext;
	await recordRetainedSession(host, { ...entry, recordedPath: undefined } as RpcSessionEntry, before, true);
	return { root, host, entry, after };
}

it("a park issued while a switched session's stamped record is still clearing its old entry stays unstamped", async () => {
	const { root, host, entry, after } = await switchedSession();

	followRetainedRecord(host, "session-a");
	await recordRetainedSession(host, entry, after, false);
	// The record queue is FIFO: one more queued mutation settles after every write issued before it.
	await clearHandoverParkedSession(root, join(root, "never-recorded.jsonl"));

	const records = await readHandoverParkedSessions(root);
	expect(
		records.map((record) => ({ path: record.sessionPath, stamped: record.residentWriter !== undefined })),
	).toEqual([{ path: after, stamped: false }]);
});

it("a close issued while a switched session's stamped record is still clearing its old entry removes the record", async () => {
	const { root, host, entry } = await switchedSession();

	followRetainedRecord(host, "session-a");
	await clearRetainedRecord(host, entry);
	// The stamped write joins the record queue only after its own clear, so wait for the session's write chain
	// first; then one more queued mutation settles after everything that chain put in the FIFO queue.
	await entry.recordWrite;
	await clearHandoverParkedSession(root, join(root, "never-recorded.jsonl"));

	expect(await readHandoverParkedSessions(root)).toEqual([]);
});
