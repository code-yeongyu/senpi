/**
 * D11 S3-5 (senpi#4249): a secret or grant select with no raising connection (a background call) is never routed to a
 * delegated connection (senpi#5632) or one that declared `remoteOrigin`, and only the raiser can answer.
 */
import { afterEach, expect, it } from "vitest";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { getMcpGrantPresentation } from "../../src/core/mcp-grant-presentations.ts";
import { SecurityNoticeSnapshot } from "../../src/core/security-notices.ts";
import { SecretInputRequests } from "../../src/modes/rpc/secret-input-requests.ts";
import {
	ORIGIN,
	onCleanup,
	presenterHost,
	runCleanups,
	SECRET_CAPS,
	SESSION,
	secretPrompts,
} from "./rpc-presenter-routing-harness.ts";

afterEach(runCleanups);

it("a delegated or remote connection declaring secret_input_v1 is never the background route for a secret", async () => {
	const h = await presenterHost();
	// Registered first: today's registration-order fallback would pick one of them.
	await h.connect("remote", "remote", SECRET_CAPS);
	await h.connect("delegated", "delegated", SECRET_CAPS);
	const requests = new SecretInputRequests(h.writer.secretInputRoute(SESSION), () => {});
	onCleanup(() => requests.close());

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
	const h = await presenterHost();
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
	onCleanup(() => unbind?.());
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

it("a background presenter that later declares a remoteOrigin loses its background secret and grant, not its own", async () => {
	const h = await presenterHost();
	await h.connect("late", "local", [...SECRET_CAPS, "grant_select"]);
	const requests = new SecretInputRequests(h.writer.secretInputRoute(SESSION), () => {});
	onCleanup(() => requests.close());
	let secretEnded = false;
	void requests.input("Synthetic credential", undefined).then(() => {
		secretEnded = true;
	});
	const [prompt] = secretPrompts(await h.received("late"));
	const cancelled: string[] = [];
	expect(h.writer.routeWorkerGrant(SESSION, "grant-bg", undefined, [], () => cancelled.push("grant-bg"))).toEqual({
		accepted: true,
		connection: "late",
	});
	expect(h.writer.routeWorkerGrant(SESSION, "grant-own", "late", [], () => cancelled.push("grant-own"))).toEqual({
		accepted: true,
		connection: "late",
	});

	await h.handle("late", {
		type: "set_client_info",
		id: "late-info-remote",
		width: 80,
		capabilities: [...SECRET_CAPS, "grant_select"],
		remoteOrigin: ORIGIN,
	});
	expect((await h.received("late")).find((frame) => frame.id === "late-info-remote")).toMatchObject({ success: true });
	expect(secretEnded).toBe(true);
	expect(h.writer.secretInputRoute(SESSION).available(String(prompt?.id))).toBe(false);
	expect(cancelled).toEqual(["grant-bg"]);
	expect(h.writer.acceptWorkerGrantResponse(SESSION, "grant-own", "late")).toBe(true);
});

it("raiser-only stays raiser-only: a non-raiser, remote viewer or observer cannot answer a secret or grant", async () => {
	const h = await presenterHost();
	await h.connect("local", "local", [...SECRET_CAPS, "grant_select"]);
	await h.connect("other", "local", [...SECRET_CAPS, "grant_select"]);
	await h.connect("viewer", "remote", [...SECRET_CAPS, "grant_select"]);
	await h.connect("observer", "local", ["dialog_observer"]);
	const requests = new SecretInputRequests(h.writer.secretInputRoute(SESSION), () => {});
	onCleanup(() => requests.close());
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
