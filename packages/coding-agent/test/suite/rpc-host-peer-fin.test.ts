import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureHost } from "../../src/modes/rpc/host-ensure.ts";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";
import {
	GENERATION_HOST_ARGS,
	generationEnv,
	generationScratch,
	reapProcessesUnder,
	supervisorLaunch,
} from "../helpers/rpc-generation-support.ts";
import { hermeticProviderEnv, MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "../helpers/rpc-hermetic.ts";
import { hostChildOf, settledAt, unixSockets } from "../helpers/rpc-host-socket-count.ts";
import { hostSpawnEnv } from "../helpers/rpc-host-spawn-env.ts";
import { reapSpawnedHosts } from "../helpers/spawned-host-reaper.ts";
import { waitForStderr } from "../helpers/rpc-socket-host-support.ts";

/**
 * oh-my-openagent#14725: what a host does with a peer's FIN, on both paths a public client reaches it by: a bare host
 * (the public key filter in the host itself) and a supervised one (the supervisor's proxy, then the sealed hop to the
 * host child). Every peer is half-open, so it stays connected after its own FIN and only the host can end the
 * connection: the host answers what the peer asked before its FIN, then ends, and releases the socket while the peer
 * still holds its end.
 */
type Wire = Record<string, unknown>;
const PEERS = 10;
const EOF_DEADLINE_MS = 10_000;

interface Host {
	readonly socket: string;
	readonly sessionDir: string;
	readonly cwd: string;
	/** Every process that holds a socket per public connection, with its count when no test connection is open. */
	readonly processes: ReadonlyArray<{ readonly pid: number; readonly baseline: number }>;
}

/** A half-open peer: writes `input`, sends its FIN, and resolves with every record it read once the host ends. */
async function finPeer(path: string, input: string, peers: Socket[]): Promise<Wire[]> {
	const socket = createConnection({ path, allowHalfOpen: true });
	peers.push(socket);
	socket.on("error", () => {});
	const records: Wire[] = [];
	attachJsonlLineReader(socket, (line) => records.push(JSON.parse(line) as Wire));
	await once(socket, "connect");
	const ended = once(socket, "end", { signal: AbortSignal.timeout(EOF_DEADLINE_MS) });
	socket.end(input);
	await ended;
	return records;
}

const response = (records: Wire[], id: string) =>
	records.find((record) => record.type === "response" && record.id === id);

function cases(host: () => Host) {
	const peers: Socket[] = [];
	const released = async () => {
		const counts = await Promise.all(host().processes.map(({ pid, baseline }) => settledAt(pid, baseline)));
		for (const socket of peers.splice(0)) socket.destroy();
		return counts;
	};
	const baselines = () => host().processes.map(({ baseline }) => baseline);

	it("answers a request sent right before the FIN, then ends", async () => {
		const all = await Promise.all(
			Array.from({ length: PEERS }, () =>
				finPeer(host().socket, '{"id":"p","type":"get_protocol_info","observe":true}\n', peers),
			),
		);
		for (const records of all) expect(response(records, "p")).toMatchObject({ success: true });
		expect(await released()).toEqual(baselines());
	});

	it("answers a slow request (a session open) sent right before the FIN, then ends", async () => {
		const all = await Promise.all(
			Array.from({ length: 3 }, (_, index) =>
				finPeer(
					host().socket,
					`${JSON.stringify({ id: "o", type: "open_session", cwd: host().cwd, sessionPath: join(host().sessionDir, `fin-${index}-${Date.now()}.jsonl`) })}\n`,
					peers,
				),
			),
		);
		for (const records of all) expect(response(records, "o")).toMatchObject({ success: true });
		expect(await released()).toEqual(baselines());
	});

	it("answers a partial last line as a record of its own, then ends", async () => {
		const records = await finPeer(host().socket, '{"id":"x","ty', peers);
		expect(records).toContainEqual(expect.objectContaining({ type: "response", command: "parse", success: false }));
		expect(await released()).toEqual(baselines());
	});

	it("ends a connection whose peer sends its FIN without any request", async () => {
		await Promise.all(Array.from({ length: PEERS }, () => finPeer(host().socket, "", peers)));
		expect(await released()).toEqual(baselines());
	});

	it("releases a connection whose peer destroys it", async () => {
		for (let index = 0; index < PEERS; index++) {
			const socket = createConnection(host().socket);
			socket.on("error", () => {});
			await once(socket, "connect");
			socket.destroy();
		}
		expect(await released()).toEqual(baselines());
	});
}

describe.skipIf(process.platform === "win32")("a peer's FIN on a host (omo#14725)", () => {
	describe("bare host: the public key filter", () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-peer-fin-bare-"));
		let host: Host | undefined;
		beforeAll(async () => {
			const agentDir = join(root, "agent");
			const sessionDir = join(root, "sessions");
			const cwd = join(root, "work");
			mkdirSync(agentDir, { recursive: true, mode: 0o700 });
			mkdirSync(sessionDir, { recursive: true });
			mkdirSync(cwd, { recursive: true });
			writeRpcModelsJson(agentDir, "http://127.0.0.1:9");
			const socket = join(root, "rpc.sock");
			const child = spawn(
				process.execPath,
				[
					join(import.meta.dirname, "..", "..", "src", "cli.ts"),
					"--mode",
					"rpc",
					"--listen",
					`unix://${socket}`,
					"--provider",
					MOCK_PROVIDER,
					"--model",
					MOCK_MODEL,
				],
				{
					cwd,
					env: {
						...hostSpawnEnv(),
						...hermeticProviderEnv(),
						PI_OFFLINE: "1",
						PI_TELEMETRY: "0",
						SENPI_RUNTIME: "node",
						SENPI_CODING_AGENT_DIR: agentDir,
						SENPI_CODING_AGENT_SESSION_DIR: sessionDir,
					},
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			await waitForStderr(child, "senpi rpc listening on");
			const pid = child.pid ?? 0;
			host = { socket, sessionDir, cwd, processes: [{ pid, baseline: unixSockets(pid) }] };
		});
		afterAll(async () => {
			await reapSpawnedHosts({ roots: [root] });
			await rm(root, { recursive: true, force: true });
		});
		cases(() => {
			if (host === undefined) throw new Error("bare host did not start");
			return host;
		});
	});

	describe("supervised host: the proxy and the sealed hop", () => {
		const qa = generationScratch("peer-fin");
		let host: Host | undefined;
		beforeAll(async () => {
			writeRpcModelsJson(qa.agentDir, "http://127.0.0.1:9");
			const ensured = await ensureHost({
				socket: qa.socket,
				agentDir: qa.agentDir,
				hostArgs: [...GENERATION_HOST_ARGS],
				env: generationEnv(qa),
				policy: { idleExitMs: 600_000 },
				_test: { launch: supervisorLaunch, readinessTimeoutMs: 60_000 },
			});
			const supervisor = ensured.pid;
			const child = hostChildOf(supervisor);
			// The ensure's readiness connection is still open: one accepted socket and one hop in the supervisor, one
			// accepted socket in the child. The baseline is taken once it has closed in both.
			const holding = { supervisor: unixSockets(supervisor), child: unixSockets(child) };
			ensured.release();
			host = {
				socket: qa.socket,
				sessionDir: qa.sessionDir,
				cwd: qa.cwd,
				processes: [
					{ pid: supervisor, baseline: await settledAt(supervisor, holding.supervisor - 2) },
					{ pid: child, baseline: await settledAt(child, holding.child - 1) },
				],
			};
		});
		afterAll(async () => {
			await reapProcessesUnder(qa.root);
			await rm(qa.root, { recursive: true, force: true });
		});
		cases(() => {
			if (host === undefined) throw new Error("supervised host did not start");
			return host;
		});
	});
});
