import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer, type Server, Socket } from "node:net";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import { killProcessTree } from "../../src/utils/shell.ts";

const activeChildren = new Set<ChildProcess>();
const activeConnections = new Set<Socket>();
const activeServers = new Set<Server>();

afterEach(async () => {
	for (const child of activeChildren) {
		if (child.pid !== undefined) killProcessTree(child.pid);
	}
	for (const socket of activeConnections) socket.destroy();
	await Promise.all(
		[...activeServers].map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => {
						if (error) reject(error);
						else resolve();
					});
				}),
		),
	);
	activeChildren.clear();
	activeConnections.clear();
	activeServers.clear();
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	vi.useRealTimers();
});

/** Observe both the shell exit and an independent connection held for the fixture's lifetime. */
export async function createCommandProcessFixture(cwd: string): Promise<{
	readonly command: string;
	readonly started: Promise<{ readonly ready: Promise<number>; readonly closed: Promise<void> }>;
}> {
	const pidPath = join(cwd, "child.pid");
	const scriptPath = join(cwd, "hang.mjs");
	const signal = AbortSignal.timeout(10_000);
	const server = createServer();
	const listening = once(server, "listening", { signal });
	server.listen(0, "127.0.0.1");
	await listening;
	activeServers.add(server);
	const address = server.address();
	assert(address !== null && typeof address === "object");
	const peer = once(server, "connection", { signal }).then(([socket]) => {
		assert(socket instanceof Socket);
		activeConnections.add(socket);
		socket.once("close", () => activeConnections.delete(socket));
		const closed = once(socket, "close", { signal }).then(() => undefined);
		const ready = once(socket, "data", { signal }).then(() => {
			const payload = readFileSync(pidPath, "utf8");
			const pid = Number(payload);
			assert(Number.isSafeInteger(pid) && pid > 0, `Invalid hook child PID: ${JSON.stringify(payload)}`);
			return pid;
		});
		return { ready, closed };
	});
	writeFileSync(
		scriptPath,
		[
			"import { renameSync, writeFileSync } from 'node:fs';",
			"import { connect } from 'node:net';",
			`const pidPath = ${JSON.stringify(pidPath)};`,
			"writeFileSync(pidPath + '.tmp', String(process.pid) + '\\n');",
			"renameSync(pidPath + '.tmp', pidPath);",
			`const peer = connect(${address.port}, '127.0.0.1');`,
			"peer.once('connect', () => peer.write('ready\\n'));",
			"setInterval(() => {}, 1000);",
		].join("\n"),
	);
	const started = Promise.withResolvers<{
		readonly ready: Promise<number>;
		readonly closed: Promise<void>;
	}>();
	const spawn = childProcess.spawn;
	vi.spyOn(childProcess, "spawn").mockImplementationOnce((...args: Parameters<typeof spawn>) => {
		const child = spawn(...args);
		activeChildren.add(child);
		// The runner can destroy stdio after exit, so its close event alone cannot prove descendants died.
		const closed = Promise.all([once(child, "close", { signal }), peer.then((connection) => connection.closed)]).then(
			() => {
				activeChildren.delete(child);
			},
		);
		const ready = peer.then((connection) => connection.ready);
		started.resolve({ ready, closed });
		return child;
	});
	syncBuiltinESMExports();
	return { command: `${process.execPath} ${scriptPath}`, started: started.promise };
}
