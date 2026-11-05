/**
 * X2 (plan P0-03a): today's extension UI request/response correlation on a multi-session host,
 * pinned end to end. Each `extension_ui_request` carries its own `id`; an `extension_ui_response`
 * names the request it answers in `uiRequestId` (short form: `id`), is settled only against the
 * routed session's own pending requests, and is answered exactly once under the FRAME's `id`.
 * An `answerId` makes a retry a receipt (`replay`) and a competing answer a refusal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerHostRecord } from "../suite/rpc-host-endpoint.ts";
import { startInProcessHost } from "../suite/rpc-worker-host-support.ts";

const EXTENSION = `export default function (pi) {
	pi.registerCommand("ask-input", { description: "input fixture", handler: async (args, ctx) => {
		const value = await ctx.ui.input("Name " + args + "?");
		ctx.ui.notify("input:" + args + ":" + value);
	} });
}`;

const WAIT_MS = 10_000;

type Host = Awaited<ReturnType<typeof startInProcessHost>>;
type Client = Awaited<ReturnType<Host["connect"]>>;

const hosts: Host[] = [];

afterEach(async () => {
	for (const host of hosts.splice(0)) await host.dispose();
	vi.unstubAllEnvs();
});

const isReply = (id: string) => (record: WorkerHostRecord) =>
	record.type === "response" && record.command === "extension_ui_response" && record.id === id;
const isNotice = (prefix: string) => (record: WorkerHostRecord) =>
	record.type === "extension_ui_request" &&
	record.method === "notify" &&
	typeof record.message === "string" &&
	record.message.startsWith(prefix);
const isInputRequest = (sessionId: string) => (record: WorkerHostRecord) =>
	record.type === "extension_ui_request" && record.method === "input" && record.sessionId === sessionId;

async function openSession(client: Client, cwd: string): Promise<string> {
	const opened = await client.request({ type: "open_session", cwd });
	const sessionId = opened.data?.sessionId;
	if (sessionId === undefined) throw new Error("open_session returned no sessionId");
	return sessionId;
}

async function ask(client: Client, sessionId: string, who: string) {
	const asked = client.wait(isInputRequest(sessionId), WAIT_MS);
	const prompt = client.request({ type: "prompt", sessionId, message: `/ask-input ${who}` });
	const request = await asked;
	if (request.id === undefined) throw new Error("input request without an id");
	return { requestId: request.id, prompt };
}

async function answer(client: Client, frame: Record<string, unknown> & { id: string }) {
	const replied = client.wait(isReply(frame.id), WAIT_MS);
	client.send({ type: "extension_ui_response", ...frame });
	return replied;
}

describe("X2: UI-request correlation on a multi-session host", () => {
	it("settles each answer only against its routed session's request and replies once under the frame id", async () => {
		// Given: two sessions on one host, each blocked on its own input dialog
		vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
		const host = await startInProcessHost(EXTENSION);
		hosts.push(host);
		const client = await host.connect();
		const alpha = await openSession(client, host.cwd);
		const beta = await openSession(client, host.cwd);
		const first = await ask(client, alpha, "alpha");
		const second = await ask(client, beta, "beta");
		expect(first.requestId).not.toBe(second.requestId);

		// When: beta's request is answered through alpha's routing
		const crossed = await answer(client, {
			sessionId: alpha,
			id: "frame-crossed",
			uiRequestId: second.requestId,
			value: "wrong",
		});

		// Then: refused under the frame id, nothing settled
		expect(crossed).toMatchObject({
			id: "frame-crossed",
			success: false,
			error: "unknown_extension_ui_request",
			disposition: "unknown",
		});

		// When: alpha is answered in the long form with an answerId
		const alphaNotice = client.wait(isNotice("input:alpha:"), WAIT_MS);
		const applied = await answer(client, {
			sessionId: alpha,
			id: "frame-1",
			uiRequestId: first.requestId,
			answerId: "answer-a",
			value: "Ada",
		});

		// Then: applied under the frame id, and the dialog resolves with the value
		expect(applied).toMatchObject({ id: "frame-1", success: true, disposition: "applied" });
		expect((await alphaNotice).message).toBe("input:alpha:Ada");
		expect((await first.prompt).success).toBe(true);

		// When: the same answerId is retried under a new frame id, then a competing answer arrives
		const retried = await answer(client, {
			sessionId: alpha,
			id: "frame-2",
			uiRequestId: first.requestId,
			answerId: "answer-a",
			value: "Ada",
		});
		const competing = await answer(client, {
			sessionId: alpha,
			id: "frame-3",
			uiRequestId: first.requestId,
			answerId: "answer-b",
			value: "Eve",
		});

		// Then: a receipt for the retry, a refusal for the competitor, both under their own frame ids
		expect(retried).toMatchObject({ id: "frame-2", success: true, disposition: "replay" });
		expect(competing).toMatchObject({
			id: "frame-3",
			success: false,
			error: "already_answered",
			disposition: "already_answered",
		});

		// When: beta is answered in the short form (id = request id, no uiRequestId)
		const betaNotice = client.wait(isNotice("input:beta:"), WAIT_MS);
		const shortForm = await answer(client, { sessionId: beta, id: second.requestId, value: "Bob" });

		// Then: resolved under that id; each dialog resolved exactly once with its own value
		expect(shortForm).toMatchObject({ id: second.requestId, success: true, disposition: "applied" });
		expect((await betaNotice).message).toBe("input:beta:Bob");
		expect((await second.prompt).success).toBe(true);
		expect(client.records.filter(isNotice("input:"))).toHaveLength(2);
		for (const id of ["frame-crossed", "frame-1", "frame-2", "frame-3", second.requestId])
			expect(client.records.filter(isReply(id))).toHaveLength(1);
	}, 120_000);
});
