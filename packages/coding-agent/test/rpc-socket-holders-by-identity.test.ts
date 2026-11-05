import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lsofSocketHolders } from "../src/modes/rpc/socket-ownership.ts";

const lsofAvailable = (() => {
	try {
		execFileSync("lsof", ["-v"], { stdio: "ignore" });
		return true;
	} catch (cause) {
		return Reflect.get(Object(cause), "status") !== undefined;
	}
})();

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A listener bound in a private directory and published at `endpoint` with link(2), as `host-socket-bind` does. */
async function publishedListener(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "senpi-holders-"));
	roots.push(root);
	const bindDir = join(root, "rpc.sock.bind-0123456789ab");
	await mkdir(bindDir, { mode: 0o700 });
	const server = createServer();
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(join(bindDir, "s"), () => resolve()));
	const endpoint = join(root, "rpc.sock");
	await link(join(bindDir, "s"), endpoint);
	return endpoint;
}

describe.skipIf(process.platform === "win32" || !lsofAvailable)(
	"socket holders of a published endpoint (#5319)",
	() => {
		it("finds this process holding an endpoint published by link(2), though lsof names it by its bind path", async () => {
			const endpoint = await publishedListener();
			expect(await lsofSocketHolders(endpoint)).toContain(process.pid);
		});
	},
);
