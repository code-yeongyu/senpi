// D11 S3-6b (senpi#4249, design 2.9): terminal control connections present MCP forms on the TUI's own authority.
import { afterEach, beforeAll, expect, it } from "vitest";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import {
	answerFrame,
	type ControlClient,
	heldTerminal,
	PRESENTER_ROLES,
	terminalPresenter,
} from "./fixtures/presenter-terminal.ts";

const open: Array<() => Promise<void>> = [];
beforeAll(() => initTheme("dark"));
afterEach(async () => {
	for (const close of open.splice(0).reverse()) await close();
});

async function terminal(options: Parameters<typeof terminalPresenter>[0] = {}) {
	const fixture = await terminalPresenter(options);
	open.push(fixture.close);
	return fixture;
}

const CONTEXT_FIELDS = ["attachmentEpoch", "attachmentId", "bindingEpoch", "connectionNonce", "hostInstance"];

it("T13 the terminal endpoint answers mcp_presenter_context for an attached interactive_user + mcp_form_presenter_v1 connection", async () => {
	const t = await terminal();
	const presenter = await t.client();

	const reply = await presenter.request({ type: "mcp_presenter_context", sessionId: t.sessionId });
	const discovered = await presenter.request({
		type: "mcp_presenter_context",
		sessionId: t.sessionId,
		discover: true,
	});
	const roleless = await t.client(["interactive_user"]);
	const detached = await t.client(undefined, false);

	expect(reply).toMatchObject({ type: "mcp_form_reply", ok: true, context: { bindingEpoch: t.local.epoch } });
	expect(Object.keys(reply.context ?? {}).sort()).toEqual(CONTEXT_FIELDS);
	expect(discovered).toMatchObject({ ok: true, context: { controlEndpoint: expect.any(String) } });
	for (const other of [roleless, detached])
		expect(await other.request({ type: "mcp_presenter_context", sessionId: t.sessionId })).toMatchObject({
			type: "mcp_form_reply",
			error: "presenter_not_authorized",
		});
});

it("T14 a terminal private frame from a non-holder is presenter_not_authorized, before any dialog lookup", async () => {
	const held = heldTerminal();
	const t = await terminal({ select: held.select });
	const presenter = await t.client();
	const roleless = await t.client(["interactive_user"]);
	const result = t.present();
	await held.shown;
	const invented = {
		sessionId: t.sessionId,
		bindingEpoch: t.local.epoch,
		attachmentEpoch: "invented-attachment",
		grantId: "invented-grant",
		dialogId: "invented-dialog",
		dialogToken: "invented-token",
		formRevision: "invented-revision",
	};

	for (const client of [presenter, roleless])
		for (const type of ["mcp_form_presented", "mcp_form_response", "mcp_form_sync"])
			expect(
				await client.request({ type, ...invented, ...(type === "mcp_form_response" && { action: "accept" }) }),
			).toEqual({ type: "mcp_form_reply", id: expect.any(String), error: "presenter_not_authorized" });
	expect(presenter.records.some((record) => record.type === "mcp_form_request")).toBe(false);
	t.local.dispose();
	expect(await result).toMatchObject({ humanAdmission: false });
});

it("T15 TUI-only behaviour is unchanged when nobody enrolls: the terminal answers and a non-holder gets no request", async () => {
	const t = await terminal();
	const presenter = await t.client();
	expect(await presenter.request({ type: "mcp_presenter_context", sessionId: t.sessionId })).toMatchObject({
		ok: true,
	});

	const outcome = await t.present({ schema: { type: "object", properties: {} } });
	await presenter.request({ type: "get_state" });

	expect(outcome).toMatchObject({
		kind: "result",
		result: { action: "accept", content: {} },
		source: "presenter_action",
		humanAdmission: true,
	});
	expect(t.admissions()).toBe(1);
	expect(
		presenter.records.filter(
			(record) => String(record.type).startsWith("mcp_form_") && record.type !== "mcp_form_reply",
		),
	).toEqual([]);
});

it("T16 terminal and an enrolled desktop: the first answer wins and the audit names the winner", async () => {
	const held = heldTerminal();
	const t = await terminal({ select: held.select });
	const desktop = await t.client();
	const enrolled = await t.enrollDesktop(desktop);
	expect(enrolled.acquired).toMatchObject({ type: "mcp_presenter_acquired" });

	const result = t.present();
	const request = await desktop.waitFor((record) => record.type === "mcp_form_request");
	const tuiDialog = await held.shown;
	expect(await desktop.request(answerFrame(request, "mcp_form_presented"))).toMatchObject({ ok: true });
	const accepted = await desktop.request(
		answerFrame(request, "mcp_form_response", { action: "accept", content: { name: "from-desktop" } }),
	);
	const settled = await desktop.waitFor((record) => record.type === "mcp_form_settled");

	expect(accepted).toMatchObject({ ok: true });
	expect(await result).toMatchObject({
		kind: "result",
		result: { action: "accept", content: { name: "from-desktop" } },
		humanAdmission: true,
	});
	expect(tuiDialog.aborted).toBe(true);
	expect(t.admissions()).toBe(1);
	expect(settled).toMatchObject({
		sessionId: t.sessionId,
		outcome: "answered",
		answeredBy: { principalKind: "account", dev: "device-a", dname: "Work laptop", presenterKind: "desktop" },
	});
	expect(await desktop.request(answerFrame(request, "mcp_form_response", { action: "decline" }))).toMatchObject({
		error: "form_stale",
	});
});

const EMPTY_FORM = { schema: { type: "object", properties: {} } } as const;
const TERMINAL_ANSWER = {
	kind: "result",
	result: { action: "accept", content: {} },
	source: "presenter_action",
	humanAdmission: true,
};

type Terminal = Awaited<ReturnType<typeof terminal>>;
const REVOCATIONS: ReadonlyArray<{
	readonly name: string;
	readonly open: boolean;
	readonly revoke: (t: Terminal, desktop: ControlClient) => Promise<void>;
}> = [
	{
		name: "release_attachment",
		open: true,
		revoke: async (t, desktop) => {
			expect(await desktop.request({ type: "release_attachment", sessionId: t.sessionId })).toMatchObject({
				success: true,
			});
		},
	},
	{
		// Declaring the roles again afterwards does not bring the grant back.
		name: "a re-declare without mcp_form_presenter_v1",
		open: true,
		revoke: async (_t, desktop) => {
			for (const capabilities of [["interactive_user"], PRESENTER_ROLES])
				expect(await desktop.request({ type: "set_client_info", capabilities })).toMatchObject({ success: true });
		},
	},
	{
		name: "connection close",
		open: false,
		revoke: async (_t, desktop) => desktop.close(),
	},
];

/** The terminal binding's next holder change: the revocation itself, observed before any later form can fall back. */
function nextHolderChange(t: Terminal): Promise<void> {
	const subscribe = t.local.binding.subscribe;
	if (!subscribe) throw new Error("Missing binding subscription");
	const changed = Promise.withResolvers<void>();
	const timer = setTimeout(() => changed.reject(new Error("holder change deadline")), 10_000);
	const unsubscribe = subscribe(() => {
		clearTimeout(timer);
		unsubscribe();
		changed.resolve();
	});
	return changed.promise;
}

it.each(REVOCATIONS)("$name revokes the desktop's grant: the next form reaches only the terminal", async (row) => {
	const t = await terminal();
	const desktop = await t.client();
	expect((await t.enrollDesktop(desktop)).acquired).toMatchObject({ type: "mcp_presenter_acquired" });

	const revoked = nextHolderChange(t);
	await row.revoke(t, desktop);
	await revoked;
	const outcome = await t.present(EMPTY_FORM);
	// A request to a holder is written before the terminal answers, so it precedes this reply on the same socket.
	if (row.open) await desktop.request({ type: "mcp_presenter_context", sessionId: t.sessionId });

	expect(outcome).toMatchObject(TERMINAL_ANSWER);
	expect(t.admissions()).toBe(1);
	expect(desktop.records.filter((record) => record.type === "mcp_form_request")).toEqual([]);
});

it("stopping the control endpoint leaves the terminal's own local_tui presenter answering", async () => {
	const t = await terminal();
	const desktop = await t.client();
	expect((await t.enrollDesktop(desktop)).acquired).toMatchObject({ type: "mcp_presenter_acquired" });

	await t.endpoint.dispose();

	expect(await t.present(EMPTY_FORM)).toMatchObject(TERMINAL_ANSWER);
	expect(t.admissions()).toBe(1);
});
