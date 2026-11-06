/**
 * omo-relay-daemon#307: the interactive-user role over the relay, host scope (in-process sessions). A forwarder declares
 * `roles` with its delegation (`delegation_roles_v1`), so the engine keeps an authority word per incarnation of the
 * socket; a narrowing or a `detach_connection` revokes a role for every record the engine reads after it. Origin and
 * receipts: `rpc-delegated-origin-receipts.test.ts`; session workers: `rpc-delegated-roles-worker.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type DelegatedHost, declare, type Peer, startHost } from "./rpc-delegated-host-support.ts";
import { BOTH, GRANT, NOT_INTERACTIVE, rolesFixture, VIEWER } from "./rpc-delegated-roles-support.ts";

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

const { attachTo, dialogOrigin, hold, hostPeer } = rolesFixture(
	() => host,
	() => opener,
);

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
