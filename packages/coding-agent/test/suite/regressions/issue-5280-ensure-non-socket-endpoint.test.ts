import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unregisteredEndpointHeld } from "../../../src/modes/rpc/host-ensure-liveness.ts";
import { socketEntryListenerState } from "../../../src/modes/rpc/socket-ownership.ts";

// Linux answers a connect to a regular file with ECONNREFUSED, which the listener probe reads as a dead
// listener; macOS answers ENOTSOCK. Pin the Linux answer so the check runs the same on every platform.
vi.mock("../../../src/modes/rpc/socket-ownership.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/modes/rpc/socket-ownership.ts")>()),
	socketEntryListenerState: vi.fn(async () => ({ verdict: "dead", evidence: "connect ECONNREFUSED" })),
}));

const roots: string[] = [];
const servers: Server[] = [];
beforeEach(() => {
	vi.mocked(socketEntryListenerState).mockClear();
});
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function endpoint() {
	const root = await mkdtemp(join(tmpdir(), "e5280-"));
	roots.push(root);
	return join(root, "s");
}

async function listeningSocket(path: string) {
	const server = createServer();
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(path, resolve));
}

describe.skipIf(process.platform === "win32")("ensure's gate on an unregistered endpoint (#5280)", () => {
	it("holds a regular file even when the connect probe reads it as dead", async () => {
		const socket = await endpoint();
		await writeFile(socket, "");
		expect(await unregisteredEndpointHeld(socket)).toBe(true);
	});

	it("leaves a real socket entry to the listener probe, and frees it when the probe reads it dead", async () => {
		const socket = await endpoint();
		await listeningSocket(socket);
		expect(await unregisteredEndpointHeld(socket)).toBe(false);
		expect(socketEntryListenerState).toHaveBeenCalledWith(socket);
	});

	it("holds a dangling symlink instead of reading it as a missing entry", async () => {
		const socket = await endpoint();
		await symlink(join(socket, "..", "nowhere"), socket);
		expect(await unregisteredEndpointHeld(socket)).toBe(true);
		expect(socketEntryListenerState).not.toHaveBeenCalled();
	});

	it("holds a symlink to a live socket without following it to probe the target", async () => {
		const socket = await endpoint();
		const target = `${socket}-target`;
		await listeningSocket(target);
		await symlink(target, socket);
		expect(await unregisteredEndpointHeld(socket)).toBe(true);
		expect(socketEntryListenerState).not.toHaveBeenCalled();
	});

	it("treats a missing entry as free", async () => {
		expect(await unregisteredEndpointHeld(await endpoint())).toBe(false);
	});
});
