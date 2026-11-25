import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reapOrphanedInternalHostDirs } from "../../../src/modes/rpc/host-internal-dir-reaper.ts";
import { createInternalSocketPath } from "../../../src/modes/rpc/host-lifecycle.ts";

// Regression coverage for https://github.com/code-yeongyu/senpi/issues/7452: a long-lived supervised host lost its
// private hop directory in the shared temp dir while it was still serving, and nothing noticed.
describe.skipIf(process.platform === "win32")("issue #7452: the internal hop directory belongs to its host", () => {
	const created: string[] = [];
	const servers: Server[] = [];

	afterEach(async () => {
		vi.unstubAllEnvs();
		for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
		for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("places the hop under the host's own daemon directory, not the shared temp dir", async () => {
		const daemonDir = mkdtempSync(join("/tmp", "s7452d-"));
		const tmp = mkdtempSync(join("/tmp", "s7452t-"));
		created.push(daemonDir, tmp);
		vi.stubEnv("TMPDIR", tmp);

		const internal = await createInternalSocketPath(daemonDir, process.platform);

		expect(internal.dir?.startsWith(`${daemonDir}/senpi-rpc-host-internal-`)).toBe(true);
	});

	// Linux lists a bound unix socket in /proc/net/unix by the name it was bound at, even after that name is
	// unlinked; that is the evidence a sweeper can still read once the entry itself is gone.
	it.skipIf(process.platform !== "linux")(
		"keeps a dead-owner hop whose socket name is gone but whose listener still serves",
		async () => {
			const hop = mkdtempSync(join("/tmp", "senpi-rpc-host-internal-7452"));
			created.push(hop);
			writeFileSync(
				join(hop, ".owner"),
				JSON.stringify({ pid: 2_147_483_000, processStartTime: "2000-01-01T00:00:00Z", createdAt: Date.now() - 120_000 }),
			);
			const socketPath = join(hop, "host.sock");
			const server = createServer((socket) => socket.end());
			servers.push(server);
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, () => resolve());
			});
			unlinkSync(socketPath);

			await reapOrphanedInternalHostDirs();

			expect(existsSync(join(hop, ".owner"))).toBe(true);
		},
	);
});
