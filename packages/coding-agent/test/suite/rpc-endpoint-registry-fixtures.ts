/**
 * Registry fixtures for the endpoint-registry suites: endpoints registered on disk exactly as a
 * registrant does it, and sockets the test owns - one that never answers, one that answers as a host.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
	createDaemonDirectories,
	createHostDaemonPaths,
	type EndpointKind,
	type HostDaemonPaths,
} from "../../src/modes/rpc/host-daemon-paths.ts";
import { thisProcessStartTime, writeHostRegistration } from "../../src/modes/rpc/host-daemon-registration.ts";
import { sweepEndpointScratches } from "../helpers/rpc-host-endpoint-scratch.ts";
import { closeServer } from "../helpers/rpc-host-gc-fixtures.ts";

const servers: Server[] = [];
const held: Socket[] = [];

async function listen(socket: string, onConnection: (connection: Socket) => void): Promise<void> {
	await mkdir(join(socket, ".."), { recursive: true });
	const server = createServer(onConnection);
	await new Promise<void>((listening, reject) => {
		server.once("error", reject);
		server.listen(socket, () => listening());
	});
	servers.push(server);
}

/** Accepts every connection and never writes a byte: a suspended terminal, as a client sees it. */
export function silentSocket(socket: string): Promise<void> {
	return listen(socket, (connection) => held.push(connection));
}

export function answeringSocket(socket: string, instanceId: string): Promise<void> {
	return listen(socket, (connection) => {
		held.push(connection);
		let buffered = "";
		connection.on("data", (chunk) => {
			buffered += chunk.toString("utf8");
			for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
				const request: unknown = JSON.parse(buffered.slice(0, newline));
				buffered = buffered.slice(newline + 1);
				const id = typeof request === "object" && request !== null && "id" in request ? request.id : null;
				const data = { protocolVersion: 1, serverVersion: "fixture", capabilities: [], instanceId };
				connection.write(`${JSON.stringify({ id, type: "response", success: true, data })}\n`);
			}
		});
	});
}

/**
 * Answers `get_protocol_info` (naming `instanceId` only when given) and `list_sessions` (with `sessions`),
 * anything else with `unsupported`, and returns the list every received command type is pushed to.
 */
export async function scriptedSocket(
	socket: string,
	answers: { readonly instanceId: string | undefined; readonly sessions: readonly Record<string, unknown>[] },
): Promise<string[]> {
	const received: string[] = [];
	await listen(socket, (connection) => {
		held.push(connection);
		let buffered = "";
		connection.on("data", (chunk) => {
			buffered += chunk.toString("utf8");
			for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
				const request: Record<string, unknown> = JSON.parse(buffered.slice(0, newline));
				buffered = buffered.slice(newline + 1);
				const type = String(request.type);
				received.push(type);
				const data =
					type === "get_protocol_info"
						? { protocolVersion: 1, serverVersion: "fixture", capabilities: [], instanceId: answers.instanceId }
						: { sessions: answers.sessions };
				const reply =
					type === "get_protocol_info" || type === "list_sessions"
						? { id: request.id, type: "response", command: type, success: true, data }
						: { id: request.id, type: "response", command: type, success: false, error: "unsupported" };
				connection.write(`${JSON.stringify(reply)}\n`);
			}
		});
	});
	return received;
}

export type Recorded = { readonly pid: number; readonly processStartTime: string };

export async function liveRecord(): Promise<Recorded> {
	const processStartTime = await thisProcessStartTime();
	if (processStartTime === null) throw new Error("this process's start time is unreadable");
	return { pid: process.pid, processStartTime };
}

export async function registered(
	agentDir: string,
	socket: string,
	kind: EndpointKind,
	record: Recorded,
	instanceId = "gen-a",
): Promise<HostDaemonPaths> {
	const paths = createHostDaemonPaths({ socket, agentDir });
	await createDaemonDirectories(paths, { kind });
	await writeHostRegistration(paths, { record, socket, instanceId, generation: 0, launchProfileId: "fixture" });
	return paths;
}

export async function legacyRecord(agentDir: string, socket: string): Promise<HostDaemonPaths> {
	const paths = createHostDaemonPaths({ socket, agentDir });
	await createDaemonDirectories(paths);
	await writeFile(
		paths.endpointFile,
		`${JSON.stringify({ layout: 2, socket, created_at: "2026-01-01T00:00:00.000Z" })}\n`,
	);
	return paths;
}

/** Closes every socket this module opened, then sweeps the scratch directories. For `afterEach`. */
export async function closeRegistryFixtures(): Promise<void> {
	for (const connection of held.splice(0)) connection.destroy();
	for (const server of servers.splice(0)) await closeServer(server);
	await sweepEndpointScratches();
}
