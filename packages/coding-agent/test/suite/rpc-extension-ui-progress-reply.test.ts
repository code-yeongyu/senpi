/**
 * senpi#5761: `extension_ui_progress` gets exactly one correlated reply line keyed by its `id`, like every other
 * answer record. A forwarder (a relay host passing a remote client's records to the engine) waits for a reply to every
 * record it forwards, and must never need its own list of records that have none. The reply follows the
 * `question_updated` frame the draft causes; local clients get the same reply.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RPC_INBOUND_SAMPLES } from "../../scripts/rpc-inbound-samples.ts";
import type { QuestionRequest } from "../../src/core/extensions/types.ts";
import { createRpcConnectionHandler, type RpcConnectionHandler } from "../../src/modes/rpc/connection-handler.ts";
import { RPC_METHOD_CLASS } from "../../src/modes/rpc/method-classes.ts";
import { makeHarness, makeSink, type Harness, type RpcRecord } from "./rpc-connection-harness.ts";
import { dataOf, statusHost } from "./rpc-session-status-support.ts";

const resources: Array<{ dir: string; harness: Harness; handler: RpcConnectionHandler }> = [];
afterEach(async () => {
	for (const { dir, harness, handler } of resources.splice(0)) {
		await handler.dispose();
		harness.cleanup();
		rmSync(dir, { recursive: true, force: true });
	}
});

const QUESTION: QuestionRequest = {
	requestId: "progress-reply",
	questions: [
		{ id: "q1", header: "Pick", question: "Which?", options: [{ label: "A" }, { label: "B" }], multiSelect: false },
	],
	waitForAnswer: true,
	timeoutMs: 60_000,
};

/** A classic connection that advertised the `question` capability, so `ui.question` raises a native question. */
async function classic() {
	const dir = mkdtempSync(join(tmpdir(), "progress-reply-"));
	const harness = makeHarness(dir);
	const collected = makeSink();
	const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink, { capabilities: ["question"] });
	resources.push({ dir, harness, handler });
	await handler.ready;
	const ui = harness.runtimeHost.session.extensionRunner.getUIContext();
	const send = (frame: object) => handler.handleInputLine(JSON.stringify(frame));
	const repliesTo = (id: string): RpcRecord[] =>
		collected.messages().filter((record) => record.type === "response" && record.id === id);
	return { collected, ui, send, repliesTo };
}

describe("extension_ui_progress reply (senpi#5761)", () => {
	it("a draft for a pending question gets question_updated, then exactly one success reply keyed by its id", async () => {
		const c = await classic();
		const controller = new AbortController();
		const answer = c.ui.question?.(QUESTION, { signal: controller.signal });
		const frame = await c.collected.waitFor((r) => r.type === "extension_ui_request" && r.method === "question");
		const id = String(frame.id);
		await c.send({ type: "extension_ui_progress", id, answers: { q1: { selected: ["A"] } }, comment: "draft" });
		expect(c.repliesTo(id)).toEqual([{ id, type: "response", command: "extension_ui_progress", success: true }]);
		const records = c.collected.messages();
		const updated = records.findIndex((r) => r.type === "question_updated" && r.id === id);
		const replied = records.findIndex((r) => r.type === "response" && r.id === id);
		expect(updated).toBeGreaterThanOrEqual(0);
		expect(replied).toBeGreaterThan(updated);
		controller.abort();
		await answer;
	});

	it("a draft no question holds gets one unknown_extension_ui_request refusal", async () => {
		const c = await classic();
		await c.send({ type: "extension_ui_progress", id: "no-such-dialog", answers: {} });
		expect(c.repliesTo("no-such-dialog")).toEqual([
			{
				id: "no-such-dialog",
				type: "response",
				command: "extension_ui_progress",
				success: false,
				error: "unknown_extension_ui_request",
			},
		]);
	});

	it("a draft after its question resolved gets one question_already_resolved refusal", async () => {
		const c = await classic();
		const answer = c.ui.question?.(QUESTION);
		const frame = await c.collected.waitFor((r) => r.type === "extension_ui_request" && r.method === "question");
		const id = String(frame.id);
		await c.send({ type: "extension_ui_response", id, answers: { q1: { selected: ["B"] } } });
		await answer;
		await c.send({ type: "extension_ui_progress", id, answers: { q1: { selected: ["A"] } } });
		expect(c.repliesTo(id).filter((r) => r.command === "extension_ui_progress")).toEqual([
			{
				id,
				type: "response",
				command: "extension_ui_progress",
				success: false,
				error: "question_already_resolved",
			},
		]);
	});

	it("on the socket host the sender gets the reply and the question's own connection gets question_updated", async () => {
		const rig = await statusHost();
		await using _rig = rig;
		const owner = rig.client("owner");
		await owner.request({ type: "set_client_info", width: 80, capabilities: ["interactive_user", "question"] });
		const opened = dataOf(await owner.request({ type: "open_session", cwd: rig.cwd, retain_on_disconnect: true }));
		const sessionId = String(opened.sessionId);
		const captured: { ask?: () => unknown } = {};
		const api = [...rig.extensionApis.values()][0];
		if (!api) throw new Error("missing extension API");
		const controller = new AbortController();
		api.registerCommand("ask-progress", {
			description: "fixture",
			handler: async (_args, ctx) => {
				captured.ask = () => ctx.ui.question?.(QUESTION, { signal: controller.signal });
			},
		});
		await owner.request({ type: "prompt", sessionId, message: "/ask-progress" });
		const raised = owner.waitFor((r) => r.type === "extension_ui_request" && r.method === "question");
		const answer = captured.ask?.();
		const id = String((await raised).id);
		const sender = rig.client("sender");
		await sender.request({ type: "set_client_info", width: 80, capabilities: ["interactive_user"] });
		const durableSessionId = (opened.state as { sessionId: string }).sessionId;
		expect(await sender.request({ type: "attach_session", sessionId, durableSessionId })).toMatchObject({
			success: true,
		});
		const replied = sender.waitFor((r) => r.type === "response" && r.id === id);
		const line = JSON.stringify({
			type: "extension_ui_progress",
			sessionId,
			id,
			answers: { q1: { selected: ["A"] } },
		});
		await rig.writer.withConnection("sender", () => rig.core.handle(line));
		expect(await replied).toMatchObject({ id, type: "response", command: "extension_ui_progress", success: true });
		expect(await owner.waitFor((r) => r.type === "question_updated" && r.id === id)).toBeDefined();
		controller.abort();
		await answer;
	});
});

describe("one correlated reply per answer-class record (senpi#5761 guard)", () => {
	const answerMethods = Object.entries(RPC_METHOD_CLASS)
		.filter(([, entry]) => entry === "answer")
		.map(([method]) => method as keyof typeof RPC_INBOUND_SAMPLES);

	it("the engine's own table names the answer records the guard walks", () => {
		expect(answerMethods).toContain("extension_ui_progress");
		expect(answerMethods).toContain("extension_ui_response");
	});

	it.each(answerMethods)(
		"%s, routed to an open session on the socket host, gets exactly one reply keyed by its id",
		async (method) => {
			const rig = await statusHost();
			await using _rig = rig;
			const sender = rig.client("sender");
			const opened = dataOf(
				await sender.request({ type: "open_session", cwd: rig.cwd, retain_on_disconnect: true }),
			);
			const sessionId = String(opened.sessionId);
			const sample: Record<string, unknown> = { ...RPC_INBOUND_SAMPLES[method], sessionId };
			const id = String(sample.id);
			const replied = sender.waitFor((r) => r.type === "response" && r.id === id);
			await rig.writer.withConnection("sender", () => rig.core.handle(JSON.stringify(sample)));
			expect(await replied).toMatchObject({ id, type: "response", command: method });
			await rig.writer.withConnection("sender", () =>
				rig.core.handle(JSON.stringify({ type: "get_state", sessionId, id: "fence" })),
			);
			await sender.waitFor((r) => r.type === "response" && r.id === "fence");
			expect(sender.inbox.filter((r) => r.type === "response" && r.id === id)).toHaveLength(1);
		},
	);
});
