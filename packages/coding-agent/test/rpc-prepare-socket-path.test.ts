import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareSocketPath } from "../src/modes/rpc/host-lifecycle-proxy.ts";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function socketIn(label: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `senpi-prepare-${label}-`));
	roots.push(root);
	return join(root, "rpc.sock");
}

function listenOn(socketPath: string): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer((socket) => socket.on("error", () => {}));
		server.once("error", reject);
		server.listen(socketPath, () => {
			servers.push(server);
			resolve(server);
		});
	});
}

/** A listener that bound the path and exited: the entry stays, and connecting to it is refused. */
function staleEntry(socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["-e", "require('node:net').createServer().listen(process.argv[1], () => process.exit(0))", socketPath],
			{ stdio: "ignore" },
		);
		child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`stale entry helper exited ${code}`))));
	});
}

function accepts(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

describe.skipIf(process.platform === "win32")("prepareSocketPath", () => {
	it("removes an entry nobody listens behind", async () => {
		const socketPath = await socketIn("stale");
		await staleEntry(socketPath);

		await prepareSocketPath(socketPath);

		await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses a path a live listener holds and keeps it", async () => {
		const socketPath = await socketIn("live");
		await listenOn(socketPath);

		await expect(prepareSocketPath(socketPath)).rejects.toThrow("address already in use by a live server");
		expect(await accepts(socketPath)).toBe(true);
	});

	it("never removes a listener that bound the path after the stale probe", async () => {
		// The entry was dead when probed; another process takes the path before the unlink.
		const socketPath = await socketIn("race");
		await staleEntry(socketPath);

		const prepared = prepareSocketPath(socketPath, {
			afterStaleProbe: async () => {
				await unlink(socketPath);
				await listenOn(socketPath);
			},
		});

		await expect(prepared).rejects.toThrow("address already in use by a live server");
		expect(await accepts(socketPath)).toBe(true);
	});
});
