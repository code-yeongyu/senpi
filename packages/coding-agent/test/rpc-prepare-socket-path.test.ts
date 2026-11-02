import { type ChildProcess, spawn } from "node:child_process";
import { access, chmod, mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareSocketPath } from "../src/modes/rpc/host-lifecycle-proxy.ts";
import {
	classifyConnectError,
	type ListenerState,
	socketEntryListenerState,
} from "../src/modes/rpc/socket-ownership.ts";

const roots: string[] = [];
const servers: Server[] = [];
const children: ChildProcess[] = [];
const clients: Socket[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) client.destroy();
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function socketIn(label: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `senpi-prep-${label}-`));
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

/** A live listener with a backlog of one that never accepts: its loop blocks once it listens. */
function stuckListener(socketPath: string): Promise<ChildProcess> {
	const script = [
		"const server = require('node:net').createServer();",
		"server.listen({ path: process.argv[1], backlog: 1 }, () => {",
		"process.stdout.write('listening\\n', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));",
		"});",
	].join(" ");
	const child = spawn(process.execPath, ["-e", script, socketPath], { stdio: ["ignore", "pipe", "ignore"] });
	children.push(child);
	return new Promise((resolve, reject) => {
		child.stdout?.once("data", () => resolve(child));
		child.once("exit", (code) => reject(new Error(`stuck listener exited ${code}`)));
	});
}

/** Connects until the backlog is full: every further connect is refused or fails. */
async function fillBacklog(socketPath: string): Promise<string> {
	for (let attempt = 0; attempt < 64; attempt++) {
		const outcome = await new Promise<string>((resolve) => {
			const socket = createConnection(socketPath);
			socket.once("connect", () => {
				clients.push(socket);
				resolve("connected");
			});
			socket.once("error", (cause: NodeJS.ErrnoException) => resolve(cause.code ?? "error"));
		});
		if (outcome !== "connected") return outcome;
	}
	throw new Error("the backlog never filled");
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

const verdict =
	(value: ListenerState["verdict"]): ((socketPath: string) => Promise<ListenerState>) =>
	async () => ({ verdict: value, evidence: `pinned ${value}` });

describe("classifyConnectError", () => {
	it.each([
		["ECONNREFUSED", "linux", "dead"],
		["ECONNREFUSED", "darwin", "confirm-holder"],
		["ECONNREFUSED", "freebsd", "confirm-holder"],
		["ENOENT", "linux", "gone"],
		["ENOENT", "darwin", "gone"],
		["EACCES", "linux", "live"],
		["ENOTSOCK", "darwin", "live"],
		["EAGAIN", "linux", "live"],
		["ECONNABORTED", "darwin", "live"],
		["timeout", "linux", "live"],
		[undefined, "darwin", "live"],
	] as const)("%s on %s reads as %s", (code, platform, expected) => {
		expect(classifyConnectError(code, platform)).toBe(expected);
	});
});

describe.skipIf(process.platform === "win32")("socketEntryListenerState", () => {
	it("asks for holders after a refusal where a full backlog also refuses", async () => {
		const socketPath = await socketIn("holders");
		await staleEntry(socketPath);

		expect((await socketEntryListenerState(socketPath, "darwin", async () => [])).verdict).toBe("dead");
		expect((await socketEntryListenerState(socketPath, "darwin", async () => [4242])).verdict).toBe("live");
		expect((await socketEntryListenerState(socketPath, "darwin", async () => undefined)).verdict).toBe("live");
		expect((await socketEntryListenerState(socketPath, "linux", async () => [4242])).verdict).toBe("dead");
	});
});

describe.skipIf(process.platform === "win32")("prepareSocketPath", () => {
	it("removes an entry nobody listens behind", async () => {
		const socketPath = await socketIn("stale");
		await staleEntry(socketPath);

		await prepareSocketPath(socketPath);

		await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("acts on each listener verdict: live keeps, dead removes, gone leaves", async () => {
		const live = await socketIn("verdict-live");
		await staleEntry(live);
		await expect(prepareSocketPath(live, { listenerState: verdict("live") })).rejects.toThrow("pinned live");
		await expect(access(live)).resolves.toBeUndefined();

		const dead = await socketIn("verdict-dead");
		await staleEntry(dead);
		await prepareSocketPath(dead, { listenerState: verdict("dead") });
		await expect(stat(dead)).rejects.toMatchObject({ code: "ENOENT" });

		const gone = await socketIn("verdict-gone");
		await staleEntry(gone);
		await prepareSocketPath(gone, { listenerState: verdict("gone") });
		await expect(access(gone)).resolves.toBeUndefined();
	});

	it("refuses a path a live listener holds and keeps it", async () => {
		const socketPath = await socketIn("live");
		await listenOn(socketPath);

		await expect(prepareSocketPath(socketPath)).rejects.toThrow("accepting connections");
		expect(await accepts(socketPath)).toBe(true);
	});

	it("keeps a live listener whose backlog is full", async () => {
		const socketPath = await socketIn("backlog");
		const stuck = await stuckListener(socketPath);
		await fillBacklog(socketPath);

		await expect(prepareSocketPath(socketPath)).rejects.toThrow("address already in use by a live server");
		await expect(access(socketPath)).resolves.toBeUndefined();
		expect(stuck.exitCode).toBeNull();
	});

	it.skipIf(process.getuid?.() === 0)("keeps an entry it may not connect to (EACCES)", async () => {
		const socketPath = await socketIn("eacces");
		await listenOn(socketPath);
		await chmod(socketPath, 0o000);

		await expect(prepareSocketPath(socketPath)).rejects.toThrow("EACCES");
		await expect(stat(socketPath)).resolves.toBeDefined();
	});

	it("never removes an entry that is not a socket", async () => {
		const socketPath = await socketIn("regular");
		await writeFile(socketPath, "not a socket");

		await expect(prepareSocketPath(socketPath)).rejects.toThrow("not a socket");
		await expect(access(socketPath)).resolves.toBeUndefined();
	});

	it("never removes a listener that bound the path after the stale probe", async () => {
		const socketPath = await socketIn("race");
		await staleEntry(socketPath);

		const prepared = prepareSocketPath(socketPath, {
			afterStaleProbe: async () => {
				await unlink(socketPath);
				await listenOn(socketPath);
			},
		});

		await expect(prepared).rejects.toThrow("the entry changed after it was probed");
		expect(await accepts(socketPath)).toBe(true);
	});

	it("never removes a different dead entry that replaced the probed one", async () => {
		const socketPath = await socketIn("replaced");
		await staleEntry(socketPath);

		const prepared = prepareSocketPath(socketPath, {
			afterStaleProbe: async () => {
				await unlink(socketPath);
				await staleEntry(socketPath);
			},
		});

		await expect(prepared).rejects.toThrow("the entry changed after it was probed");
		await expect(access(socketPath)).resolves.toBeUndefined();
	});

	it("treats an entry another process removed after the probe as done", async () => {
		const socketPath = await socketIn("vanished");
		await staleEntry(socketPath);

		await prepareSocketPath(socketPath, { afterStaleProbe: () => unlink(socketPath) });

		await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
