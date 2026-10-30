import { chmodSync, readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { recoveryCarrier } from "../../../src/core/session-recovery-identity.ts";
import { type FrozenAcceptedRoot } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { RpcSessionRegistry, type RpcSessionEntry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

// Part of #4272: actual host acceptance before persistence; no synthetic append or reducer-only substitute.
it("T1 C2.1-C2.4 in-process cuts preserve pending and failed payloads; new_session explicitly clears them", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const admissions = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	const client = host.client("terminal");
	const opened = dataOf(await client.request({ type: "open_session", cwd: host.cwd }));
	const sessionId = String(opened.sessionId);
	const entry = admissions.mock.results.findLast((result) => result.type === "return")?.value as
		| RpcSessionEntry
		| undefined;
	const lane = entry?.acceptance;
	const session = entry?.runtime?.session;
	if (!lane || !session) throw new Error("no real lane");
	const file = session.sessionManager.getSessionFile();
	if (!file) throw new Error("no file");
	const cuts: { role: string; id: string; root: FrozenAcceptedRoot; wire: string }[] = [];
	const stop = session.subscribe((event) => {
		if (event.type !== "message_end") return;
		if (event.message.role !== "user" && event.message.role !== "assistant") return;
		const carrier = recoveryCarrier(event);
		if (!carrier) throw new Error("no terminal carrier");
		cuts.push({
			role: event.message.role,
			id: carrier.messageId,
			root: lane.freeze(),
			wire: JSON.stringify(event.message),
		});
	});
	const prompt = async (text: string) => {
		const since = client.inbox.length;
		const done = client.waitFor((record) => client.inbox.indexOf(record) >= since && record.type === "agent_idle");
		host.faux.setResponses([fauxAssistantMessage(`answer ${text}`, { timestamp: 1 })]);
		dataOf(await client.request({ type: "prompt", sessionId, message: text }));
		await done;
		await host.writer.flush();
	};
	try {
		await prompt("first");
		expect(cuts.map((cut) => cut.role)).toEqual(["user", "assistant"]);
		for (const cut of cuts) {
			expect(cut.root.settled).toBeDefined();
			const pending = (await lane.readSettled(cut.root)).settledMessages;
			expect(pending.find((row) => row.messageId === cut.id)).toMatchObject({ status: "pending", entryId: null });
			expect(JSON.stringify(pending.find((row) => row.messageId === cut.id)?.terminal)).toBe(cut.wire);
		}
		const joinedRoot = lane.freeze();
		const joined = await lane.readSettled(joinedRoot);
		expect(joined.settledMessages).toEqual([]);
		expect(joined.owners.map((row) => row.messageId)).toEqual(expect.arrayContaining(cuts.map((cut) => cut.id)));
		chmodSync(file, 0o444);
		await prompt("refused");
		const failedRoot = lane.freeze();
		const failed = await lane.readSettled(failedRoot);
		expect(failed.settledMessages).toHaveLength(2);
		for (const row of failed.settledMessages) {
			expect(row.status).toBe("failed");
			expect(row.error?.errorMessage).toContain("EACCES");
		}
		chmodSync(file, 0o644);
		await prompt("later");
		const before = { bytes: readFileSync(file, "utf8"), records: client.inbox.length };
		const fresh = lane.freeze();
		expect((await lane.readSettled(fresh)).settledMessages).toEqual(failed.settledMessages);
		expect(await lane.readSettled(failedRoot)).toEqual(failed);
		expect(client.inbox).toHaveLength(before.records);
		expect(readFileSync(file, "utf8")).toBe(before.bytes);
		const nonce = lane.recoveryEpoch;
		expect(before.bytes).not.toContain(nonce);
		expect(JSON.stringify(client.inbox)).not.toContain(nonce);
		expect(JSON.stringify(client.inbox)).not.toContain('"recoveryEpoch"');
		dataOf(await client.request({ type: "new_session", sessionId }));
		expect(lane.recoveryEpoch).not.toBe(nonce);
		expect((await lane.readSettled(lane.freeze())).settledMessages).toEqual([]);
		expect(lane.liveRoots).toBe(1);
	} finally {
		stop();
		chmodSync(file, 0o644);
		for (const cut of cuts) lane.release(cut.root);
	}
}, 90000);

it("C2.2 Q3 idle custom append already owns its message before start and end", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const admissions = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	const client = host.client("custom");
	dataOf(await client.request({ type: "open_session", cwd: host.cwd }));
	const entry = admissions.mock.results.findLast((result) => result.type === "return")?.value as
		| RpcSessionEntry
		| undefined;
	const lane = entry?.acceptance;
	const session = entry?.runtime?.session;
	if (!lane || !session) throw new Error("no real lane");
	const cuts: FrozenAcceptedRoot[] = [];
	const stop = session.subscribe((event) => {
		if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "custom")
			cuts.push(lane.freeze());
	});
	try {
		await session.sendCustomMessage({ customType: "test", content: "idle notice", display: true });
		expect(cuts).toHaveLength(2);
		for (const root of cuts) {
			expect(root.settled).toBeDefined();
			const cut = await lane.readSettled(root);
			expect(cut.settledMessages).toEqual([]);
			expect(cut.owners).toHaveLength(1);
		}
	} finally {
		stop();
		for (const root of cuts) lane.release(root);
	}
}, 60000);
