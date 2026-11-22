/**
 * A socket host that serves its own public socket (`--mode rpc --listen`, `--headless`) - no `host ensure`,
 * no supervisor - must be listed in the endpoint registry before it serves. `host gc` removes a dead
 * endpoint's whole directory, `endpoint.json` included (that is its job), so the record a host does not
 * write itself is gone for good after one outage, and registry readers (`host status --all`, a relay
 * device service) cannot find the restarted host at all (senpi#6190).
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createDaemonDirectories, createHostDaemonPaths } from "../src/modes/rpc/host-daemon-paths.ts";
import { listHostEndpoints } from "../src/modes/rpc/host-endpoints.ts";
import { gcHostEndpoints } from "../src/modes/rpc/host-gc.ts";
import { connectPeer, scratch, spawnRpc, waitForStderr } from "./helpers/rpc-socket-host-support.ts";

describe.skipIf(process.platform === "win32")("a bare socket host's endpoint registry record", () => {
	it("is back before a host restarted after gc removed its dead endpoint serves its first command", async () => {
		const qa = scratch("bare-registry");
		const paths = createHostDaemonPaths({ socket: qa.socketPath, agentDir: qa.agentDir });
		// The record as an earlier registration of this endpoint left it.
		await createDaemonDirectories(paths);
		const args = ["--mode", "rpc", "--listen", `unix://${qa.socketPath}`];
		const listening = `senpi rpc listening on unix://${qa.socketPath}`;

		const first = spawnRpc(args, qa);
		await waitForStderr(first, listening);
		const exited = new Promise((resolve) => first.once("exit", resolve));
		first.kill("SIGKILL");
		await exited;

		const gc = await gcHostEndpoints(qa.agentDir);
		expect(gc.removed.map((entry) => entry.socket)).toEqual([qa.socketPath]);
		await expect(readFile(paths.endpointFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

		const restarted = spawnRpc(args, qa);
		await waitForStderr(restarted, listening);
		expect(JSON.parse(await readFile(paths.endpointFile, "utf8"))).toMatchObject({
			layout: 2,
			registry_version: 1,
			endpoint_kind: "rpc_host",
			socket: qa.socketPath,
		});
		expect(
			(await listHostEndpoints(qa.agentDir)).map(({ socket, endpoint_kind }) => ({ socket, endpoint_kind })),
		).toEqual([{ socket: qa.socketPath, endpoint_kind: "rpc_host" }]);

		const client = await connectPeer(qa.socketPath);
		try {
			await expect(client.peer.request({ id: "first", type: "get_protocol_info" })).resolves.toMatchObject({
				success: true,
			});
		} finally {
			client.peer.close();
			client.socket.destroy();
		}
	}, 90_000);
});
