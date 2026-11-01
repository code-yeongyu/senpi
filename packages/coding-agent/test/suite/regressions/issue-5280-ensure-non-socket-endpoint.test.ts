import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unregisteredEndpointHeld } from "../../../src/modes/rpc/host-ensure-liveness.ts";

// Linux answers a connect to a regular file with ECONNREFUSED, which the listener probe reads as a dead
// listener; macOS answers ENOTSOCK. Pin the Linux answer so the check runs the same on every platform.
vi.mock("../../../src/modes/rpc/socket-ownership.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/modes/rpc/socket-ownership.ts")>()),
	socketEntryListenerState: vi.fn(async () => ({ verdict: "dead", evidence: "connect ECONNREFUSED" })),
}));

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function endpoint() {
	const root = await mkdtemp(join(tmpdir(), "e5280-"));
	roots.push(root);
	return join(root, "s");
}

describe.skipIf(process.platform === "win32")("ensure's gate on an unregistered endpoint (#5280)", () => {
	it("holds a regular file even when the connect probe reads it as dead", async () => {
		const socket = await endpoint();
		await writeFile(socket, "");
		expect(await unregisteredEndpointHeld(socket)).toBe(true);
	});

	it("still treats a socket nobody listens behind as free", async () => {
		const socket = await endpoint();
		const server = createServer();
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(socket, resolve));
		expect(await unregisteredEndpointHeld(socket)).toBe(false);
	});

	it("treats a missing entry as free", async () => {
		expect(await unregisteredEndpointHeld(await endpoint())).toBe(false);
	});
});
