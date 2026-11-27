/**
 * senpi#7572 across a host handover: only the flag that a run asked for a designated answerer travels in the parked
 * record, never its key. The successor's reopen of such a run (the router's own `reopenParked`, fed the record
 * `parkedEntryFromProfile` builds) has no answerer, and says so where a client can read it without a person: every
 * attach answers `answerer: false, answererUnavailable: "host_handover"`, and every answer, the old opener's key
 * included, gets `prompt_answerer_required` with `errorData.reason: "host_handover"`. Closing and opening it again takes
 * a new key that answers. A record an older engine wrote (no flag) reopens with the rule off, as before.
 */
import { afterEach, describe, expect, it } from "vitest";
import { parkedEntryFromProfile } from "../../../src/modes/rpc/host-handover-parked-open.ts";
import type { DelegatedHost } from "../rpc-delegated-host-support.ts";
import { FrameLog, PROBE_TEXT, permissionHost, probeTurns } from "../rpc-delegated-permission-support.ts";
import type { Peer, WireRecord } from "../rpc-delegated-peer.ts";

let host: DelegatedHost | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
}, 60_000);

type OpenData = { sessionId: string; state: { sessionId: string; sessionFile: string }; answerKey?: string };

/** Opens an `ask` run, runs nothing, closes it, and reopens it the way a successor does from its parked record. */
async function handedOver(designatedAnswerer: boolean, legacyRecord = false) {
	host = await permissionHost();
	const opener = await host.proven();
	const reply = await opener.send({ type: "open_session", permissionPreset: "ask", designatedAnswerer });
	const first = reply.data as OpenData;
	const profile = host.core.peekSession(first.sessionId)?.profile;
	const parked = parkedEntryFromProfile(
		{ sessionPath: first.state.sessionFile, durableSessionId: first.state.sessionId },
		profile,
		[],
	);
	if (designatedAnswerer) expect(parked).toMatchObject({ designatedAnswerer: true });
	expect(JSON.stringify(parked)).not.toContain(String(first.answerKey));
	const { designatedAnswerer: _flag, ...older } = parked;
	expect(await opener.send({ type: "close_session", sessionId: first.sessionId })).toMatchObject({ success: true });
	expect(await host.core.router.reopenParked(legacyRecord ? older : parked)).toBeUndefined();
	const listed = await opener.send({ type: "list_sessions" });
	const row = (listed.data as { sessions: Array<{ sessionId: string; sessionPath?: string }> }).sessions.find(
		(candidate) => candidate.sessionPath === first.state.sessionFile,
	);
	if (row === undefined) throw new Error(`the reopened session is not listed: ${JSON.stringify(listed)}`);
	return { first, sessionId: row.sessionId, durableSessionId: first.state.sessionId, opener };
}

async function promptAndAwaitDialog(peer: Peer, log: FrameLog, sessionId: string): Promise<WireRecord> {
	const asked = log.next(
		(record) => record.type === "extension_ui_request" && record.method === "select" && record.sessionId === sessionId,
	);
	await peer.send({ type: "prompt", sessionId, message: "go" });
	return asked;
}

describe("#7572 a designated-answerer run across a host handover", () => {
	it("reopens with no answerer, detectably, refuses every answer, and a close and reopen takes a new key", async () => {
		const run = await handedOver(true);
		const attach = { type: "attach_session", sessionId: run.sessionId, durableSessionId: run.durableSessionId };
		const client = await host!.proven();
		const log = new FrameLog(client);
		expect(await client.send({ ...attach, answerKey: run.first.answerKey })).toMatchObject({
			success: true,
			data: { answerer: false, answererUnavailable: "host_handover" },
		});
		const dialog = await promptAndAwaitDialog(client, log, run.sessionId);
		for (const answerKey of [undefined, run.first.answerKey])
			expect(
				await client.send({
					type: "extension_ui_response",
					sessionId: run.sessionId,
					id: dialog.id,
					value: "Allow once",
					...(answerKey === undefined ? {} : { answerKey }),
				}),
			).toMatchObject({ success: false, errorCode: "prompt_answerer_required", errorData: { reason: "host_handover" } });

		expect(await client.send({ type: "close_session", sessionId: run.sessionId })).toMatchObject({ success: true });
		// The close ended the first turn inside its call, so its scripted reply was never taken: start the script again.
		host!.faux.setResponses(probeTurns(4));
		const reopened = await client.send({
			type: "open_session",
			sessionPath: run.first.state.sessionFile,
			permissionPreset: "ask",
			designatedAnswerer: true,
		});
		const fresh = reopened.data as OpenData & { answerer: boolean; answererUnavailable?: string };
		expect(fresh.answerer).toBe(true);
		expect(fresh.answererUnavailable).toBeUndefined();
		expect(typeof fresh.answerKey).toBe("string");
		expect(fresh.answerKey).not.toBe(run.first.answerKey);
		const again = await promptAndAwaitDialog(client, log, fresh.sessionId);
		const ended = log.next((record) => record.type === "tool_execution_end" && record.sessionId === fresh.sessionId);
		client.socket.write(
			`${JSON.stringify({ type: "extension_ui_response", sessionId: fresh.sessionId, id: again.id, value: "Allow once" })}\n`,
		);
		expect(JSON.stringify(await ended)).toContain(PROBE_TEXT);
	}, 120_000);

	it("reopens a record an older engine wrote (no flag) with the rule off, as before", async () => {
		const run = await handedOver(true, true);
		const client = await host!.proven();
		const log = new FrameLog(client);
		expect(
			await client.send({ type: "attach_session", sessionId: run.sessionId, durableSessionId: run.durableSessionId }),
		).toMatchObject({ success: true, data: { answerer: true } });
		const dialog = await promptAndAwaitDialog(client, log, run.sessionId);
		const ended = log.next((record) => record.type === "tool_execution_end" && record.sessionId === run.sessionId);
		client.socket.write(
			`${JSON.stringify({ type: "extension_ui_response", sessionId: run.sessionId, id: dialog.id, value: "Allow once" })}\n`,
		);
		expect(JSON.stringify(await ended)).toContain(PROBE_TEXT);
	}, 120_000);
});
