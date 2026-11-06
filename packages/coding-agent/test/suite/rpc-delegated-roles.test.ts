/**
 * omo-relay-daemon#307: the interactive-user role over the relay, host scope (in-process sessions). A forwarder declares
 * `roles` with its delegation (`delegation_roles_v1`), so the engine keeps an authority word per incarnation of the
 * socket; a narrowing or a `detach_connection` revokes a role for every record the engine reads after it, a delegated
 * connection's dialogs name its principal, and every response to a record numbered with `relayExec` carries the
 * `authority` receipt the relay audits. Protocol contract for the daemon half (`designs/307-senpi-wire-freeze.md`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ASK_COMMAND,
	attach,
	type DelegatedHost,
	declare,
	type OpenedSession,
	openSession as openOn,
	type Peer,
	startHost,
	type WireRecord,
} from "./rpc-delegated-host-support.ts";

const GRANT = ["observe", "drive", "thread"];
const BOTH = ["interactive_user", "task_parent"];
const VIEWER = { deviceId: "x307-device", deviceName: "Viewer" };
const NOT_INTERACTIVE = "hold_input_requires_interactive_client";

let host: DelegatedHost;
let opener: Peer;

beforeEach(() => {
	for (const name of ["OMO_RPC_SOCKET_PATH", "OMO_RPC_SOCKET", "SENPI_RPC_SOCKET", "PI_RPC_SOCKET"])
		vi.stubEnv(name, undefined);
	vi.stubEnv("SENPI_RPC_REQUIRE_ATTACH", undefined);
});
beforeAll(async () => {
	host = await startHost();
	opener = await host.proven();
});
afterAll(async () => {
	await host.dispose();
}, 60_000);

const opened = new Map<string, OpenedSession>();
async function openSession(): Promise<string> {
	const session = await openOn(opener);
	opened.set(session.sessionId, session);
	return session.sessionId;
}

function attachTo(sessionId: string): WireRecord {
	const session = opened.get(sessionId);
	if (session === undefined) throw new Error(`no session ${sessionId}`);
	return attach(session);
}

/** A host-mode peer attached to a fresh session, holding `claim` (none when empty). */
async function hostPeer(claim: readonly string[] = ["interactive_user"], granted = GRANT, principal: object = VIEWER) {
	const peer = await host.proven();
	expect(await declare(peer, granted, principal, { roles: BOTH })).toMatchObject({ success: true });
	const sessionId = await openSession();
	expect(await peer.send(attachTo(sessionId))).toMatchObject({ success: true });
	if (claim.length > 0)
		expect(await peer.send({ type: "set_client_info", capabilities: claim })).toMatchObject({ success: true });
	return { peer, sessionId };
}

let inputs = 0;
function hold(sessionId: string, extra: WireRecord = {}): WireRecord {
	return { type: "hold_input", sessionId, inputId: `x307-${++inputs}`, revision: 0, text: "guidance", ...extra };
}

/** The `remoteOrigin` of the dialog the peer's own command raises; the dialog is cancelled afterwards. */
async function dialogOrigin(peer: Peer, sessionId: string): Promise<unknown> {
	const asked = peer.frame(
		(record) =>
			record.type === "extension_ui_request" && record.sessionId === sessionId && record.title === "Question",
	);
	void peer.send({ type: "prompt", sessionId, message: `/${ASK_COMMAND}` }).catch(() => {});
	const request = await asked;
	await peer.sendSettled({ type: "extension_ui_response", sessionId, uiRequestId: request.id, cancelled: true });
	return request.remoteOrigin;
}

describe("omo-relay-daemon#307: declare_delegation roles narrow the interactive role at line receipt", () => {
	it("E1: a role narrowed to [] refuses the next hold, though the claim and the thread grant stay", async () => {
		const { peer, sessionId } = await hostPeer();
		expect(await peer.send(hold(sessionId))).toMatchObject({ success: true });
		const narrowed = await declare(peer, GRANT, VIEWER, { roles: [] });
		expect(await peer.send(hold(sessionId))).toMatchObject({ success: false, error: NOT_INTERACTIVE });
		expect(narrowed).toMatchObject({ success: true, data: { roles: [] } });
		const fresh = await host.proven();
		expect(await declare(fresh, GRANT, VIEWER, { roles: BOTH })).toMatchObject({
			success: true,
			data: { roles: BOTH },
		});
	});

	it("E2: the narrowing decides the hold written right behind it in the same chunk", async () => {
		const { peer, sessionId } = await hostPeer();
		const [narrowed, held] = peer.sendTogether([
			{ type: "declare_delegation", principal: VIEWER, granted: GRANT, roles: [] },
			hold(sessionId),
		]);
		expect(await held).toMatchObject({ success: false, error: NOT_INTERACTIVE });
		expect(await narrowed).toMatchObject({ success: true });
	});

	it("E3: a narrowed role set can never widen again", async () => {
		const { peer } = await hostPeer([]);
		expect(await declare(peer, GRANT, VIEWER, { roles: [] })).toMatchObject({ success: true });
		expect(await declare(peer, GRANT, VIEWER, { roles: ["interactive_user"] })).toMatchObject({
			success: false,
			errorCode: "delegation_fixed",
		});
	});

	it("E4: a later declaration without roles keeps the narrowed mask, so a fresh claim still cannot hold", async () => {
		const { peer, sessionId } = await hostPeer([]);
		expect(await declare(peer, GRANT, VIEWER, { roles: [] })).toMatchObject({ success: true });
		const kept = await declare(peer, GRANT, VIEWER);
		expect(await peer.send({ type: "set_client_info", capabilities: ["interactive_user"] })).toMatchObject({
			success: true,
		});
		expect(await peer.send(hold(sessionId))).toMatchObject({ success: false, error: NOT_INTERACTIVE });
		expect(kept).toMatchObject({ success: true, data: { roles: [] } });
	});

	it("E5: a connection declared without roles (legacy mode) cannot switch to host mode", async () => {
		const peer = await host.proven();
		expect(await declare(peer, GRANT, VIEWER)).toMatchObject({ success: true });
		expect((await declare(peer, GRANT, VIEWER)).data).not.toHaveProperty("roles");
		expect(await declare(peer, GRANT, VIEWER, { roles: BOTH })).toMatchObject({
			success: false,
			errorCode: "delegation_fixed",
		});
	});

	it("E6: Stop and pause_for_run lose their roles with the narrowing, not with the grant", async () => {
		const { peer, sessionId } = await hostPeer(BOTH);
		expect(await peer.send({ type: "abort", sessionId, intent: "stop" })).toMatchObject({ success: true });
		expect(await declare(peer, GRANT, VIEWER, { roles: [] })).toMatchObject({ success: true });
		expect(await peer.send({ type: "abort", sessionId, intent: "stop" })).toMatchObject({
			success: false,
			error: expect.stringContaining("stop_requires_interactive_client"),
		});
		expect(
			await peer.send({
				type: "pause_for_run",
				sessionId,
				parentSessionId: "p",
				parentPauseSeq: 1,
				runRef: { kind: "dag", id: "r1" },
			}),
		).toMatchObject({ success: false, error: expect.stringContaining("task_parent_required") });
	});

	it("E7: a narrowing intersects, so dropping interactive_user leaves the task-parent path", async () => {
		const { peer, sessionId } = await hostPeer(BOTH);
		const narrowed = await declare(peer, GRANT, VIEWER, { roles: ["task_parent"] });
		expect(await peer.send(hold(sessionId, { parentSessionId: "p" }))).toMatchObject({
			success: false,
			error: expect.stringContaining("wrong_parent"),
		});
		expect(narrowed).toMatchObject({ success: true, data: { roles: ["task_parent"] } });
	});

	it("refuses a roles member that is not a connection role", async () => {
		const peer = await host.proven();
		expect(await declare(peer, GRANT, VIEWER, { roles: ["interactive_user", "admin"] })).toMatchObject({
			success: false,
			errorCode: "delegation_malformed",
		});
	});
});

describe("omo-relay-daemon#307: a delegated connection's origin is its principal (O1)", () => {
	for (const roles of [undefined, BOTH]) {
		const mode = roles === undefined ? "legacy" : "host";
		it(`${mode} mode: a forwarded remoteOrigin never replaces the principal`, async () => {
			const expected = { deviceId: VIEWER.deviceId, deviceName: VIEWER.deviceName };
			const cases: ReadonlyArray<{ origin?: object; refusal?: string }> = [
				{},
				{ origin: { deviceId: "dev-z" } },
				{ origin: VIEWER },
				{ origin: { deviceId: 5 }, refusal: "remote_origin_invalid" },
			];
			for (const { origin, refusal } of cases) {
				const peer = await host.proven();
				expect(
					await declare(peer, [...GRANT, "device_admin"], VIEWER, roles === undefined ? {} : { roles }),
				).toMatchObject({ success: true });
				const sessionId = await openSession();
				expect(await peer.send(attachTo(sessionId))).toMatchObject({ success: true });
				const answer = await peer.send({
					type: "set_client_info",
					capabilities: ["interactive_user"],
					...(origin === undefined ? {} : { remoteOrigin: origin }),
				});
				if (refusal !== undefined) {
					expect(answer).toMatchObject({ success: false, error: expect.stringContaining(refusal) });
					continue;
				}
				expect(answer).toMatchObject({ success: true });
				expect(await dialogOrigin(peer, sessionId)).toEqual(expected);
			}
		});
	}
});

describe("omo-relay-daemon#307: responses to a relayExec record carry the authority receipt", () => {
	it("A1/A4: every path of a host-mode connection answers with {exec, incarnation, epoch, roles}", async () => {
		const { peer, sessionId } = await hostPeer();
		expect(await peer.send(hold(sessionId, { relayExec: 41 }))).toMatchObject({
			success: true,
			authority: { exec: 41, incarnation: 1, epoch: 1, roles: ["interactive_user"] },
		});
		expect(
			await peer.send({ type: "declare_delegation", principal: VIEWER, granted: GRANT, roles: [], relayExec: 42 }),
		).toMatchObject({ success: true, authority: { exec: 42, incarnation: 1, epoch: 2, roles: null } });
		expect(await peer.send(hold(sessionId, { relayExec: 43 }))).toMatchObject({
			success: false,
			error: NOT_INTERACTIVE,
			authority: { exec: 43, incarnation: 1, epoch: 2, roles: [] },
		});
		const answers = {
			get_state: await peer.send({ type: "get_state", sessionId, relayExec: 44 }),
			not_granted: await peer.send({ type: "bash", sessionId, command: "true", relayExec: 45 }),
			classify: await peer.send({ type: "classify_record", record: { type: "prompt" }, relayExec: 46 }),
			list: await peer.send({ type: "list_sessions", relayExec: 47 }),
		};
		expect(answers.get_state).toMatchObject({ success: true, authority: { exec: 44, roles: null } });
		expect(answers.not_granted).toMatchObject({
			errorCode: "delegation_not_granted",
			authority: { exec: 45, incarnation: 1, epoch: 2, roles: null },
		});
		expect(answers.classify).toMatchObject({ success: true, authority: { exec: 46, roles: null } });
		expect(answers.list).toMatchObject({ success: true, authority: { exec: 47, roles: null } });
	});

	it("A4: a relayExec that is not a positive safe integer refuses the record as malformed", async () => {
		const { peer, sessionId } = await hostPeer();
		for (const relayExec of [0, -1, 1.5, "7", null]) {
			const answer = await peer.send(hold(sessionId, { relayExec }));
			expect(answer).toMatchObject({ success: false, errorCode: "delegation_malformed" });
			expect(answer).not.toHaveProperty("authority");
		}
	});

	it("A5 (control): a legacy-mode or local connection ignores relayExec and gets no receipt", async () => {
		const legacy = await host.proven();
		expect(await declare(legacy, GRANT, VIEWER)).toMatchObject({ success: true });
		const sessionId = await openSession();
		for (const peer of [legacy, opener]) {
			const answer = await peer.send({ type: "get_state", sessionId, relayExec: 9 });
			expect(answer).toMatchObject({ success: true });
			expect(answer).not.toHaveProperty("authority");
		}
	});
});

describe("omo-relay-daemon#307: detach_connection retires the incarnation, never the delegation", () => {
	it("L1: after a narrowing and a detach, a fresh claim on the next incarnation still cannot hold", async () => {
		const granted = [...GRANT, "device_admin"];
		const { peer, sessionId } = await hostPeer(["interactive_user"], granted);
		const first = await peer.send(hold(sessionId, { relayExec: 1 }));
		expect(first).toMatchObject({ success: true, authority: { incarnation: 1 } });
		expect(await declare(peer, granted, VIEWER, { roles: [] })).toMatchObject({ success: true });
		expect(await peer.send({ type: "detach_connection" })).toMatchObject({ success: true });
		expect(
			await peer.send({
				type: "set_client_info",
				capabilities: ["interactive_user"],
				remoteOrigin: { deviceId: "z" },
			}),
		).toMatchObject({ success: true });
		expect(await peer.send(attachTo(sessionId))).toMatchObject({ success: true });
		const refused = await peer.send(hold(sessionId, { relayExec: 2 }));
		expect(refused).toMatchObject({
			success: false,
			error: NOT_INTERACTIVE,
			authority: { exec: 2, incarnation: 2, epoch: 1, roles: [] },
		});
		// The conflicting remoteOrigin above was accepted and ignored: the dialog still names the principal.
		expect(await dialogOrigin(peer, sessionId)).toEqual(VIEWER);
	});

	it("L2: without a narrowing, a claim made after the detach holds on incarnation 2; one before it does not", async () => {
		const { peer, sessionId } = await hostPeer();
		expect(await peer.send(hold(sessionId, { relayExec: 1 }))).toMatchObject({
			success: true,
			authority: { incarnation: 1, roles: ["interactive_user"] },
		});
		const [detached, early] = peer.sendTogether([{ type: "detach_connection" }, hold(sessionId, { relayExec: 2 })]);
		expect(await detached).toMatchObject({ success: true });
		expect(await early).toMatchObject({
			success: false,
			error: NOT_INTERACTIVE,
			authority: { exec: 2, incarnation: 2, roles: [] },
		});
		expect(await peer.send({ type: "set_client_info", capabilities: ["interactive_user"] })).toMatchObject({
			success: true,
		});
		expect(await peer.send(hold(sessionId, { relayExec: 3 }))).toMatchObject({
			success: true,
			authority: { exec: 3, incarnation: 2, epoch: 1, roles: ["interactive_user"] },
		});
	});
});
