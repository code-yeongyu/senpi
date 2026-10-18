/**
 * A multi-session host answers every `extension_ui_response` it settles with one `response` carrying
 * the FRAME's `id`, so a client that answers on a fresh connection can wait for delivery. The request
 * being answered is named by `uiRequestId`; the short form (no `uiRequestId`, `id` = request id) that
 * every older client sends keeps resolving and is answered under that `id`.
 */
import { expect, it, vi } from "vitest";
import type { WorkerHostRecord } from "./rpc-host-endpoint.ts";
import { startInProcessHost } from "./rpc-worker-host-support.ts";

const EXTENSION = `export default function (pi) {
	pi.registerCommand("ask-question", { description: "question fixture", handler: async (_args, ctx) => {
		const result = await ctx.ui.question({ requestId: "relay-question", waitForAnswer: true, timeoutMs: 60000,
			questions: [{ id: "q1", header: "q1", question: "ship it?", options: [{ label: "yes" }, { label: "no" }], multiSelect: false }] });
		ctx.ui.notify("question:" + result.status + ":" + JSON.stringify(result.answers));
	} });
	pi.registerCommand("ask-input", { description: "input fixture", handler: async (_args, ctx) => {
		const value = await ctx.ui.input("Name?");
		ctx.ui.notify("input:" + value);
	} });
}`;

const WAIT_MS = 10_000;

const isReply = (id: string) => (record: WorkerHostRecord) =>
	record.type === "response" && record.command === "extension_ui_response" && record.id === id;
const isNotice = (prefix: string) => (record: WorkerHostRecord) =>
	record.type === "extension_ui_request" &&
	record.method === "notify" &&
	typeof record.message === "string" &&
	record.message.startsWith(prefix);

async function openAsker() {
	vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
	const host = await startInProcessHost(EXTENSION);
	const client = await host.connect();
	const opened = await client.request({ type: "open_session", cwd: host.cwd, capabilities: ["question"] });
	const sessionId = opened.data?.sessionId;
	await client.request({ type: "set_client_info", sessionId, width: 80, capabilities: ["question"] });
	return { host, client, sessionId };
}

it("answers a uiRequestId answer to a question with the frame id, once, and refuses a replay and an unknown request under their frame ids", async () => {
	const { host, client, sessionId } = await openAsker();
	try {
		const asked = client.wait((r) => r.type === "extension_ui_request" && r.method === "question", WAIT_MS);
		const prompt = client.request({ type: "prompt", sessionId, message: "/ask-question" });
		const question = await asked;
		if (question.id === undefined) throw new Error("question request without an id");

		// The legacy value frame (id = request id) is no answer to a question: refused under that id, still pending.
		const legacy = client.wait(isReply(question.id), WAIT_MS);
		client.send({ type: "extension_ui_response", sessionId, id: question.id, value: "yes" });
		expect(await legacy).toMatchObject({ id: question.id, success: false, error: "question_incomplete" });

		const replied = client.wait(isReply("answer-1"), WAIT_MS);
		const noticed = client.wait(isNotice("question:"), WAIT_MS);
		client.send({
			type: "extension_ui_response",
			sessionId,
			id: "answer-1",
			uiRequestId: question.id,
			answers: { q1: { selected: ["yes"] } },
		});
		expect(await replied).toMatchObject({ id: "answer-1", success: true });
		expect((await noticed).message).toBe('question:answered:{"q1":{"selected":["yes"]}}');
		expect((await prompt).success).toBe(true);

		const replay = client.wait(isReply("answer-2"), WAIT_MS);
		client.send({
			type: "extension_ui_response",
			sessionId,
			id: "answer-2",
			uiRequestId: question.id,
			answers: { q1: { selected: ["no"] } },
		});
		expect(await replay).toMatchObject({ id: "answer-2", success: false, error: "question_already_resolved" });

		const unknown = client.wait(isReply("answer-3"), WAIT_MS);
		client.send({
			type: "extension_ui_response",
			sessionId,
			id: "answer-3",
			uiRequestId: "no-such-request",
			value: "x",
		});
		expect(await unknown).toMatchObject({ id: "answer-3", success: false, error: "unknown_extension_ui_request" });

		expect(client.records.filter((r) => r.type === "response" && r.command === "extension_ui_response")).toHaveLength(
			4,
		);
		expect(client.records.filter(isNotice("question:"))).toHaveLength(1);
	} finally {
		await host.dispose();
	}
}, 120_000);

it("keeps the short form: id alone names the dialog, resolves it once and is answered under that id", async () => {
	const { host, client, sessionId } = await openAsker();
	try {
		const asked = client.wait((r) => r.type === "extension_ui_request" && r.method === "input", WAIT_MS);
		const prompt = client.request({ type: "prompt", sessionId, message: "/ask-input" });
		const dialog = await asked;
		if (dialog.id === undefined) throw new Error("input request without an id");

		// The exact frame an older client writes: the request id in `id`, nothing else.
		const replied = client.wait(isReply(dialog.id), WAIT_MS);
		const noticed = client.wait(isNotice("input:"), WAIT_MS);
		client.send({ type: "extension_ui_response", sessionId, id: dialog.id, value: "Ada" });
		expect(await replied).toMatchObject({ id: dialog.id, success: true });
		expect((await noticed).message).toBe("input:Ada");
		expect((await prompt).success).toBe(true);
		expect(client.records.filter(isReply(dialog.id))).toHaveLength(1);
	} finally {
		await host.dispose();
	}
}, 120_000);
