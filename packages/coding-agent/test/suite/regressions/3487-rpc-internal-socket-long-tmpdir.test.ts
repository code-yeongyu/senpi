import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reapOrphanedInternalHostDirs } from "../../../src/modes/rpc/host-internal-dir-reaper.ts";
import { createInternalSocketPath } from "../../../src/modes/rpc/host-lifecycle.ts";
import { MAX_SOCKET_PATH_BYTES } from "../../../src/modes/rpc/socket-ownership.ts";

// Regression coverage for https://github.com/code-yeongyu/senpi/issues/3487: a long TMPDIR (a macOS
// per-user temp dir under a nested runner directory) pushed the internal host socket past sun_path,
// so the host child died with a bare `listen EINVAL`.
describe.skipIf(process.platform === "win32")("createInternalSocketPath with a long TMPDIR", () => {
	const created: string[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("keeps the internal socket within the Unix socket path limit and binds it", async () => {
		// Unique per run: never a directory another suite (or this job's own TMPDIR) owns.
		const longTmp = mkdtempSync(join("/tmp", `senpi-3487-${"x".repeat(100)}-`));
		created.push(longTmp);
		vi.stubEnv("TMPDIR", longTmp);

		const internal = await createInternalSocketPath(longTmp, process.platform);
		if (internal.dir) created.push(internal.dir);

		expect(Buffer.byteLength(internal.socket)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
		expect(internal.dir && statSync(internal.dir).mode & 0o777).toBe(0o700);
		const server = createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(internal.socket, () => resolve());
		});
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("still uses TMPDIR when it is short enough", async () => {
		const shortTmp = mkdtempSync(join("/tmp", "s3487-"));
		created.push(shortTmp);
		vi.stubEnv("TMPDIR", shortTmp);

		const internal = await createInternalSocketPath(shortTmp, process.platform);
		if (internal.dir) created.push(internal.dir);

		expect(internal.dir?.startsWith(`${shortTmp}/`)).toBe(true);
	});

	it("reaps a dead owner's leftover hop from the /tmp fallback root", async () => {
		const longTmp = mkdtempSync(join("/tmp", `senpi-3487-${"y".repeat(100)}-`));
		created.push(longTmp);
		vi.stubEnv("TMPDIR", longTmp);
		const leftover = mkdtempSync(join("/tmp", "senpi-rpc-host-internal-3487"));
		created.push(leftover);
		writeFileSync(
			join(leftover, ".owner"),
			JSON.stringify({
				pid: 2_147_483_000,
				processStartTime: "2000-01-01T00:00:00Z",
				createdAt: Date.now() - 120_000,
			}),
		);

		await reapOrphanedInternalHostDirs();

		expect(existsSync(leftover)).toBe(false);
	});
});
