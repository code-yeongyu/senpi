import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { dataOf, type RawClient, statusHost, type WireRecord } from "./rpc-session-status-support.ts";

type Host = Awaited<ReturnType<typeof statusHost>>;

async function openSession(client: RawClient, fields: Record<string, unknown>): Promise<string> {
	return String(dataOf(await client.request({ type: "open_session", ...fields })).sessionId);
}

async function listedRow(client: RawClient, sessionId: string): Promise<WireRecord> {
	const rows = dataOf(await client.request({ type: "list_sessions" })).sessions as WireRecord[];
	const row = rows.find((candidate) => candidate.sessionId === sessionId);
	if (row === undefined) throw new Error(`no list_sessions row for ${sessionId}: ${JSON.stringify(rows)}`);
	return row;
}

async function promptToIdle(host: Host, client: RawClient, sessionId: string, message: string): Promise<void> {
	const idle = (record: WireRecord) => record.type === "agent_idle" && record.sessionId === sessionId;
	const seen = client.inbox.filter(idle).length;
	const settled = client.waitFor((record) => idle(record) && client.inbox.filter(idle).length > seen);
	dataOf(await client.request({ type: "prompt", sessionId, message }));
	await settled;
	await host.writer.flush();
}

async function subscribe(client: RawClient): Promise<string> {
	return String(dataOf(await client.request({ type: "subscribe_sessions" })).subscriptionId);
}

function settleStatus(subscriptionId: string, sessionId: string, settled: boolean) {
	return (record: WireRecord): boolean =>
		record.type === "session_status" &&
		record.subscriptionId === subscriptionId &&
		record.sessionId === sessionId &&
		(record.lastChange as { cause?: unknown } | undefined)?.cause === "settle" &&
		record.settled === settled;
}

it("set_session_settled is listed with its by and survives closing and reopening the session from its file", async () => {
	await using host = await statusHost();
	const owner = host.client("owner");
	const sessionId = await openSession(owner, { cwd: host.cwd });
	host.faux.setResponses([fauxAssistantMessage("saved", { timestamp: 1 })]);
	await promptToIdle(host, owner, sessionId, "persist this session");
	const before = await listedRow(owner, sessionId);
	expect(before.settled).toBe(false);
	expect(before).not.toHaveProperty("settledBy");

	dataOf(await owner.request({ type: "set_session_settled", sessionId, settled: true, by: { kind: "user" } }));
	const settledRow = await listedRow(owner, sessionId);
	expect(settledRow).toMatchObject({ settled: true, settledBy: { kind: "user" } });

	const sessionPath = String(settledRow.sessionPath);
	dataOf(await owner.request({ type: "close_session", sessionId }));
	const reader = host.client("reader");
	const reopened = await openSession(reader, { cwd: host.cwd, sessionPath });
	expect(reopened).not.toBe(sessionId);
	expect(await listedRow(reader, reopened)).toMatchObject({ sessionPath, settled: true, settledBy: { kind: "user" } });
}, 120_000);

it("an unattached subscriber receives the settle change with its by, and settled:false clears both", async () => {
	await using host = await statusHost();
	const watcher = host.client("watcher");
	const subscriptionId = await subscribe(watcher);
	const owner = host.client("owner");
	const sessionId = await openSession(owner, { cwd: host.cwd });
	const by = { kind: "pr-merged", pullRequestNumber: 7 };

	dataOf(await owner.request({ type: "set_session_settled", sessionId, settled: true, by }));
	expect((await watcher.waitFor(settleStatus(subscriptionId, sessionId, true))).settledBy).toEqual(by);
	expect(owner.inbox).toContainEqual(
		expect.objectContaining({ type: "session_settled_changed", sessionId, settled: true, settledBy: by }),
	);

	dataOf(await owner.request({ type: "set_session_settled", sessionId, settled: false }));
	expect(await watcher.waitFor(settleStatus(subscriptionId, sessionId, false))).not.toHaveProperty("settledBy");
	const row = await listedRow(watcher, sessionId);
	expect(row.settled).toBe(false);
	expect(row).not.toHaveProperty("settledBy");
}, 120_000);

it("refuses an unknown or malformed by with invalid_argument and leaves the flag alone", async () => {
	await using host = await statusHost();
	const owner = host.client("owner");
	const sessionId = await openSession(owner, { cwd: host.cwd });

	for (const by of [{ kind: "goal-complete" }, { kind: "inactivity" }, { kind: "pr-closed", pullRequestNumber: 0 }]) {
		expect(await owner.request({ type: "set_session_settled", sessionId, settled: true, by })).toMatchObject({
			success: false,
			errorCode: "invalid_argument",
		});
	}
	expect((await listedRow(owner, sessionId)).settled).toBe(false);
}, 120_000);
