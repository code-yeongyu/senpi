import { once } from "node:events";
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
import { hostChildOf, settledAt, unixSockets } from "../helpers/rpc-host-socket-count.ts";

/**
 * oh-my-openagent#14725 at the real boundary: a supervisor and its host child, 50 public peers of each shape that
 * leave while the host's loop is stalled (SIGSTOP), then every socket either process accepted for them is released.
 * Both listeners are half-open, so a release here is the host's own doing on every runtime; `SENPI_TEST_HOST_RUNTIME=bun`
 * runs both processes on Bun, the runtime of the hosts that leaked. What a FIN owes the peer first is
 * `rpc-host-peer-fin.test.ts`.
 */
const PEERS = 50;
const bun = process.env.SENPI_TEST_HOST_RUNTIME === "bun";

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
			const supervisor = host.pid;
			const child = hostChildOf(supervisor);
			// The ensure's readiness connection is still open: one accepted socket and one hop in the supervisor, one
			// accepted socket in the child. The baseline is taken once it has closed in both.
			const holding = { supervisor: unixSockets(supervisor), child: unixSockets(child) };
			host.release();
			const baseline = {
				supervisor: await settledAt(supervisor, holding.supervisor - 2),
				child: await settledAt(child, holding.child - 1),
			};
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
				supervisor: await settledAt(supervisor, baseline.supervisor),
				child: await settledAt(child, baseline.child),
			}).toEqual(baseline);
		} finally {
			for (const socket of peers) socket.destroy();
			await reapProcessesUnder(qa.root);
			await rm(qa.root, { recursive: true, force: true });
		}
	});
});
