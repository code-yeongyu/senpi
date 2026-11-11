/**
 * omo-relay-daemon#307, host scope: a delegated connection's dialogs name its principal in both modes (O1), and every
 * response to a record a forwarder numbered with `relayExec` carries the `authority` receipt the relay audits (A1, A4),
 * which connections that are not role-bound never get (A5). Wire contract: `designs/307-senpi-wire-freeze.md`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type DelegatedHost, declare, type Peer, startHost } from "./rpc-delegated-host-support.ts";
import { BOTH, GRANT, NOT_INTERACTIVE, rolesFixture, VIEWER } from "./rpc-delegated-roles-support.ts";

let host: DelegatedHost;
let opener: Peer;

beforeEach(() => {
	for (const name of ["OMO_RPC_SOCKET_PATH", "OMO_RPC_SOCKET", "SENPI_RPC_SOCKET", "PI_RPC_SOCKET"])
		vi.stubEnv(name, undefined);
});
beforeAll(async () => {
	host = await startHost();
	opener = await host.proven();
});
afterAll(async () => {
	await host.dispose();
}, 60_000);

const { attachTo, dialogOrigin, hold, hostPeer, openSession } = rolesFixture(
	() => host,
	() => opener,
);

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

	it("senpi#6280: an applied close_session carries the receipt, finalizer and non-finalizer close alike", async () => {
		const { peer, sessionId: held } = await hostPeer();
		const opened = await peer.send({ type: "open_session", attended: false, relayExec: 51 });
		expect(opened).toMatchObject({ success: true, authority: { exec: 51 } });
		const own = String(opened.sessionId);
		expect(await peer.send({ type: "close_session", sessionId: own, relayExec: 52 })).toMatchObject({
			success: true,
			sessionId: own,
			authority: { exec: 52, incarnation: 1, epoch: 1 },
		});
		// The opener stays attached, so this close is not the finalizer: it only releases the peer's attachment
		// (the non-finalizer `complete(false)` branch, with no live finalization to join).
		expect(await peer.send({ type: "close_session", sessionId: held, relayExec: 53 })).toMatchObject({
			success: true,
			sessionId: held,
			authority: { exec: 53, incarnation: 1, epoch: 1 },
		});
		expect(await opener.send({ type: "get_state", sessionId: held })).toMatchObject({ success: true });
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
		expect(await legacy.send(attachTo(sessionId))).toMatchObject({ success: true });
		const closed = await legacy.send({ type: "close_session", sessionId, relayExec: 10 });
		expect(closed).toMatchObject({ success: true, sessionId });
		expect(closed).not.toHaveProperty("authority");
	});
});
