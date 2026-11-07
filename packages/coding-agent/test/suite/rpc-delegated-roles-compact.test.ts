/**
 * omo-relay-daemon#307, v5 review H1, with the compact-updates rollout flag on: a session-scoped `set_client_info`
 * declared on incarnation 1 and still queued in a blocked worker is overtaken by `detach_connection` and a host-scoped
 * declaration on incarnation 2 that changes only a presentation capability. When the worker finally sends the old
 * declaration, the host must answer it stale BEFORE comparing it with the socket's compact selection: that comparison
 * answers code 2, which ends the worker shared by every client of the session.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	attach,
	type DelegatedHost,
	declare,
	openSession,
	type Peer,
	startHost,
} from "./rpc-delegated-host-support.ts";

const VIEWER = { deviceId: "x307-device", deviceName: "Viewer" };
const OLDER = ["interactive_user"];
const NEWER = ["interactive_user", "secret_input_v1"];

let host: DelegatedHost;
let opener: Peer;

// vitest restores stubbed env before every test (`unstubEnvs`): the flag must hold at host start AND in the test.
function pinEnvironment(): void {
	for (const name of ["OMO_RPC_SOCKET_PATH", "OMO_RPC_SOCKET", "SENPI_RPC_SOCKET", "PI_RPC_SOCKET"])
		vi.stubEnv(name, undefined);
	vi.stubEnv("SENPI_RPC_REQUIRE_ATTACH", undefined);
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
}

beforeEach(pinEnvironment);
beforeAll(async () => {
	pinEnvironment();
	host = await startHost({ workers: true });
	opener = await host.proven();
}, 60_000);
afterAll(async () => {
	await host.dispose();
}, 60_000);

describe("omo-relay-daemon#307 (v5 review H1): staleness is decided before the compact selection", () => {
	it("refuses only the old declaration, keeps the newer selection, and the shared worker serves the other client", async () => {
		const session = await openSession(opener, { retain_on_disconnect: true });
		const peer = await host.proven();
		expect(
			await declare(peer, ["observe", "drive", "thread"], VIEWER, { roles: ["interactive_user", "task_parent"] }),
		).toMatchObject({ success: true });
		expect(await peer.send(attach(session))).toMatchObject({ success: true });
		const prompt = opener.send({ type: "prompt", sessionId: session.sessionId, message: "/block" }).catch(() => {});
		const gate = await host.blocked();
		// The host pre-declares OLDER on incarnation 1 before it queues the record for the blocked worker; only then is
		// the detach written, so the late answer comes from the worker's own callback, never the host-level check.
		const predeclared = Promise.withResolvers<void>();
		const commit = host.writer.setConnectionCapabilities.bind(host.writer);
		const spy = vi.spyOn(host.writer, "setConnectionCapabilities").mockImplementation((id, capabilities) => {
			commit(id, capabilities);
			if (id === peer.connectionId && capabilities.join() === OLDER.join()) predeclared.resolve();
		});
		const late = peer.send({ type: "set_client_info", sessionId: session.sessionId, capabilities: OLDER });
		await predeclared.promise;
		spy.mockRestore();
		expect(await peer.send({ type: "detach_connection" })).toMatchObject({ success: true });
		expect(await peer.send({ type: "set_client_info", capabilities: NEWER })).toMatchObject({ success: true });
		await gate.release();
		await prompt;
		expect(await late).toMatchObject({ success: false, errorCode: "delegation_incarnation_stale" });
		expect(host.writer.getConnectionCapabilities(peer.connectionId)).toEqual(NEWER);
		expect(await opener.send({ type: "get_state", sessionId: session.sessionId })).toMatchObject({ success: true });
	}, 90_000);
});
