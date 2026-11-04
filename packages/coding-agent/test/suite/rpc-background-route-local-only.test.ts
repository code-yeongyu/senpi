/**
 * D11 S3-5 (senpi#4249): a secret or grant select with no raising connection (a background call) is never routed to a
 * delegated connection (senpi#5632) or one that declared `remoteOrigin`; non-raisers that opted into `raiser_notice_v1`
 * see a value-free notice, and only the raiser can answer.
 *
 * Connections declare through the real host core (`createHostCore.handle`), so the delegation state and the declared
 * origin are the ones the host itself records.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { getMcpGrantPresentation } from "../../src/core/mcp-grant-presentations.ts";
import { SecurityNoticeSnapshot } from "../../src/core/security-notices.ts";
import { createHostCore } from "../../src/modes/rpc/multi-session-host.ts";
import { SecretInputRequests } from "../../src/modes/rpc/secret-input-requests.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

type Frame = Record<string, unknown>;
type Kind = "local" | "remote" | "delegated";

const SESSION = "synthetic-session";
const SECRET_CAPS = ["interactive_user", "secret_input_v1"];
const ORIGIN = { deviceId: "synthetic-device", deviceName: "Synthetic laptop" };
const CANARY_VALUE = "canary-value-7f3e";
const CANARY_ANSWER = "canary-answer-id-91c2";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function host() {
	const root = await mkdtemp(join(tmpdir(), "background-route-"));
	const writer = new SessionEventWriter(() => {});
	const core = createHostCore(
		{
			agentDir: root,
			cwd: root,
			createRuntime: async () => {
				throw new Error("no session is opened");
			},
		},
		writer,
	);
	cleanups.push(async () => {
		await core.router.dispose();
		await rm(root, { recursive: true, force: true });
	});
	const frames = new Map<string, Frame[]>();
	const handle = (connection: string, record: Frame) =>
		writer.withConnection(connection, () => core.handle(JSON.stringify(record)));
	const received = async (id: string) => {
		await writer.flushConnection(id);
		return frames.get(id) ?? [];
	};
	const connect = async (id: string, kind: Kind, capabilities: readonly string[]) => {
		const records: Frame[] = [];
		frames.set(id, records);
		writer.registerConnection(
			id,
			{
				writeRaw: (chunk) => {
					for (const line of chunk.split("\n").filter(Boolean)) records.push(JSON.parse(line));
				},
				waitForBackpressure: async () => {},
			},
			kind === "delegated" ? { launchProof: "proven" } : {},
		);
		if (kind === "delegated")
			await handle(id, {
				type: "declare_delegation",
				id: `${id}-delegation`,
				principal: { deviceId: ORIGIN.deviceId },
				granted: ["observe", "drive", "answer"],
			});
		await handle(id, {
			type: "set_client_info",
			id: `${id}-info`,
			width: 80,
			capabilities: [...capabilities],
			...(kind === "remote" ? { remoteOrigin: ORIGIN } : {}),
		});
		const replies = (await received(id)).filter((frame) => frame.type === "response");
		expect(replies.map((reply) => [reply.id, reply.success])).toEqual([
			...(kind === "delegated" ? [[`${id}-delegation`, true]] : []),
			[`${id}-info`, true],
		]);
		records.length = 0;
		writer.attachConnectionToSession(id, SESSION);
	};
	return { writer, handle, connect, received };
}

const secretPrompts = (frames: readonly Frame[]) =>
	frames.filter((frame) => frame.type === "extension_ui_request" && frame.secret === true);

it("a delegated or remote connection declaring secret_input_v1 is never the background route for a secret", async () => {
	const h = await host();
	// Registered first: today's registration-order fallback would pick one of them.
	await h.connect("remote", "remote", SECRET_CAPS);
	await h.connect("delegated", "delegated", SECRET_CAPS);
	const requests = new SecretInputRequests(h.writer.secretInputRoute(SESSION), () => {});
	cleanups.push(() => requests.close());

	const outcome = requests.input("Synthetic credential", undefined).then(
		() => "presented",
		(error: { reason?: string }) => error.reason,
	);
	expect(secretPrompts(await h.received("remote"))).toEqual([]);
	expect(secretPrompts(await h.received("delegated"))).toEqual([]);
	expect(await outcome).toBe("no_presenter");

	await h.connect("local", "local", SECRET_CAPS);
	void requests.input("Synthetic credential", undefined);
	const [prompt] = secretPrompts(await h.received("local"));
	expect(prompt?.id).toEqual(expect.any(String));
	expect(secretPrompts(await h.received("remote"))).toEqual([]);
	expect(secretPrompts(await h.received("delegated"))).toEqual([]);
	for (const foreign of ["remote", "delegated"])
		expect(
			h.writer.withConnection(foreign, () =>
				requests.respond({
					type: "extension_ui_response",
					id: `${foreign}-answer`,
					uiRequestId: prompt?.id,
					answerId: `${foreign}-answer-id`,
					secret: true,
					value: "synthetic",
				}),
			),
		).toMatchObject({ success: false, error: "secret_answer_refused" });
});

it("a delegated or remote connection declaring grant_select is never the background route for a grant select", async () => {
	const h = await host();
	await h.connect("remote", "remote", ["grant_select"]);
	await h.connect("delegated", "delegated", ["grant_select"]);
	const cancelled: string[] = [];
	expect(h.writer.routeWorkerGrant(SESSION, "grant-a", undefined, [], () => cancelled.push("grant-a"))).toEqual({
		accepted: false,
	});
	expect(cancelled).toEqual(["grant-a"]);

	// The in-process path: each capable attached connection registers as a grant presentation.
	const durableId = "synthetic-durable-grant-session";
	const presentedOn: (string | undefined)[] = [];
	const ui = {
		select: async () => {
			presentedOn.push(h.writer.currentConnection());
			return undefined;
		},
	} as unknown as ExtensionUIContext;
	const unbind = h.writer.bindSecurityPresentations(SESSION, durableId, new SecurityNoticeSnapshot(), ui);
	cleanups.push(() => unbind?.());
	expect(getMcpGrantPresentation(durableId)).toBeUndefined();

	await h.connect("local", "local", ["grant_select"]);
	expect(h.writer.routeWorkerGrant(SESSION, "grant-b", undefined, [], () => cancelled.push("grant-b"))).toEqual({
		accepted: true,
		connection: "local",
	});
	await getMcpGrantPresentation(durableId)?.("Synthetic grant", ["Grant and save permanently", "Start without them"]);
	expect(presentedOn).toEqual(["local"]);
	expect(cancelled).toEqual(["grant-a"]);
});

it("raiser-only stays raiser-only: a non-raiser, remote viewer or observer cannot answer a secret or grant", async () => {
	const h = await host();
	await h.connect("local", "local", [...SECRET_CAPS, "grant_select"]);
	await h.connect("other", "local", [...SECRET_CAPS, "grant_select"]);
	await h.connect("viewer", "remote", [...SECRET_CAPS, "grant_select"]);
	await h.connect("observer", "local", ["dialog_observer"]);
	const requests = new SecretInputRequests(h.writer.secretInputRoute(SESSION), () => {});
	cleanups.push(() => requests.close());
	void h.writer.withConnection("local", () => requests.input("Synthetic credential", undefined));
	const [prompt] = secretPrompts(await h.received("local"));
	for (const foreign of ["other", "viewer", "observer"])
		expect(
			h.writer.withConnection(foreign, () =>
				requests.respond({
					type: "extension_ui_response",
					id: `${foreign}-answer`,
					uiRequestId: prompt?.id,
					answerId: `${foreign}-answer-id`,
					secret: true,
					value: "synthetic",
				}),
			),
		).toMatchObject({ success: false, error: "secret_answer_refused" });
	expect(h.writer.routeWorkerGrant(SESSION, "grant-c", "local", [], () => {})).toEqual({
		accepted: true,
		connection: "local",
	});
	for (const foreign of ["other", "viewer", "observer"])
		expect(h.writer.acceptWorkerGrantResponse(SESSION, "grant-c", foreign)).toBe(false);
	expect(h.writer.acceptWorkerGrantResponse(SESSION, "grant-c", "local")).toBe(true);
});

it("non-raisers that opted in see a value-free secret notice; the value and answer id never reach them", async () => {
	const h = await host();
	await h.connect("local", "local", SECRET_CAPS);
	await h.connect("viewer", "remote", ["raiser_notice_v1"]);
	await h.connect("legacy", "local", []);
	const requests = new SecretInputRequests(h.writer.secretInputRoute(SESSION), () => {});
	cleanups.push(() => requests.close());
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
	const seen = JSON.stringify([viewer, await h.received("legacy")]);
	expect(seen).not.toContain(CANARY_VALUE);
	expect(seen).not.toContain(CANARY_ANSWER);
});

it("a notice names the raising device; a remote raiser without secret support gets no prompt and no notice", async () => {
	const h = await host();
	await h.connect("forwarded", "remote", SECRET_CAPS);
	await h.connect("bare-remote", "remote", ["interactive_user"]);
	await h.connect("viewer", "local", ["raiser_notice_v1"]);
	const requests = new SecretInputRequests(h.writer.secretInputRoute(SESSION), () => {});
	cleanups.push(() => requests.close());
	// N4: relayd declares no secret_input_v1 for a forwarded viewer, so its own turn's secret ends unavailable.
	await expect(
		h.writer.withConnection("bare-remote", () => requests.input("Synthetic credential", undefined)),
	).rejects.toMatchObject({ code: "secret_input_unavailable", reason: "client_unsupported" });
	expect(await h.received("viewer")).toEqual([]);
	// The raising-connection path is unchanged: a remote raiser that declares support still presents its own prompt.
	void h.writer.withConnection("forwarded", () => requests.input("Synthetic credential", undefined));
	const [prompt] = secretPrompts(await h.received("forwarded"));
	expect(await h.received("viewer")).toEqual([
		expect.objectContaining({ type: "secret_input_notice", uiRequestId: prompt?.id, raisedBy: "forwarded", remoteOrigin: ORIGIN }),
	]);
});

it("non-raisers that opted in see a grant-select notice and its settle record", async () => {
	const h = await host();
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
