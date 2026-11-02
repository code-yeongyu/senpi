/**
 * A terminal control endpoint is owned by its terminal: `senpi host ensure|handoff|stop --socket` against
 * one refuses `unsupported_endpoint_kind` (exit 3) from disk alone, without opening a connection - every
 * `createConnection` in the process is observed. Next to a real supervised host, `status --all` shows one
 * row of each kind and `stop --socket <host>` stops the host alone.
 */
import * as net from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as hostGc from "../../src/modes/rpc/host-gc.ts";
import { DEFAULT_HOST_LAUNCH_SPEC } from "../../src/modes/rpc/host-launch-spec.ts";
import { HOST_EXIT_OK, HOST_EXIT_REFUSED, type HostRequest, runHostRequest } from "../../src/modes/rpc/host-runner.ts";
import { tuiSocketName } from "../../src/modes/rpc/tui-socket.ts";
import { endpointRow, endpointScratch, realHost, statusAll } from "../helpers/rpc-host-endpoint-scratch.ts";
import { type EndpointFixture, startEndpoint } from "../helpers/session-control-fixture.ts";
import { waitForPidGone } from "../helpers/spawned-host-reaper.ts";
import { closeRegistryFixtures, liveRecord, registered } from "./rpc-endpoint-registry-fixtures.ts";

vi.mock("node:net", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:net")>();
	return { ...actual, createConnection: vi.fn(actual.createConnection) };
});

const fixtures: EndpointFixture[] = [];

async function startSettledEndpoint(agentDir: string): Promise<EndpointFixture> {
	const finished = Promise.withResolvers<void>();
	const collect = hostGc.gcHostEndpoints;
	const observer = vi.spyOn(hostGc, "gcHostEndpoints").mockImplementation((...args) => {
		const pass = collect(...args);
		if (args[0] === agentDir) void pass.then(() => finished.resolve(), finished.reject);
		return pass;
	});
	try {
		const fixture = await startEndpoint({ agentDir });
		fixtures.push(fixture);
		await finished.promise;
		return fixture;
	} finally {
		observer.mockRestore();
	}
}

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.endpoint.dispose();
		fixture.harness.cleanup();
	}
	await closeRegistryFixtures();
}, 180_000);

function lifecycleRequests(socket: string, agentDir: string): readonly HostRequest[] {
	const target = { socket, agentDir };
	return [
		{ action: "ensure", target, spec: DEFAULT_HOST_LAUNCH_SPEC, policy: "upgrade" },
		{ action: "handoff", target, spec: DEFAULT_HOST_LAUNCH_SPEC },
		{ action: "stop", target, drain: false, force: false },
		{ action: "stop", target, drain: true, force: true },
	];
}

async function expectRefusedWithoutConnecting(socket: string, agentDir: string): Promise<void> {
	for (const request of lifecycleRequests(socket, agentDir)) {
		vi.mocked(net.createConnection).mockClear();
		const outcome = await runHostRequest(request);
		expect(outcome.exitCode).toBe(HOST_EXIT_REFUSED);
		expect(outcome.payload).toMatchObject({ action: "refuse", reason: "unsupported_endpoint_kind", socket });
		expect(vi.mocked(net.createConnection)).not.toHaveBeenCalled();
	}
}

describe.skipIf(process.platform === "win32")("host lifecycle commands against tui endpoints", () => {
	it("refuses ensure, handoff and stop on a running terminal endpoint without connecting", async () => {
		const qa = endpointScratch("tui-refuse");
		const fixture = await startSettledEndpoint(qa.agentDir);
		await expectRefusedWithoutConnecting(fixture.socket, qa.agentDir);
	});

	it("refuses on a socket recorded as tui, and on a terminal socket name nothing records", async () => {
		// Given: a tui endpoint whose socket has a host-like name, and a t-*.sock whose terminal left no record.
		const qa = endpointScratch("tui-record");
		const recorded = join(qa.root, "rpc", "shards", "p-0123456789abcdef.sock");
		await registered(qa.agentDir, recorded, "tui", await liveRecord());
		const unrecorded = join(qa.root, "rpc", "tui", tuiSocketName("gone-terminal"));

		// When / Then: both are refused from disk alone, and nothing was created for the unrecorded one.
		await expectRefusedWithoutConnecting(recorded, qa.agentDir);
		await expectRefusedWithoutConnecting(unrecorded, qa.agentDir);
		expect((await statusAll(qa)).endpoints).toEqual([expect.objectContaining({ socket: recorded })]);
	});

	it("lists one row of each kind next to a real host, and stop --socket <host> stops only the host", async () => {
		// Given: a real supervised host and a running terminal endpoint in one agent directory.
		const qa = endpointScratch("tui-host");
		await realHost(qa, qa.legacy);
		const fixture = await startSettledEndpoint(qa.agentDir);

		// When: every endpoint is read.
		const before = await statusAll(qa);

		// Then: one routable row per kind.
		expect(before.exitCode).toBe(HOST_EXIT_OK);
		expect(before.endpoints.map((row) => [row.endpoint_kind, row.alive]).sort()).toEqual([
			["rpc_host", true],
			["tui", true],
		]);

		// When: the host is stopped by its socket.
		const stopped = await runHostRequest({
			action: "stop",
			target: { socket: qa.legacy, agentDir: qa.agentDir },
			drain: false,
			force: false,
		});
		expect(stopped).toMatchObject({ exitCode: HOST_EXIT_OK, payload: { action: "stopped" } });
		await waitForPidGone(Number(stopped.payload.pid), 30_000);

		// Then: the terminal endpoint is untouched and still routable; only the host row went down.
		const after = await statusAll(qa);
		expect(endpointRow(after.endpoints, fixture.socket)).toMatchObject({ endpoint_kind: "tui", alive: true });
		expect(endpointRow(after.endpoints, qa.legacy)).toMatchObject({ endpoint_kind: "rpc_host", alive: false });
	}, 120_000);
});
