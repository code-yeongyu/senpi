import { spawn } from "node:child_process";
import { lstat, mkdtemp, readlink, rm, symlink } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareSocketPath } from "../../../src/modes/rpc/host-lifecycle-proxy.ts";
import { type ListenerState, socketEntryListenerState } from "../../../src/modes/rpc/socket-ownership.ts";

// senpi#5314: the start-time cleanup applies the ensure gate's rule (#5283). A symlink planted at the endpoint
// after ensure's check is an occupied entry: the start refuses and touches neither the link nor its target.

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function endpoint(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "e5314-"));
	roots.push(root);
	return join(root, "s");
}

/** A listener that bound the path and exited: a dead socket entry. */
function deadSocket(path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["-e", "require('node:net').createServer().listen(process.argv[1], () => process.exit(0))", path],
			{ stdio: "ignore" },
		);
		child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`dead socket helper exited ${code}`))));
	});
}

function listening(path: string): Promise<void> {
	const server = createServer((client) => client.destroy());
	servers.push(server);
	return new Promise((resolve) => server.listen(path, resolve));
}

function accepts(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const client = createConnection(path);
		client.once("connect", () => {
			client.destroy();
			resolve(true);
		});
		client.once("error", () => resolve(false));
	});
}

async function identity(path: string) {
	const entry = await lstat(path, { bigint: true });
	return { dev: entry.dev, ino: entry.ino, link: entry.isSymbolicLink(), socket: entry.isSocket() };
}

describe.skipIf(process.platform === "win32")("prepareSocketPath never follows a planted symlink (#5314)", () => {
	it("refuses a dangling symlink instead of reading it as a missing entry", async () => {
		const socket = await endpoint();
		const target = join(socket, "..", "nowhere");
		await symlink(target, socket);
		const planted = await identity(socket);

		await expect(prepareSocketPath(socket)).rejects.toThrow("address already in use by a live server");

		expect(await identity(socket)).toEqual(planted);
		expect(await readlink(socket)).toBe(target);
		await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses a symlink to a dead socket and removes neither the link nor its target", async () => {
		const socket = await endpoint();
		const target = `${socket}-target`;
		await deadSocket(target);
		const targetBefore = await identity(target);
		await symlink(target, socket);
		const planted = await identity(socket);

		await expect(prepareSocketPath(socket)).rejects.toThrow("the entry is not a socket");

		expect(await identity(socket)).toEqual(planted);
		expect(await identity(target)).toEqual(targetBefore);
	});

	it("refuses a symlink swapped in for the dead socket after the probe", async () => {
		const socket = await endpoint();
		const target = `${socket}-target`;
		await deadSocket(socket);
		await deadSocket(target);
		const targetBefore = await identity(target);

		const prepared = prepareSocketPath(socket, {
			afterStaleProbe: async () => {
				await rm(socket);
				await symlink(target, socket);
			},
		});

		await expect(prepared).rejects.toThrow("address already in use by a live server");
		expect((await identity(socket)).link).toBe(true);
		expect(await identity(target)).toEqual(targetBefore);
	});

	// The entry never changes identity here (a socket bound earlier that starts listening late), so only a
	// reachability check that runs after the decision, right before the unlink, can keep it.
	it("refuses an entry that became reachable between the stale decision and the unlink", async () => {
		const socket = await endpoint();
		await listening(socket);
		const before = await identity(socket);
		let reachable = false;
		const listenerState = async (path: string): Promise<ListenerState> =>
			reachable ? socketEntryListenerState(path) : { verdict: "dead", evidence: "pinned dead at the decision" };

		const prepared = prepareSocketPath(socket, {
			listenerState,
			afterStaleProbe: async () => {
				reachable = true;
			},
		});

		await expect(prepared).rejects.toThrow("accepting connections");
		expect(await identity(socket)).toEqual(before);
		expect(await accepts(socket)).toBe(true);
	});

	it("still removes its own dead socket so the start can reuse the path", async () => {
		const socket = await endpoint();
		await deadSocket(socket);

		await prepareSocketPath(socket);

		await expect(lstat(socket)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
