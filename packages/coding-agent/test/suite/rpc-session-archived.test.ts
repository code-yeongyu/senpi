import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { dataOf, type RawClient, statusHost, type WireRecord } from "./rpc-session-status-support.ts";

type Host = Awaited<ReturnType<typeof statusHost>>;

async function openSession(client: RawClient, fields: Record<string, unknown>): Promise<string> {
	return String(dataOf(await client.request({ type: "open_session", ...fields })).sessionId);
}

async function listedRow(client: RawClient, match: (row: WireRecord) => boolean): Promise<WireRecord> {
	const rows = dataOf(await client.request({ type: "list_sessions" })).sessions as WireRecord[];
	const row = rows.find(match);
	if (row === undefined) throw new Error(`no list_sessions row matched: ${JSON.stringify(rows)}`);
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

function archiveStatus(subscriptionId: string, sessionId: string, archived: boolean) {
	return (record: WireRecord): boolean =>
		record.type === "session_status" &&
		record.subscriptionId === subscriptionId &&
		record.sessionId === sessionId &&
		(record.lastChange as { cause?: unknown } | undefined)?.cause === "archive" &&
		record.archived === archived;
}

it("set_session_archived is listed and survives closing and reopening the session from its file", async () => {
	await using host = await statusHost();
	const owner = host.client("owner");
	const sessionId = await openSession(owner, { cwd: host.cwd });
	host.faux.setResponses([fauxAssistantMessage("saved", { timestamp: 1 })]);
	await promptToIdle(host, owner, sessionId, "persist this session");
	expect((await listedRow(owner, (row) => row.sessionId === sessionId)).archived).toBe(false);

	dataOf(await owner.request({ type: "set_session_archived", sessionId, archived: true }));
	const archivedRow = await listedRow(owner, (row) => row.sessionId === sessionId);
	expect(archivedRow.archived).toBe(true);

	const sessionPath = String(archivedRow.sessionPath);
	dataOf(await owner.request({ type: "close_session", sessionId }));
	const reader = host.client("reader");
	const reopened = await openSession(reader, { cwd: host.cwd, sessionPath });
	expect(reopened).not.toBe(sessionId);
	expect(await listedRow(reader, (row) => row.sessionId === reopened)).toMatchObject({ sessionPath, archived: true });
}, 120_000);

it("an unattached subscriber receives the archive change, and archived:false clears it", async () => {
	await using host = await statusHost();
	const watcher = host.client("watcher");
	const subscriptionId = await subscribe(watcher);
	const owner = host.client("owner");
	const sessionId = await openSession(owner, { cwd: host.cwd });

	dataOf(await owner.request({ type: "set_session_archived", sessionId, archived: true }));
	await watcher.waitFor(archiveStatus(subscriptionId, sessionId, true));

	dataOf(await owner.request({ type: "set_session_archived", sessionId, archived: false }));
	await watcher.waitFor(archiveStatus(subscriptionId, sessionId, false));
	expect((await listedRow(watcher, (row) => row.sessionId === sessionId)).archived).toBe(false);
}, 120_000);

it("lists a session with a turn in flight as running and as idle once it settles", async () => {
	await using host = await statusHost();
	const owner = host.client("owner");
	const subscriptionId = await subscribe(owner);
	const sessionId = await openSession(owner, { cwd: host.cwd });
	expect((await listedRow(owner, (row) => row.sessionId === sessionId)).activity).toBe("idle");
	let release = (): void => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	host.faux.setResponses([
		async () => {
			await held;
			return fauxAssistantMessage("released", { timestamp: 1 });
		},
	]);
	const idle = owner.waitFor((record) => record.type === "agent_idle" && record.sessionId === sessionId);
	dataOf(await owner.request({ type: "prompt", sessionId, message: "hold the turn" }));
	await owner.waitFor(
		(record) =>
			record.type === "session_status" &&
			record.subscriptionId === subscriptionId &&
			record.sessionId === sessionId &&
			record.status === "running",
	);
	expect((await listedRow(owner, (row) => row.sessionId === sessionId)).activity).toBe("running");

	release();
	await idle;
	expect((await listedRow(owner, (row) => row.sessionId === sessionId)).activity).toBe("idle");
}, 120_000);

it("lists the session's current model, following set_model", async () => {
	await using host = await statusHost();
	const owner = host.client("owner");
	const sessionId = await openSession(owner, { cwd: host.cwd });
	expect((await listedRow(owner, (row) => row.sessionId === sessionId)).model).toEqual({
		provider: host.model.provider,
		id: "faux-a",
	});

	dataOf(await owner.request({ type: "set_model", sessionId, provider: host.model.provider, modelId: "faux-b" }));
	expect((await listedRow(owner, (row) => row.sessionId === sessionId)).model).toEqual({
		provider: host.model.provider,
		id: "faux-b",
	});
}, 120_000);
