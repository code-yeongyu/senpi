// Grant answer correlation on a worker session: the host decides who may answer a worker's grant
// dialog by the request the response answers (`uiRequestId`, or `id` in the short form).
import { afterEach, expect, it, vi } from "vitest";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { SessionWorkerClient } from "../../src/modes/rpc/session-worker-client.ts";

const posted = vi.hoisted(() => [] as { type: string; request?: number; command?: object }[]);

vi.mock("node:worker_threads", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:worker_threads")>();
	const { EventEmitter: Emitter } = await import("node:events");
	return {
		...actual,
		Worker: class extends Emitter {
			postMessage(message: { type: string; request?: number; command?: object }): void {
				posted.push(message);
				const request = message.request;
				if (typeof request === "number") queueMicrotask(() => this.emit("message", { type: "result", request }));
			}
			terminate(): Promise<number> {
				this.emit("exit", 0);
				return Promise.resolve(0);
			}
		},
	};
});

const sessionId = "synthetic-worker-session";
const grantId = "synthetic-grant-request";
let client: SessionWorkerClient | undefined;

afterEach(async () => {
	client?.quarantine();
	await client?.exited;
	client = undefined;
	posted.length = 0;
});

async function setup() {
	const writer = new SessionEventWriter(() => {});
	for (const [id, capabilities] of [
		["question-only", ["question"]],
		["grant-client", ["grant_select"]],
		["grant-other", ["grant_select"]],
	] as const) {
		writer.registerConnection(id, { writeRaw: () => {}, waitForBackpressure: async () => {} });
		writer.setConnectionCapabilities(id, [...capabilities]);
		writer.attachConnectionToSession(id, sessionId);
	}
	client = new SessionWorkerClient({
		reserve: () => "granted",
		reconcile: () => {},
		exit: () => {},
		failure: () => {},
	});
	const binding = await client.bind(sessionId, writer, () => {}, { capabilities: [] });
	client.worker.emit("message", {
		type: "output",
		record: {
			type: "extension_ui_request",
			id: grantId,
			sessionId,
			method: "select",
			title: "synthetic grant",
			options: ["Allow once", "Deny"],
			grantSelect: true,
		},
		connection: "grant-client",
		signal: new SharedArrayBuffer(4),
		activity: { busy: false, handoffBusy: false, streaming: false },
	});
	const forwarded = () => posted.filter((message) => message.type === "command").map((message) => message.command);
	const answer = (connection: string, frame: Record<string, unknown>) =>
		writer.withConnection(connection, () => binding.handle({ type: "extension_ui_response", ...frame } as never));
	return { forwarded, answer };
}

it("grant answer correlation: a worker grant ignores a long-form answer from a connection without grant_select", async () => {
	const { forwarded, answer } = await setup();
	await answer("question-only", { id: "answer-frame-a", uiRequestId: grantId, value: "Allow once" });
	expect(forwarded()).toEqual([]);
	await answer("grant-client", { id: grantId, value: "Deny" });
	expect(forwarded()).toEqual([expect.objectContaining({ id: grantId, value: "Deny" })]);
});

it("grant answer correlation: a worker grant ignores a long-form answer from another grant_select connection", async () => {
	const { forwarded, answer } = await setup();
	await answer("grant-other", { id: "answer-frame-b", uiRequestId: grantId, value: "Allow once" });
	expect(forwarded()).toEqual([]);
	await answer("grant-client", { id: grantId, value: "Deny" });
	expect(forwarded()).toEqual([expect.objectContaining({ id: grantId, value: "Deny" })]);
});

it("grant answer correlation: a worker grant forwards the capable sender's short-form answer", async () => {
	const { forwarded, answer } = await setup();
	await answer("grant-client", { id: grantId, value: "Deny" });
	expect(forwarded()).toEqual([expect.objectContaining({ id: grantId, value: "Deny" })]);
});

it("grant answer correlation: a worker grant forwards the capable sender's long-form answer", async () => {
	const { forwarded, answer } = await setup();
	await answer("grant-client", { id: "answer-frame-d", uiRequestId: grantId, value: "Deny" });
	expect(forwarded()).toEqual([expect.objectContaining({ id: "answer-frame-d", uiRequestId: grantId })]);
});
