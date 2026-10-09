/**
 * `tui` endpoints in `host status --all` and `host gc`: a running terminal endpoint is a `tui` row that
 * is alive and names its owner, is asked nothing but the two commands both endpoint kinds answer, and
 * is kept by gc; a terminal that died is reaped on the same evidence as a host. Routability is judged
 * from what the socket answered, never from the generation the directory recorded.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gcHostEndpoints } from "../../src/modes/rpc/host-gc.ts";
import { readAllHostStatus } from "../../src/modes/rpc/host-status-all.ts";
import { endpointScratch } from "../helpers/rpc-host-endpoint-scratch.ts";
import { exitedPid } from "../helpers/rpc-host-gc-fixtures.ts";
import { type EndpointFixture, startEndpoint } from "../helpers/session-control-fixture.ts";
import { closeRegistryFixtures, liveRecord, registered, scriptedSocket } from "./rpc-endpoint-registry-fixtures.ts";

const fixtures: EndpointFixture[] = [];

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.endpoint.dispose();
		fixture.harness.cleanup();
	}
	await closeRegistryFixtures();
}, 180_000);

describe.skipIf(process.platform === "win32")("tui endpoints in status --all and gc", () => {
	it("lists a running terminal as one alive tui row naming its process and session", async () => {
		// Given: one terminal registered a control endpoint in the agent directory.
		const qa = endpointScratch("tui-row");
		const fixture = await startEndpoint({ agentDir: qa.agentDir });
		fixtures.push(fixture);
		const session = fixture.harness.session;

		// When: every endpoint is read.
		const rows = await readAllHostStatus({ agentDir: qa.agentDir, includeWorkers: true });

		// Then: one tui row, routable, owned by this process and the one session it holds.
		expect(rows).toEqual([
			expect.objectContaining({
				endpoint_kind: "tui",
				socket: fixture.socket,
				reachable: true,
				alive: true,
				reason: null,
				owner: {
					pid: process.pid,
					cwd: session.sessionManager.getCwd(),
					session: { id: session.sessionId, path: session.sessionFile ?? null, name: null },
				},
			}),
		]);
	});

	it("sends a tui endpoint get_protocol_info and list_sessions only", async () => {
		// Given: a tui endpoint served by a socket that records every command it is sent.
		const qa = endpointScratch("tui-cmds");
		const socket = join(qa.root, "rpc", "tui", "plain.sock");
		const received = await scriptedSocket(socket, {
			instanceId: "gen-a",
			sessions: [{ sessionId: "s-1", cwd: "/w" }],
		});
		await registered(qa.agentDir, socket, "tui", await liveRecord(), "gen-a");

		// When: status --all reads it, asking for workers as a caller may.
		const [row] = await readAllHostStatus({ agentDir: qa.agentDir, includeWorkers: true });

		// Then: only the two commands both endpoint kinds answer were sent, and the row is alive.
		expect(new Set(received)).toEqual(new Set(["get_protocol_info", "list_sessions"]));
		expect(row).toMatchObject({ endpoint_kind: "tui", alive: true, owner: { cwd: "/w", session: { id: "s-1" } } });
	});

	it("is not routable when the socket answers without naming an instance, whatever the directory recorded", async () => {
		// Given: a live recorded generation gen-a whose socket answers get_protocol_info with no instance id.
		const qa = endpointScratch("tui-noid");
		await scriptedSocket(qa.legacy, { instanceId: undefined, sessions: [] });
		await registered(qa.agentDir, qa.legacy, "rpc_host", await liveRecord(), "gen-a");

		// When / Then: the row answers, but it is not routable.
		const [row] = await readAllHostStatus({ agentDir: qa.agentDir, includeWorkers: false });
		expect(row).toMatchObject({ reachable: true, alive: false, reason: "live_unresponsive", owner: null });
	});

	it("keeps a running terminal's endpoint through gc and reaps one whose terminal died", async () => {
		// Given: a running terminal endpoint, and a tui directory whose recorded process exited.
		const qa = endpointScratch("tui-gc");
		const fixture = await startEndpoint({ agentDir: qa.agentDir });
		fixtures.push(fixture);
		const deadSocket = join(qa.root, "rpc", "tui", "gone.sock");
		const dead = await registered(qa.agentDir, deadSocket, "tui", {
			pid: await exitedPid(),
			processStartTime: "whenever",
		});

		// When: gc runs over every kind.
		const result = await gcHostEndpoints(qa.agentDir);

		// Then: the live terminal is kept for its generation, the dead one removed, and status agrees.
		expect(result.kept).toEqual([expect.objectContaining({ socket: fixture.socket, reason: "live_generation" })]);
		expect(result.removed).toEqual([expect.objectContaining({ dir: dead.dir, reason: "socket_absent" })]);
		const rows = await readAllHostStatus({ agentDir: qa.agentDir, includeWorkers: false });
		expect(rows).toEqual([expect.objectContaining({ socket: fixture.socket, endpoint_kind: "tui", alive: true })]);
	});
});
