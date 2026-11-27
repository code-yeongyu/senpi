/**
 * senpi#7572, the ways a client becomes a run's answerer, on both runtimes (the check runs in the host router, before an
 * answer reaches the in-process session or the worker isolate): the opener is; an attach without the run's key is not,
 * and its answer is refused while the prompt stays pending; an attach with the key is; one answer carrying the key is
 * taken; a reconnect after a dropped socket needs the key again. The opener asks for the rule; a run that does not
 * (the default) takes answers from any attached client exactly as before.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { DelegatedHost } from "../rpc-delegated-host-support.ts";
import { FrameLog, PROBE_TEXT, permissionHost } from "../rpc-delegated-permission-support.ts";
import type { Peer, WireRecord } from "../rpc-delegated-peer.ts";

type Runtime = "in-process" | "worker";

let host: DelegatedHost | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
}, 60_000);

interface Opened {
	readonly sessionId: string;
	readonly durableSessionId: string;
	readonly answerKey: string | undefined;
	readonly dialog: WireRecord;
	readonly opener: Peer;
	readonly openerLog: FrameLog;
}

/** Opens an `ask` run on `runtime` that holds one read prompt open, answered by nobody yet. */
async function runWithPendingPrompt(runtime: Runtime, extra: WireRecord = {}): Promise<Opened> {
	host = await permissionHost([], runtime === "worker" ? { workers: true } : {});
	const opener = await host.proven();
	const openerLog = new FrameLog(opener);
	const reply = await opener.send({
		type: "open_session",
		permissionPreset: "ask",
		designatedAnswerer: true,
		...(runtime === "worker" ? { provider: "fauxsock", modelId: "faux-1" } : {}),
		...extra,
	});
	expect(reply, JSON.stringify(reply)).toMatchObject({ success: true, data: { answerer: true } });
	const data = reply.data as { sessionId: string; state: { sessionId: string }; answerKey?: unknown };
	if (extra.designatedAnswerer !== false) expect(typeof data.answerKey).toBe("string");
	const asked = openerLog.next(
		(record) =>
			record.type === "extension_ui_request" && record.method === "select" && record.sessionId === data.sessionId,
	);
	await opener.send({ type: "prompt", sessionId: data.sessionId, message: "go" });
	return {
		sessionId: data.sessionId,
		durableSessionId: data.state.sessionId,
		answerKey: typeof data.answerKey === "string" ? data.answerKey : undefined,
		dialog: await asked,
		opener,
		openerLog,
	};
}

function answer(run: Opened, value: string, extra: WireRecord = {}): WireRecord {
	return { type: "extension_ui_response", sessionId: run.sessionId, id: run.dialog.id, value, ...extra };
}

async function pendingIds(peer: Peer, sessionId: string): Promise<unknown[]> {
	const state = await peer.send({ type: "get_state", sessionId });
	return ((state.data as { pendingDialogs?: Array<{ id: unknown }> }).pendingDialogs ?? []).map((entry) => entry.id);
}

/** Sends `record` without waiting for a reply and resolves with the probe call's end, as `watcher` sees it. */
async function settle(watcher: FrameLog, sender: Peer, sessionId: string, record: WireRecord): Promise<string> {
	const ended = watcher.next(
		(frame) =>
			frame.type === "tool_execution_end" &&
			frame.sessionId === sessionId &&
			String(frame.toolCallId ?? "").startsWith("probe-"),
	);
	sender.socket.write(`${JSON.stringify(record)}\n`);
	return JSON.stringify(await ended);
}

describe.each<Runtime>(["in-process", "worker"])("#7572 who answers a run's prompts (%s)", (runtime) => {
	it("leaves a run that did not ask for the rule as it was: no key, and an attached client's answer settles the prompt", async () => {
		const run = await runWithPendingPrompt(runtime, { designatedAnswerer: false });
		expect(run.answerKey).toBeUndefined();
		const other = await host!.proven();
		const otherLog = new FrameLog(other);
		expect(
			await other.send({ type: "attach_session", sessionId: run.sessionId, durableSessionId: run.durableSessionId }),
		).toMatchObject({ success: true, data: { answerer: true } });
		expect(await settle(otherLog, other, run.sessionId, answer(run, "Allow once"))).toContain(PROBE_TEXT);
	}, 120_000);

	it("refuses an attached client without the key, keeps the prompt, and makes a client attached with the key the answerer", async () => {
		const run = await runWithPendingPrompt(runtime);
		const attach = { type: "attach_session", sessionId: run.sessionId, durableSessionId: run.durableSessionId };

		const stranger = await host!.proven();
		expect(await stranger.send(attach)).toMatchObject({ success: true, data: { answerer: false } });
		expect(await stranger.send(answer(run, "Allow once"))).toMatchObject({
			success: false,
			errorCode: "prompt_answerer_required",
		});
		expect(await pendingIds(stranger, run.sessionId)).toContain(run.dialog.id);
		expect(await stranger.send(attach)).toMatchObject({ data: { answerer: false } });
		expect(await stranger.send({ ...attach, answerKey: "not-the-key" })).toMatchObject({ data: { answerer: false } });

		const holder = await host!.proven();
		const holderLog = new FrameLog(holder);
		expect(await holder.send({ ...attach, answerKey: run.answerKey })).toMatchObject({
			success: true,
			data: { answerer: true },
		});
		expect(await settle(holderLog, holder, run.sessionId, answer(run, "Allow once"))).toContain(PROBE_TEXT);
	}, 120_000);

	it("takes one answer carrying the key, and asks a reconnect after a drop for the key again", async () => {
		const run = await runWithPendingPrompt(runtime, { retain_on_disconnect: true });
		await host!.drop(run.opener);
		const attach = { type: "attach_session", sessionId: run.sessionId, durableSessionId: run.durableSessionId };

		const back = await host!.proven();
		const backLog = new FrameLog(back);
		expect(await back.send(attach)).toMatchObject({ success: true, data: { answerer: false } });
		expect(await back.send(answer(run, "Deny"))).toMatchObject({
			success: false,
			errorCode: "prompt_answerer_required",
		});
		expect(await pendingIds(back, run.sessionId)).toContain(run.dialog.id);
		expect(
			await settle(backLog, back, run.sessionId, answer(run, "Deny", { answerKey: run.answerKey })),
		).not.toContain(PROBE_TEXT);
	}, 120_000);
});
