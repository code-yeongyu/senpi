/**
 * senpi#7572 no hang: a run that asked for a designated answerer never waits on a prompt nobody may answer. With its
 * opener gone and no client holding the key attached, a new ask is refused at once with a reason that names the missing
 * answerer, and no dialog is raised. A raised prompt stays answerable while the key comes back before the grace bound
 * (the bound itself is pinned on a virtual clock in `test/rpc/answerer-presence.test.ts`).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { DelegatedHost } from "../rpc-delegated-host-support.ts";
import { FrameLog, PROBE_TEXT, permissionHost } from "../rpc-delegated-permission-support.ts";

let host: DelegatedHost | undefined;
function live(): DelegatedHost {
	if (host === undefined) throw new Error("no host is running");
	return host;
}
afterEach(async () => {
	await host?.dispose();
	host = undefined;
}, 60_000);

async function openedThenDropped() {
	host = await permissionHost();
	const opener = await host.proven();
	const reply = await opener.send({
		type: "open_session",
		permissionPreset: "ask",
		designatedAnswerer: true,
		retain_on_disconnect: true,
	});
	const data = reply.data as { sessionId: string; state: { sessionId: string }; answerKey: string };
	return { data, opener };
}

describe("#7572 a run whose designated answerer is not connected does not hang", () => {
	it("refuses a new ask at once with a reason that names the missing answerer", async () => {
		const { data, opener } = await openedThenDropped();
		await live().drop(opener);
		const driver = await live().proven();
		const log = new FrameLog(driver);
		expect(
			await driver.send({ type: "attach_session", sessionId: data.sessionId, durableSessionId: data.state.sessionId }),
		).toMatchObject({ success: true, data: { answerer: false } });
		const ended = log.next(
			(record) => record.type === "tool_execution_end" && record.sessionId === data.sessionId,
		);
		await driver.send({ type: "prompt", sessionId: data.sessionId, message: "go" });
		const end = JSON.stringify(await ended);
		expect(end).toContain("designated answerer is not connected");
		expect(end).not.toContain(PROBE_TEXT);
		expect(log.frames.some((frame) => frame.type === "extension_ui_request" && frame.method === "select")).toBe(false);
	});

	it("keeps a raised prompt answerable when the key comes back before the grace bound", async () => {
		const { data, opener } = await openedThenDropped();
		const openerLog = new FrameLog(opener);
		const asked = openerLog.next(
			(record) =>
				record.type === "extension_ui_request" && record.method === "select" && record.sessionId === data.sessionId,
		);
		await opener.send({ type: "prompt", sessionId: data.sessionId, message: "go" });
		const dialog = await asked;
		await live().drop(opener);

		const back = await live().proven();
		const log = new FrameLog(back);
		expect(
			await back.send({
				type: "attach_session",
				sessionId: data.sessionId,
				durableSessionId: data.state.sessionId,
				answerKey: data.answerKey,
			}),
		).toMatchObject({ success: true, data: { answerer: true } });
		const ended = log.next(
			(record) => record.type === "tool_execution_end" && record.sessionId === data.sessionId,
		);
		back.socket.write(
			`${JSON.stringify({ type: "extension_ui_response", sessionId: data.sessionId, id: dialog.id, value: "Allow once" })}\n`,
		);
		expect(JSON.stringify(await ended)).toContain(PROBE_TEXT);
	});
});
