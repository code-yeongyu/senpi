import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { readdirSync, readlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { ensureHost } from "../../src/modes/rpc/host-ensure.ts";
import {
	GENERATION_HOST_ARGS,
	generationEnv,
	generationScratch,
	hostLifecycleEntry,
	reapProcessesUnder,
	supervisorLaunch,
} from "../helpers/rpc-generation-support.ts";
import { writeRpcModelsJson } from "../helpers/rpc-hermetic.ts";

/**
 * oh-my-openagent#14725 at the real boundary: a supervisor and its host child, 50 public peers of each shape that
 * leave while the host's loop is stalled (SIGSTOP), then every socket either process accepted for them is released.
 * Linux releases them on main too; the leak was measured on macOS under Bun, which `SENPI_TEST_HOST_RUNTIME=bun`
 * selects for both processes. The deterministic proof of the fix is `rpc-accepted-socket-release.test.ts`.
 */
const PEERS = 50;
const RELEASE_DEADLINE_MS = 20_000;
const bun = process.env.SENPI_TEST_HOST_RUNTIME === "bun";

function unixSockets(pid: number): number {
	if (process.platform === "linux")
		return readdirSync(`/proc/${pid}/fd`).filter((fd) => {
			try {
				return readlinkSync(`/proc/${pid}/fd/${fd}`).startsWith("socket:");
			} catch {
				return false;
			}
		}).length;
	const listing = execFileSync("lsof", ["-n", "-P", "-a", "-U", "-p", String(pid)], { encoding: "utf8" });
	return Math.max(0, listing.trim().split("\n").length - 1);
}

/** A count read across a process boundary has no event to await; it is re-read until it settles or the deadline. */
async function settlesAt(pid: number, baseline: number): Promise<number> {
	const deadline = performance.now() + RELEASE_DEADLINE_MS;
	let count = unixSockets(pid);
	while (count > baseline && performance.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		count = unixSockets(pid);
	}
	return count;
}

const request = '{"id":"1","type":"get_protocol_info","observe":true}\n';
const shapes: ReadonlyArray<readonly [string, boolean, (socket: Socket) => void]> = [
	["destroys", false, (socket) => socket.destroy()],
	["ends without a hello", false, (socket) => socket.end()],
	["ends half-open and keeps its socket", true, (socket) => socket.end()],
	[
		"sends a partial line and destroys",
		false,
		(socket) => {
			socket.write('{"id":"1","ty');
			socket.destroy();
		},
	],
	["sends a partial line and ends", false, (socket) => socket.end('{"id":"1","ty')],
	["sends a request and ends", false, (socket) => socket.end(request)],
];

describe.skipIf(process.platform === "win32")("host socket churn while the host is stalled (omo#14725)", () => {
	it("releases every accepted socket in the supervisor and the host child", async () => {
		const qa = generationScratch("churn");
		writeRpcModelsJson(qa.agentDir, "http://127.0.0.1:9");
		const peers: Socket[] = [];
		try {
			const host = await ensureHost({
				socket: qa.socket,
				agentDir: qa.agentDir,
				hostArgs: [...GENERATION_HOST_ARGS],
				env: { ...generationEnv(qa), ...(bun ? { SENPI_RUNTIME: "bun" } : {}) },
				policy: { idleExitMs: 600_000 },
				_test: {
					launch: bun
						? (args) => ({ command: "bun", args: [hostLifecycleEntry(), ...args], reportsStartup: true })
						: supervisorLaunch,
					readinessTimeoutMs: 60_000,
				},
			});
			host.release();
			const supervisor = host.pid;
			const child = Number(execFileSync("pgrep", ["-P", String(supervisor)], { encoding: "utf8" }).split("\n")[0]);
			const baseline = { supervisor: unixSockets(supervisor), child: unixSockets(child) };
			process.kill(child, "SIGSTOP");
			try {
				for (const [, halfOpen, leave] of shapes)
					for (let index = 0; index < PEERS; index++) {
						const socket = createConnection({ path: qa.socket, allowHalfOpen: halfOpen });
						socket.on("error", () => {});
						peers.push(socket);
						await once(socket, "connect");
						leave(socket);
					}
			} finally {
				process.kill(child, "SIGCONT");
			}
			expect({
				supervisor: await settlesAt(supervisor, baseline.supervisor),
				child: await settlesAt(child, baseline.child),
			}).toEqual(baseline);
		} finally {
			for (const socket of peers) socket.destroy();
			await reapProcessesUnder(qa.root);
			await rm(qa.root, { recursive: true, force: true });
		}
	}, 120_000);
});
