/**
 * `status --all` against endpoints that accept a connection and never answer: endpoints are probed
 * concurrently under their own budgets, so a machine with several hung hosts answers in about one
 * budget rather than one per host, at most STATUS_ALL_MAX_IN_FLIGHT at a time so hundreds of hung hosts
 * cannot exhaust the file descriptors, and the rows keep the enumeration order.
 */
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonDirectories, createHostDaemonPaths } from "../src/modes/rpc/host-daemon-paths.ts";
import { listHostEndpoints } from "../src/modes/rpc/host-endpoints.ts";
import {
	type HostEndpointStatus,
	readAllHostStatus,
	STATUS_ALL_MAX_IN_FLIGHT,
} from "../src/modes/rpc/host-status-all.ts";
import { endpointScratch, sweepEndpointScratches } from "./helpers/rpc-host-endpoint-scratch.ts";
import { closeServer, deadEndpoint } from "./helpers/rpc-host-gc-fixtures.ts";

const servers: Server[] = [];
const held: Socket[] = [];

afterEach(async () => {
	for (const connection of held.splice(0)) connection.destroy();
	for (const server of servers.splice(0)) await closeServer(server);
	await sweepEndpointScratches();
}, 180_000);

const SILENT_ENDPOINTS = 8;
const BUDGET_MS = 2_000;

async function silentEndpoint(socket: string, agentDir: string): Promise<void> {
	const server = createServer((connection) => held.push(connection));
	await new Promise<void>((listening, reject) => {
		server.once("error", reject);
		server.listen(socket, () => listening());
	});
	servers.push(server);
	await createDaemonDirectories(createHostDaemonPaths({ socket, agentDir }));
}

describe.skipIf(process.platform === "win32")("host status --all against silent endpoints", () => {
	it("reads every hung endpoint at once, in about one probe budget, in enumeration order", async () => {
		const qa = endpointScratch("silent");
		const sockets = Array.from({ length: SILENT_ENDPOINTS }, (_, index) => join(qa.root, `s${index}.sock`));
		for (const socket of sockets) await silentEndpoint(socket, qa.agentDir);
		const listed = await listHostEndpoints(qa.agentDir);

		const started = Date.now();
		const rows = await readAllHostStatus({ agentDir: qa.agentDir, includeWorkers: true, timeoutMs: BUDGET_MS });
		const elapsed = Date.now() - started;

		expect(rows.map((row) => row.dir)).toEqual(listed.map((endpoint) => endpoint.dir));
		expect(new Set(rows.map((row) => row.socket))).toEqual(new Set(sockets));
		for (const row of rows) expect(row).toMatchObject({ reachable: false, session_rows: [] });
		// Serial reads would take SILENT_ENDPOINTS budgets (twice that with the listing asked too).
		expect(elapsed).toBeGreaterThanOrEqual(BUDGET_MS);
		expect(elapsed).toBeLessThan(2.5 * BUDGET_MS);
	}, 180_000);
});

describe("host status --all over more endpoints than it reads at once", () => {
	it("never reads more than STATUS_ALL_MAX_IN_FLIGHT endpoints at once, and still returns every row in order", async () => {
		const qa = endpointScratch("wide");
		const total = STATUS_ALL_MAX_IN_FLIGHT + 6;
		for (let index = 0; index < total; index++) await deadEndpoint(join(qa.root, `w${index}.sock`), qa.agentDir);
		const listed = await listHostEndpoints(qa.agentDir);
		let inFlight = 0;
		let peak = 0;
		const readEndpoint = async (endpoint: { readonly dir: string }): Promise<HostEndpointStatus> => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			// Settles on a later macrotask, after every read the pool would start at once has started.
			await new Promise((settle) => setImmediate(settle));
			inFlight--;
			return { dir: endpoint.dir } as HostEndpointStatus;
		};

		const rows = await readAllHostStatus({ agentDir: qa.agentDir, includeWorkers: false, _test: { readEndpoint } });

		expect(rows.map((row) => row.dir)).toEqual(listed.map((endpoint) => endpoint.dir));
		expect(rows).toHaveLength(total);
		expect(peak).toBe(STATUS_ALL_MAX_IN_FLIGHT);
	});
});
