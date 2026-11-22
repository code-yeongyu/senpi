/**
 * D11 S3-5 (senpi#4249): a raiser-only dialog may be SEEN elsewhere. Attached connections other than its presenter
 * that opted into `raiser_notice_v1` get a value-free notice and a settle record; nobody else gets anything new.
 */
import { afterEach, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { getMcpGrantPresentation, selectMcpGrant } from "../../src/core/mcp-grant-presentations.ts";
import { createRpcConnectionHandler } from "../../src/modes/rpc/connection-handler.ts";
import { SecretInputRequests } from "../../src/modes/rpc/secret-input-requests.ts";
import { createHarness } from "./harness.ts";
import {
	type Frame,
	ORIGIN,
	onCleanup,
	presenterHost,
	runCleanups,
	SECRET_CAPS,
	SESSION,
	secretPrompts,
} from "./rpc-presenter-routing-harness.ts";

const CANARY_VALUE = "canary-value-7f3e";
const CANARY_ANSWER = "canary-answer-id-91c2";
const notices = (frames: readonly Frame[]) => frames.filter((frame) => String(frame.type).includes("_notice"));

afterEach(runCleanups);

it("non-raisers that opted in see a value-free secret notice; the value and answer id never reach them", async () => {
	const h = await presenterHost();
	await h.connect("local", "local", SECRET_CAPS);
	await h.connect("viewer", "remote", ["raiser_notice_v1"]);
	await h.connect("legacy", "local", []);
	const requests = new SecretInputRequests(h.writer.secretInputRoute(SESSION), () => {});
	onCleanup(() => requests.close());
	const answered = h.writer.withConnection("local", () => requests.input("Synthetic credential", undefined));
	const [prompt] = secretPrompts(await h.received("local"));
	const uiRequestId = prompt?.id;
	expect(await h.received("viewer")).toEqual([
		{
			type: "secret_input_notice",
			sessionId: SESSION,
			uiRequestId,
			title: "Synthetic credential",
			deadlineAtMs: prompt?.deadlineAtMs,
			raisedBy: "local",
		},
	]);
	expect(
		h.writer.withConnection("local", () =>
			requests.respond({
				type: "extension_ui_response",
				id: "local-answer",
				uiRequestId,
				answerId: CANARY_ANSWER,
				secret: true,
				value: CANARY_VALUE,
			}),
		),
	).toMatchObject({ success: true, disposition: "applied" });
	expect(await answered).toBe(CANARY_VALUE);
	const viewer = await h.received("viewer");
	expect(viewer.at(-1)).toEqual({
		type: "secret_input_notice_settled",
		sessionId: SESSION,
		uiRequestId,
		outcome: "answered",
	});
	expect(await h.received("legacy")).toEqual([]);
	expect(notices(await h.received("local"))).toEqual([]);
	const seen = JSON.stringify([viewer, await h.received("legacy")]);
	expect(seen).not.toContain(CANARY_VALUE);
	expect(seen).not.toContain(CANARY_ANSWER);
});

it("a notice names the raising device; a remote raiser without secret support gets no prompt and no notice", async () => {
	const h = await presenterHost();
	await h.connect("forwarded", "remote", SECRET_CAPS);
	await h.connect("bare-remote", "remote", ["interactive_user"]);
	await h.connect("viewer", "local", ["raiser_notice_v1"]);
	const requests = new SecretInputRequests(h.writer.secretInputRoute(SESSION), () => {});
	onCleanup(() => requests.close());
	// N4: relayd declares no secret_input_v1 for a forwarded viewer, so its own turn's secret ends unavailable.
	await expect(
		h.writer.withConnection("bare-remote", () => requests.input("Synthetic credential", undefined)),
	).rejects.toMatchObject({ code: "secret_input_unavailable", reason: "client_unsupported" });
	expect(await h.received("viewer")).toEqual([]);
	// The raising-connection path is unchanged: a remote raiser that declares support still presents its own prompt.
	void h.writer.withConnection("forwarded", () => requests.input("Synthetic credential", undefined));
	const [prompt] = secretPrompts(await h.received("forwarded"));
	expect(await h.received("viewer")).toEqual([
		expect.objectContaining({
			type: "secret_input_notice",
			uiRequestId: prompt?.id,
			raisedBy: "forwarded",
			remoteOrigin: ORIGIN,
		}),
	]);
});

it("non-raisers that opted in see a worker grant-select notice and its settle record", async () => {
	const h = await presenterHost();
	await h.connect("local", "local", ["grant_select"]);
	await h.connect("viewer", "remote", ["raiser_notice_v1"]);
	await h.connect("legacy", "local", []);
	const title = "Project MCP server synthetic wants: SYNTHETIC_TOKEN";
	expect(h.writer.routeWorkerGrant(SESSION, "grant-n", "local", [], () => {}, title)).toEqual({
		accepted: true,
		connection: "local",
	});
	expect(await h.received("viewer")).toEqual([
		{ type: "grant_select_notice", sessionId: SESSION, uiRequestId: "grant-n", title },
	]);
	h.writer.settleGrantDialog(SESSION, "grant-n");
	expect((await h.received("viewer")).at(-1)).toEqual({
		type: "grant_select_notice_settled",
		sessionId: SESSION,
		uiRequestId: "grant-n",
	});
	expect(await h.received("legacy")).toEqual([]);
	expect(await h.received("local")).toEqual([]);
});

it("an in-process grant select reaches non-presenters only as a notice, settled when the decision ends", async () => {
	const h = await presenterHost();
	const harness = await createHarness();
	onCleanup(() => harness.cleanup());
	await h.connect("local", "local", ["grant_select"]);
	await h.connect("viewer", "remote", ["raiser_notice_v1", "grant_select"]);
	const runtime = {
		session: harness.session,
		newSession: async () => ({ cancelled: true }),
		switchSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true, selectedText: "" }),
		dispose: async () => {},
		setRebindSession: () => {},
	} as unknown as AgentSessionRuntime;
	const handler = createRpcConnectionHandler(
		runtime,
		{
			writeRaw: (chunk) => {
				for (const line of chunk.split("\n").filter(Boolean)) h.writer.enqueue(SESSION, JSON.parse(line));
			},
			waitForBackpressure: async () => {},
		},
		{
			sessionId: SESSION,
			disposeRuntime: false,
			bindSecurityPresentation: (session, ui) =>
				h.writer.bindSecurityPresentations(SESSION, session.sessionId, session.securityNotices, ui),
			grantDialogRaised: (id, title) => h.writer.noticeGrantDialog(SESSION, id, title),
			grantDialogSettled: (id) => h.writer.settleGrantDialog(SESSION, id),
			clientInfo: {
				connectionId: () => h.writer.currentConnection(),
				setCapabilities: () => {},
				hasCapability: (id, capability) => h.writer.getConnectionCapabilities(id)?.includes(capability) === true,
			},
		},
	);
	onCleanup(() => handler.dispose());
	await handler.ready;
	const decision = selectMcpGrant(getMcpGrantPresentation(harness.session.sessionId), "Synthetic grant");
	const [frame] = (await h.received("local")).filter((record) => record.grantSelect === true);
	expect(notices(await h.received("viewer"))).toEqual([
		{ type: "grant_select_notice", sessionId: SESSION, uiRequestId: frame?.id, title: "Synthetic grant" },
	]);
	expect((await h.received("viewer")).some((record) => record.grantSelect === true)).toBe(false);
	await h.writer.withConnection("local", () =>
		handler.handleInputLine(JSON.stringify({ type: "extension_ui_response", id: frame?.id, value: "Deny" })),
	);
	expect(await decision).toBe(false);
	expect(notices(await h.received("viewer")).at(-1)).toEqual({
		type: "grant_select_notice_settled",
		sessionId: SESSION,
		uiRequestId: frame?.id,
	});
});
