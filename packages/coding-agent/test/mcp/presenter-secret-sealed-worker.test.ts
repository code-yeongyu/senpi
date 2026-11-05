import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SecretInputRequests } from "../../src/modes/rpc/secret-input-requests.ts";
import { SessionWorkerClient } from "../../src/modes/rpc/session-worker-client.ts";
import { createWorkerCredit } from "../../src/modes/rpc/session-worker-credit.ts";
import type { HostToSessionWorker, SessionWorkerToHost } from "../../src/modes/rpc/session-worker-protocol.ts";
import { WorkerSecretRoutes } from "../../src/modes/rpc/session-worker-secret-route.ts";
import { WorkerSecretIds } from "../../src/modes/rpc/session-worker-secrets.ts";
import { accountHost, closeAccountHosts, issuer } from "./fixtures/presenter-account-host.ts";
import { holder, records, sealedTypes } from "./fixtures/secret-sealed-host.ts";
import { secretHostIssuer } from "./fixtures/secret-host-issuer.ts";
import { cancelAnswer, requestHash, valueAnswer, type AnswerIds } from "./fixtures/secret-sealed-presenter.ts";

// D11 secret phase S5-4 (senpi#4249), design 5.5: the worker runtime. Only the thread boundary is replaced: the host
// half is the real SessionWorkerClient over the real presenter control, and the isolate half is the real worker route
// and latch, reached through the same protocol messages a worker thread posts.

const bridge = vi.hoisted(() => ({
	onPost: undefined as ((worker: EventEmitter, message: HostToSessionWorker) => void) | undefined,
}));

vi.mock("node:worker_threads", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:worker_threads")>();
	const { EventEmitter: Emitter } = await import("node:events");
	return {
		...actual,
		Worker: class extends Emitter {
			postMessage(message: HostToSessionWorker): void {
				bridge.onPost?.(this, message);
			}
			terminate(): Promise<number> {
				this.emit("exit", 0);
				return Promise.resolve(0);
			}
		},
	};
});

let clients: SessionWorkerClient[] = [];
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(async () => {
	for (const client of clients) {
		client.quarantine();
		await client.exited;
	}
	clients = [];
	bridge.onPost = undefined;
	await closeAccountHosts();
	vi.useRealTimers();
});

async function workerHost(options: { readonly holdAnswers?: boolean; readonly forgedReply?: unknown } = {}) {
	const secret = secretHostIssuer(issuer);
	const host = await accountHost({ account: secret.authority });
	const held: Array<() => void> = [];
	const answers: HostToSessionWorker[] = [];
	let routes: WorkerSecretRoutes | undefined;
	bridge.onPost = (worker, message) => {
		if (message.type === "secret_sealed_answer") {
			answers.push(message);
			const reply = async () => {
				const result = "forgedReply" in options ? options.forgedReply : await routes?.answer(message.answer);
				worker.emit("message", { type: "secret_sealed_result", request: message.request, reply: result });
			};
			if (options.holdAnswers) held.push(() => void reply());
			else void reply();
			return;
		}
		if (message.type === "cancel_secret") return routes?.cancels.get(message.id)?.();
		if ("request" in message)
			queueMicrotask(() => worker.emit("message", { type: "result", request: message.request }));
	};
	const client = new SessionWorkerClient({
		reserve: () => "granted",
		reconcile: () => {},
		exit: () => {},
		failure: () => {},
	});
	clients.push(client);
	await client.bind("session", host.writer, () => {}, { capabilities: [] });
	const credit = createWorkerCredit(
		(message: SessionWorkerToHost) => client.worker.emit("message", message),
		(error) => {
			throw new Error(error);
		},
	);
	routes = new WorkerSecretRoutes(credit.exchange, () => undefined);
	const requests = new SecretInputRequests(routes.route(), () => {});
	return {
		host,
		secret,
		requests,
		answers,
		exchange: credit.exchange,
		release: () => held.splice(0).forEach((run) => run()),
	};
}

type Holder = Awaited<ReturnType<typeof holder>>;

function ids(phone: Holder, request: Record<string, unknown>, req: string, answerId = "answer-1"): AnswerIds {
	return {
		id: `line-${answerId}`,
		req,
		principalId: String(phone.adopted.principalId),
		grantId: String(phone.adopted.acquired?.grantId),
		uiRequestId: String(request.uiRequestId),
		answerId,
	};
}

async function answer(host: Awaited<ReturnType<typeof workerHost>>["host"], phone: Holder, frame: object) {
	host.writer.withConnection(phone.id, () => host.writer.handleMcpForm(frame));
	for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setImmediate(resolve));
	return records(phone.lines, "mcp_presenter_secret_reply").at(-1);
}

async function pending(w: Awaited<ReturnType<typeof workerHost>>) {
	const phone = await holder(w.host, w.secret, "phone");
	const state: { value: string | undefined | null } = { value: null };
	void w.requests.input("API key", undefined).then((value) => {
		state.value = value;
	});
	const request = records(phone.lines, "mcp_presenter_secret_request")[0];
	if (!request) throw new Error("No sealed request reached the holder");
	const req = requestHash(request, w.host.control.sealed?.tokens.hostJkt ?? "");
	const stepup = () => w.secret.stepUp(phone.adopted.device.publicKey, req);
	return { phone, state, request, req, stepup };
}

it("on the worker runtime, a raiser-refused secret with a sealed holder is accepted and offered, signed, to the holder", async () => {
	const w = await workerHost();
	const p = await pending(w);
	expect(p.request).toMatchObject({ type: "mcp_presenter_secret_request", sessionId: "session", title: "API key" });
	expect(records(w.host.lines, "extension_ui_request")).toEqual([]);
	expect(p.state.value).toBeNull();
});

it("a sealed answer settles through secret_sealed_answer at the isolate's latch; the winner alone is not elsewhere", async () => {
	const w = await workerHost();
	const p = await pending(w);
	const frame = valueAnswer(
		ids(p.phone, p.request, p.req),
		p.request,
		p.stepup(),
		"worker-value",
		p.phone.adopted.device.privateKey,
	);
	expect(await answer(w.host, p.phone, frame)).toMatchObject({ disposition: "applied" });
	expect(w.answers).toHaveLength(1);
	expect(JSON.stringify(w.answers)).not.toContain("worker-value");
	expect(p.state.value).toBe("worker-value");
	expect(records(p.phone.lines, "mcp_presenter_secret_settled")).toMatchObject([
		{ outcome: "answered", elsewhere: false },
	]);
	expect(await answer(w.host, p.phone, frame)).toMatchObject({ disposition: "replay" });
});

it("a losing answer is never decrypted by the isolate: after a win, an undecryptable value is already_answered", async () => {
	const w = await workerHost();
	const p = await pending(w);
	const tablet = await holder(w.host, w.secret, "tablet");
	expect(sealedTypes(tablet.lines)).toEqual([]);
	const win = cancelAnswer(ids(p.phone, p.request, p.req), p.phone.adopted.device.privateKey);
	expect(await answer(w.host, p.phone, win)).toMatchObject({ disposition: "applied" });
	const late = valueAnswer(
		ids(p.phone, p.request, p.req, "answer-2"),
		p.request,
		p.stepup(),
		"v",
		p.phone.adopted.device.privateKey,
		{
			sealTo: Buffer.alloc(32, 9),
		},
	);
	expect(await answer(w.host, p.phone, late)).toMatchObject({ error: "already_answered" });
	expect(p.state.value).toBeUndefined();
});

it("a bad ciphertext leaves the worker's request open, and its step-up jti is spent in the isolate", async () => {
	const w = await workerHost();
	const p = await pending(w);
	const stepup = p.stepup();
	const bad = valueAnswer(ids(p.phone, p.request, p.req), p.request, stepup, "v", p.phone.adopted.device.privateKey, {
		plaintext: Buffer.concat([Buffer.from([0, 0, 0, 1, 0x61]), Buffer.alloc(251, 1)]),
	});
	expect(await answer(w.host, p.phone, bad)).toMatchObject({ error: "invalid_secret_response" });
	const reused = valueAnswer(
		ids(p.phone, p.request, p.req, "answer-2"),
		p.request,
		stepup,
		"v",
		p.phone.adopted.device.privateKey,
	);
	expect(await answer(w.host, p.phone, reused)).toMatchObject({ error: "secret_stepup_refused" });
	expect(p.state.value).toBeNull();
});

it("answers for one request are serialized: one in flight and four queued, the sixth is refused", async () => {
	const w = await workerHost({ holdAnswers: true });
	const p = await pending(w);
	for (let n = 1; n <= 6; n++)
		w.host.writer.withConnection(p.phone.id, () =>
			w.host.writer.handleMcpForm(
				cancelAnswer(ids(p.phone, p.request, p.req, `answer-${n}`), p.phone.adopted.device.privateKey),
			),
		);
	for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setImmediate(resolve));
	expect(w.answers).toHaveLength(1);
	expect(records(p.phone.lines, "mcp_presenter_secret_reply")).toEqual([
		{ type: "mcp_presenter_secret_reply", id: "line-answer-6", error: "secret_answer_refused" },
	]);
	w.release();
	for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setImmediate(resolve));
	expect(records(p.phone.lines, "mcp_presenter_secret_reply")[1]).toMatchObject({
		id: "line-answer-1",
		disposition: "applied",
	});
});

it("a sealed-only worker request never accepts a forwarded extension_ui_response", async () => {
	const w = await workerHost();
	const p = await pending(w);
	const response = {
		type: "extension_ui_response",
		id: "r1",
		uiRequestId: p.request.uiRequestId,
		answerId: "a",
		secret: true,
		value: "plaintext",
	};
	expect(w.requests.respond(response)).toMatchObject({ success: false, error: "secret_answer_refused" });
	expect(p.state.value).toBeNull();
});

it("the host admits a worker's sealed offer once per id and within the secret frame bound", () => {
	const ids = new WorkerSecretIds();
	ids.add("r1");
	const offer = { type: "secret_sealed_offer", hpkePk: "k", title: "t", deadlineAtMs: 1 };
	expect(ids.admitFrame("r1", offer)).toBe(true);
	expect(ids.admitFrame("r1", offer)).toBe(false);
	ids.add("r2");
	expect(ids.admitFrame("r2", { ...offer, title: "x".repeat(70 * 1024) })).toBe(false);
	expect(ids.admitFrame("unknown", offer)).toBe(false);
});

type Settle = { outcome?: string; winnerGrant?: string };
const settle = (w: Awaited<ReturnType<typeof workerHost>>, id: string, fields: Settle) =>
	w.exchange((signal) => ({ type: "secret_settled", id, signal, ...fields }) as SessionWorkerToHost);

it("the host refuses an isolate's settle for an id it does not hold, with an unknown outcome, or naming a winner it never forwarded", async () => {
	const w = await workerHost();
	const p = await pending(w);
	const id = String(p.request.uiRequestId);
	expect(() => settle(w, "not-held", { outcome: "answered" })).toThrow("session_worker_output_denied");
	expect(() => settle(w, id, { outcome: "x".repeat(4096) })).toThrow("session_worker_output_denied");
	expect(() => settle(w, id, { outcome: "answered", winnerGrant: String(p.phone.adopted.acquired?.grantId) })).toThrow(
		"session_worker_output_denied",
	);
	expect(records(p.phone.lines, "mcp_presenter_secret_settled")).toEqual([]);
});

it("the host admits one settle per id: a repeated settle from the isolate is refused", async () => {
	const w = await workerHost();
	const p = await pending(w);
	const id = String(p.request.uiRequestId);
	settle(w, id, { outcome: "timed_out" });
	expect(() => settle(w, id, { outcome: "timed_out" })).toThrow("session_worker_output_denied");
	expect(records(p.phone.lines, "mcp_presenter_secret_settled")).toHaveLength(1);
});

it("a sealed offer whose hpkePk is not a 32-byte key, or that is malformed, is refused, never relayed as a raiser frame", async () => {
	const w = await workerHost();
	w.host.writer.setConnectionCapabilities("human", ["interactive_user", "mcp_form_presenter_v1", "secret_input_v1"]);
	void w.requests.input("API key", undefined);
	const raised = records(w.host.lines, "extension_ui_request")[0];
	if (!raised) throw new Error("No raiser request");
	for (const hpkePk of [123, "a".repeat(42), "a".repeat(44)])
		expect(() =>
			w.exchange(
				(signal) =>
					({
						type: "secret_frame",
						id: String(raised.id),
						record: { type: "secret_sealed_offer", hpkePk, title: "t", deadlineAtMs: 1 },
						signal,
					}) as SessionWorkerToHost,
			),
		).toThrow("session_worker_output_denied");
	expect(records(w.host.lines, "secret_sealed_offer")).toEqual([]);
});

it("the host relays an isolate's sealed answer result only in a shape its latch produces: injected type, id and fields never reach the holder", async () => {
	const w = await workerHost({
		forgedReply: { disposition: "applied", type: "mcp_form_request", id: "forged-id", extra: "x".repeat(70_000) },
	});
	const p = await pending(w);
	const frame = valueAnswer(
		ids(p.phone, p.request, p.req),
		p.request,
		p.stepup(),
		"v",
		p.phone.adopted.device.privateKey,
	);
	const reply = await answer(w.host, p.phone, frame);
	expect(reply).toEqual({ type: "mcp_presenter_secret_reply", id: "line-answer-1", disposition: "applied" });
	expect(records(p.phone.lines, "mcp_form_request")).toEqual([]);
});

it("an isolate's sealed answer result with an unknown error or shape is relayed as secret_answer_refused", async () => {
	for (const forgedReply of [{ error: "nope".repeat(10) }, "not an object", { disposition: "won" }]) {
		const w = await workerHost({ forgedReply });
		const p = await pending(w);
		const frame = valueAnswer(
			ids(p.phone, p.request, p.req),
			p.request,
			p.stepup(),
			"v",
			p.phone.adopted.device.privateKey,
		);
		expect(await answer(w.host, p.phone, frame)).toEqual({
			type: "mcp_presenter_secret_reply",
			id: "line-answer-1",
			error: "secret_answer_refused",
		});
	}
});
