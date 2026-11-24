import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
import { waitForStderr } from "../helpers/rpc-socket-host-support.ts";
import { reapSpawnedHosts } from "../helpers/spawned-host-reaper.ts";

/**
 * oh-my-openagent#14725: what a host does with a peer's FIN, on both paths a public client reaches it by: a bare host
 * (the public key filter in the host itself) and a supervised one (the supervisor's proxy, then the sealed hop to the
 * host child). Every peer is half-open, so it stays connected after its own FIN and only the host can end the
 * connection: the host answers what the peer asked before its FIN, then ends, and releases the socket while the peer
 * still holds its end. Each case starts its own host inside the test.
 */
type Wire = Record<string, unknown>;
type Path = "bare" | "supervised";
const PEERS = 10;

interface Host {
	readonly socket: string;
	readonly sessionDir: string;
	readonly cwd: string;
	/** Every process that holds a socket per public connection, with its count when no test connection is open. */
	readonly processes: ReadonlyArray<{ readonly pid: number; readonly baseline: number }>;
}

async function bareHost(root: string): Promise<Host> {
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const cwd = join(root, "work");
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	writeRpcModelsJson(agentDir, "http://127.0.0.1:9");
	const socket = join(root, "rpc.sock");
	const cli = join(import.meta.dirname, "..", "..", "src", "cli.ts");
	const child = spawn(
		process.execPath,
		[cli, "--mode", "rpc", "--listen", `unix://${socket}`, "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL],
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
	return { socket, sessionDir, cwd, processes: [{ pid, baseline: unixSockets(pid) }] };
}

async function supervisedHost(qa: ReturnType<typeof generationScratch>): Promise<Host> {
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
	// The ensure's readiness connection is still open: one accepted socket and one hop in the supervisor, one accepted
	// socket in the child. The baseline is taken once it has closed in both.
	const holding = { supervisor: unixSockets(supervisor), child: unixSockets(child) };
	ensured.release();
	return {
		socket: qa.socket,
		sessionDir: qa.sessionDir,
		cwd: qa.cwd,
		processes: [
			{ pid: supervisor, baseline: await settledAt(supervisor, holding.supervisor - 2) },
			{ pid: child, baseline: await settledAt(child, holding.child - 1) },
		],
	};
}

/** Starts a host on `path`, runs `body` against it, then reaps every process under its scratch root. */
async function withHost(path: Path, body: (host: Host, peers: Socket[]) => Promise<void>): Promise<void> {
	const peers: Socket[] = [];
	if (path === "bare") {
		const root = mkdtempSync(join(tmpdir(), "senpi-peer-fin-bare-"));
		try {
			await body(await bareHost(root), peers);
		} finally {
			for (const socket of peers) socket.destroy();
			await reapSpawnedHosts({ roots: [root] });
			await rm(root, { recursive: true, force: true });
		}
		return;
	}
	const qa = generationScratch("peer-fin");
	try {
		await body(await supervisedHost(qa), peers);
	} finally {
		for (const socket of peers) socket.destroy();
		await reapProcessesUnder(qa.root);
		await rm(qa.root, { recursive: true, force: true });
	}
}

/** A half-open peer: writes `input`, sends its FIN, and resolves with every record it read once the host ends. */
async function finPeer(path: string, input: string, peers: Socket[]): Promise<Wire[]> {
	const socket = createConnection({ path, allowHalfOpen: true });
	peers.push(socket);
	socket.on("error", () => {});
	const records: Wire[] = [];
	attachJsonlLineReader(socket, (line) => records.push(JSON.parse(line) as Wire));
	await once(socket, "connect");
	// No deadline of its own: the host bounds its wait after a FIN, and the test timeout bounds the case.
	const ended = once(socket, "end");
	socket.end(input);
	await ended;
	return records;
}

const response = (records: Wire[], id: string) =>
	records.find((record) => record.type === "response" && record.id === id);

/** Each process's socket count once it settled; peers still hold their ends while it is read. */
const released = (host: Host) => Promise.all(host.processes.map(({ pid, baseline }) => settledAt(pid, baseline)));
const baselines = (host: Host) => host.processes.map(({ baseline }) => baseline);

function cases(path: Path) {
	it("answers a request sent right before the FIN, then ends", () =>
		withHost(path, async (host, peers) => {
			const all = await Promise.all(
				Array.from({ length: PEERS }, () =>
					finPeer(host.socket, '{"id":"p","type":"get_protocol_info","observe":true}\n', peers),
				),
			);
			for (const records of all) expect(response(records, "p")).toMatchObject({ success: true });
			expect(await released(host)).toEqual(baselines(host));
		}));

	it("answers a slow request (a session open) sent right before the FIN, then ends", () =>
		withHost(path, async (host, peers) => {
			const records = await finPeer(
				host.socket,
				`${JSON.stringify({ id: "o", type: "open_session", cwd: host.cwd, sessionPath: join(host.sessionDir, "fin.jsonl") })}\n`,
				peers,
			);
			expect(response(records, "o")).toMatchObject({ success: true });
			expect(await released(host)).toEqual(baselines(host));
		}));

	it("answers a partial last line as a record of its own, then ends", () =>
		withHost(path, async (host, peers) => {
			const records = await finPeer(host.socket, '{"id":"x","ty', peers);
			expect(records).toContainEqual(
				expect.objectContaining({ type: "response", command: "parse", success: false }),
			);
			expect(await released(host)).toEqual(baselines(host));
		}));

	it("ends a connection whose peer sends its FIN without any request", () =>
		withHost(path, async (host, peers) => {
			await Promise.all(Array.from({ length: PEERS }, () => finPeer(host.socket, "", peers)));
			expect(await released(host)).toEqual(baselines(host));
		}));

	it("releases a connection whose peer destroys it", () =>
		withHost(path, async (host, peers) => {
			for (let index = 0; index < PEERS; index++) {
				const socket = createConnection(host.socket);
				socket.on("error", () => {});
				peers.push(socket);
				await once(socket, "connect");
				socket.destroy();
			}
			expect(await released(host)).toEqual(baselines(host));
		}));
}

describe.skipIf(process.platform === "win32")("a peer's FIN on a host (omo#14725)", () => {
	describe("bare host: the public key filter", () => cases("bare"));
	describe("supervised host: the proxy and the sealed hop", () => cases("supervised"));
});
