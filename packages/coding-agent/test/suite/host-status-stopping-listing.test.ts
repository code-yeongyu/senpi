import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readHostStatus } from "../../src/modes/rpc/host-status.ts";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// senpi#7132 review: a stopping host's listing comes from its supervisor, which answers protocol probes itself even
// when the child behind it hangs. `host status` must not spend its whole read budget waiting for that listing.
describe.skipIf(process.platform === "win32")("host status of a stopping host whose child hangs", () => {
	it("bounds the listing on its own short budget and reports empty counts", async () => {
		const root = await mkdtemp(join(tmpdir(), "st7132-"));
		const socket = join(root, "rpc.sock");
		const server: Server = createServer((peer) => {
			attachJsonlLineReader(peer, (line) => {
				const request = JSON.parse(line);
				// The supervisor's own protocol answer; the listing is never answered, as with a hung child.
				if (request.type !== "get_protocol_info") return;
				const data = { protocolVersion: 1, serverVersion: "fixture", capabilities: [], lifecycle: "stopping" };
				peer.write(
					`${JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data })}\n`,
				);
			});
		});
		await new Promise<void>((resolve) => server.listen(socket, resolve));
		cleanups.push(async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
		});

		// A full 60 s read budget: without the stopping bound this call outlives the test's own timeout.
		const status = await readHostStatus({ socket, agentDir: join(root, "agent") }, { timeoutMs: 60_000 });

		expect(status).toMatchObject({ reachable: true, lifecycle: "stopping", sessions: { total: 0 } });
	});
});
