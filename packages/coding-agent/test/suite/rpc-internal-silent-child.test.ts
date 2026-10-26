import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INTERNAL_OBSERVER_HANDSHAKE_MS, SupervisorActivity } from "../../src/modes/rpc/host-lifecycle-activity.ts";
import { INTERNAL_READINESS_PROBE_MS, waitForListener } from "../../src/modes/rpc/host-lifecycle-proxy.ts";
import { processAlive } from "../helpers/spawned-host-reaper.ts";

const key = Buffer.alloc(32, 7);
const roots: string[] = [];
const servers: Server[] = [];
const peers: Socket[] = [];
afterEach(async () => {
	for (const peer of peers.splice(0)) peer.destroy();
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A host that accepts the internal hop and never answers; resolves when it sees its first peer close. */
async function silentHost() {
	const root = mkdtempSync("/tmp/r3816-");
	roots.push(root);
	const path = join(root, "h.sock");
	const accepted = new Promise<Socket>((resolve) => {
		const server = createServer((peer) => {
			peers.push(peer);
			peer.resume();
			resolve(peer);
		});
		servers.push(server);
		server.listen(path);
	});
	const dropped: Promise<void> = accepted.then((peer) =>
		peer.destroyed ? undefined : once(peer, "close").then(() => undefined),
	);
	await once(servers.at(-1) as Server, "listening");
	return { root, path, dropped };
}

// senpi#3816 review (HIGH-1): the supervisor's own handshakes must be bounded. A child that accepts and never answers
// fails readiness or the observer within the bound, its connection is dropped, and the supervisor never hangs.
describe.skipIf(process.platform === "win32")("silent internal host", () => {
	it("the readiness probe gives up within its bound and drops the connection", async () => {
		const host = await silentHost();
		const started = performance.now();
		await expect(waitForListener(host.path, 30_000, undefined, key)).rejects.toThrow(/did not answer/);
		expect(performance.now() - started).toBeLessThan(INTERNAL_READINESS_PROBE_MS + 3_000);
		await host.dropped;
	}, 25_000);

	// senpi#3816 review (L2): a child that answers the wrong protocol (plain JSONL, no server proof) is not a host that
	// is still starting: readiness fails at once and names why, instead of 30 s of retries.
	it("the readiness probe fails fast and names the cause when the child answers without a server proof", async () => {
		const root = mkdtempSync("/tmp/r3816-");
		roots.push(root);
		const path = join(root, "h.sock");
		const server = createServer((peer) => {
			peers.push(peer);
			peer.once("data", (chunk) => {
				const request = JSON.parse(String(chunk).split("\n")[0] ?? "{}");
				peer.write(
					`${JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data: { protocolVersion: 1 } })}\n`,
				);
			});
		});
		servers.push(server);
		server.listen(path);
		await once(server, "listening");
		const started = performance.now();
		await expect(waitForListener(path, 30_000, undefined, key)).rejects.toThrow(/host_identity_unproven/);
		expect(performance.now() - started).toBeLessThan(3_000);
	}, 10_000);

	it("the activity observer gives up within its bound and drops the connection", async () => {
		const host = await silentHost();
		let settled = false;
		const activity = new SupervisorActivity({
			idleExitMs: Number.POSITIVE_INFINITY,
			internalSocket: host.path,
			internalKey: key,
			instanceId: "silent",
			settled: () => settled,
		});
		const started = performance.now();
		try {
			await expect(activity.openObserver()).rejects.toThrow();
			expect(performance.now() - started).toBeLessThan(INTERNAL_OBSERVER_HANDSHAKE_MS + 3_000);
			await host.dropped;
		} finally {
			settled = true;
			activity.stopObserver();
		}
	}, 20_000);

	it("a supervisor whose child never answers exits 1 and tears the child down", async () => {
		const root = mkdtempSync("/tmp/r3816-");
		roots.push(root);
		const pidFile = join(root, "child.pid");
		const supervisor = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				join(import.meta.dirname, "../../src/modes/rpc/host-lifecycle.ts"),
				"--socket",
				join(root, "public.sock"),
				"--child-command",
				process.execPath,
				"--child-args",
				JSON.stringify(["--import", "tsx", join(import.meta.dirname, "../fixtures/rpc-silent-child.ts")]),
			],
			{
				env: {
					...process.env,
					SENPI_TEST_SILENT_CHILD_PIDFILE: pidFile,
					SENPI_CODING_AGENT_DIR: join(root, "agent"),
				},
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		let stderr = "";
		supervisor.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		const [code] = await once(supervisor, "exit");
		expect(code, stderr).toBe(1);
		expect(stderr).toMatch(/did not answer/);
		const childPid = Number(readFileSync(pidFile, "utf8"));
		expect(processAlive(childPid), "the silent child is torn down with its supervisor").toBe(false);
	}, 45_000);
});
