/**
 * `senpi host gc` REMOVING an endpoint it has proven dead: siblings by their actual type (a directory
 * beside the socket is not the host's to delete, and is reported), the socket next, the endpoint
 * directory last - so a removal that fails part-way leaves the endpoint listed for a later gc - and a
 * failure on one endpoint never stops the others. What makes an endpoint dead is
 * `rpc-host-gc-evidence.test.ts`.
 */
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gcHostEndpoints } from "../src/modes/rpc/host-gc.ts";
import { endpointScratch, sweepEndpointScratches } from "./helpers/rpc-host-endpoint-scratch.ts";
import { deadEndpoint, refusingSocket, siblingPath, writeJson } from "./helpers/rpc-host-gc-fixtures.ts";

afterEach(sweepEndpointScratches, 180_000);

const gone = expect.objectContaining({ code: "ENOENT" });

describe.skipIf(process.platform === "win32")("gc removal of a dead endpoint", () => {
	it("removes a dead endpoint around a directory named like its shield, and reports the directory it left", async () => {
		const qa = endpointScratch("gcx");
		const paths = await deadEndpoint(qa.legacy, qa.agentDir);
		await refusingSocket(qa.legacy);
		const foreign = siblingPath(qa.legacy, ".shield-7");
		await writeJson(join(foreign, "keep.json"), {});
		await writeJson(siblingPath(qa.legacy, ".shield-3"), {});

		expect(await gcHostEndpoints(qa.agentDir)).toEqual({
			removed: [
				{
					socket: qa.legacy,
					dir: paths.dir,
					reason: "socket_refused",
					skipped: [{ path: foreign, type: "directory" }],
				},
			],
			kept: [],
		});
		for (const path of [paths.dir, qa.legacy, siblingPath(qa.legacy, ".shield-3")]) {
			await expect(stat(path)).rejects.toEqual(gone);
		}
		await expect(readFile(join(foreign, "keep.json"), "utf8")).resolves.toBe("{}\n");
	});

	it.skipIf(process.getuid?.() === 0)(
		"keeps an endpoint whose removal fails, with its directory whole, and still removes the others",
		async () => {
			const qa = endpointScratch("gcy");
			const blocked = join(qa.root, "ro", "b.sock");
			const blockedPaths = await deadEndpoint(blocked, qa.agentDir);
			const deadPaths = await deadEndpoint(qa.shard, qa.agentDir);
			await mkdir(dirname(blocked), { recursive: true });
			await refusingSocket(blocked);
			await writeJson(siblingPath(blocked, ".shield-5"), {});
			// Nothing in the socket's directory can be unlinked: the removal fails on its first sibling.
			await chmod(dirname(blocked), 0o500);
			try {
				const result = await gcHostEndpoints(qa.agentDir);

				expect(result.removed).toEqual([{ socket: qa.shard, dir: deadPaths.dir, reason: "socket_absent" }]);
				expect(result.kept).toEqual([
					{ socket: blocked, dir: blockedPaths.dir, reason: "failed", error: expect.stringContaining("EACCES") },
				]);
				await expect(stat(blockedPaths.endpointFile)).resolves.toBeDefined();
				await expect(stat(blocked)).resolves.toBeDefined();
				await expect(stat(deadPaths.dir)).rejects.toEqual(gone);
			} finally {
				await chmod(dirname(blocked), 0o700);
			}
		},
	);

	it.skipIf(process.getuid?.() === 0)(
		"fails on the socket while the endpoint directory is still there, so the endpoint stays listed",
		async () => {
			const qa = endpointScratch("gcz");
			const blocked = join(qa.root, "ro", "b.sock");
			const blockedPaths = await deadEndpoint(blocked, qa.agentDir);
			await refusingSocket(blocked);
			await chmod(dirname(blocked), 0o500);
			try {
				const result = await gcHostEndpoints(qa.agentDir);

				// No sibling beside the socket, so the removal reaches the socket itself: unlinking it
				// from a read-only directory must fail BEFORE the endpoint directory is touched. A
				// removal that took the directory first would leave a socket nothing names - half
				// removed, no longer listed, never finished by a later gc.
				expect(result.removed).toEqual([]);
				expect(result.kept).toEqual([
					{ socket: blocked, dir: blockedPaths.dir, reason: "failed", error: expect.stringContaining("EACCES") },
				]);
				await expect(stat(blocked)).resolves.toBeDefined();
				await expect(stat(blockedPaths.endpointFile)).resolves.toBeDefined();
			} finally {
				await chmod(dirname(blocked), 0o700);
			}
		},
	);
});
