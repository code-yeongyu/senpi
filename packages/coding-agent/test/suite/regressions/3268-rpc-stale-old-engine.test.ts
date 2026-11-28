import { mkdirSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engineBuildIdentity, engineBuildIdentityFrom } from "../../../src/core/engine-build-identity.ts";
import { createHostDaemonPaths, generationPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { readHostRegistration } from "../../../src/modes/rpc/host-daemon-registration.ts";
import { ensureHost } from "../../../src/modes/rpc/host-ensure.ts";
import { gcHostEndpoints } from "../../../src/modes/rpc/host-gc.ts";
import { judgeStaleEngine } from "../../../src/modes/rpc/host-stale-engine.ts";
import { readAllHostStatus } from "../../../src/modes/rpc/host-status-all.ts";
import { stopHost } from "../../../src/modes/rpc/host-stop.ts";
import {
	GENERATION_HOST_ARGS,
	type GenerationScratch,
	generationEnv,
	generationScratch,
	JsonlPeer,
	openedSessionId,
	processAlive,
	reapProcessesUnder,
	supervisorLaunch,
	waitForPidGone,
} from "../../helpers/rpc-generation-support.ts";
import { writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";

// The real judge for every case; one case replaces a single verdict to reach the stop it gates.
vi.mock("../../../src/modes/rpc/host-stale-engine.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/modes/rpc/host-stale-engine.ts")>();
	return { ...actual, judgeStaleEngine: vi.fn(actual.judgeStaleEngine) };
});

const IDLE_EXIT_MS = 600_000;
const NEWER_CLIENT = engineBuildIdentityFrom({ version: "2999.1.1" });
const PAST_WINDOW = () => Date.now() + IDLE_EXIT_MS + 3_600_000;
const roots: GenerationScratch[] = [];
const peers: JsonlPeer[] = [];

afterEach(async () => {
	for (const peer of peers.splice(0)) peer.destroy();
	for (const qa of roots.splice(0)) {
		await reapProcessesUnder(qa.root);
		await rm(qa.root, { recursive: true, force: true });
	}
}, 60_000);

async function idleHost(label: string): Promise<{ qa: GenerationScratch; supervisor: number; host: number }> {
	const qa = generationScratch(label);
	roots.push(qa);
	writeRpcModelsJson(qa.agentDir, "http://127.0.0.1:1");
	const ensured = await ensureHost({
		socket: qa.socket,
		agentDir: qa.agentDir,
		hostArgs: [...GENERATION_HOST_ARGS, "--session-runtime", "in-process"],
		env: generationEnv(qa),
		policy: { idleExitMs: IDLE_EXIT_MS },
		_test: { readinessTimeoutMs: 60_000, launch: supervisorLaunch },
	});
	ensured.release();
	const paths = createHostDaemonPaths({ socket: qa.socket, agentDir: qa.agentDir });
	const registration = await readHostRegistration(paths);
	if (!registration) throw new Error("no registration");
	const child = JSON.parse(await readFile(generationPaths(paths, registration.instanceId).childPidFile, "utf8"));
	return { qa, supervisor: registration.record.pid, host: child.pid };
}

async function attach(qa: GenerationScratch): Promise<JsonlPeer> {
	const peer = await JsonlPeer.connect(qa.socket);
	peers.push(peer);
	expect(await peer.request({ id: "info", type: "get_protocol_info" })).toMatchObject({ success: true });
	return peer;
}

const staleEngine = { client: NEWER_CLIENT, now: PAST_WINDOW };

// #3268: an endpoint whose host runs an older engine, holds nothing, and outlived its own idle window.
describe.skipIf(process.platform === "win32")("stale old-engine hosts (#3268)", () => {
	it("stops an older-engine host with no session, reservation or client past its idle window", async () => {
		const { qa, supervisor, host } = await idleHost("stale");
		const [row] = await readAllHostStatus({ agentDir: qa.agentDir, includeWorkers: true, staleEngine });
		expect(row?.stale_old_engine).toBe(true);
		const result = await gcHostEndpoints(qa.agentDir, { staleEngine });
		expect(result.stopped).toEqual([expect.objectContaining({ socket: qa.socket, reason: "stale_old_engine" })]);
		expect(await waitForPidGone(supervisor, 20_000)).toBe(true);
		expect(await waitForPidGone(host, 20_000)).toBe(true);
	}, 90_000);

	it("keeps a host that still has a connected client", async () => {
		const { qa, supervisor } = await idleHost("client");
		await attach(qa);
		const result = await gcHostEndpoints(qa.agentDir, { staleEngine });
		expect(result.stopped).toBeUndefined();
		expect(result.kept).toEqual([expect.objectContaining({ socket: qa.socket, reason: "stale_clients" })]);
		expect(processAlive(supervisor)).toBe(true);
	}, 90_000);

	it("keeps a host that holds a session", async () => {
		const { qa, supervisor } = await idleHost("session");
		const peer = await attach(qa);
		openedSessionId(
			await peer.request({ id: "open", type: "open_session", cwd: qa.cwd, retain_on_disconnect: true }),
		);
		peer.destroy();
		const result = await gcHostEndpoints(qa.agentDir, { staleEngine });
		expect(result.stopped).toBeUndefined();
		expect(result.kept).toEqual([expect.objectContaining({ socket: qa.socket, reason: "stale_sessions" })]);
		expect(processAlive(supervisor)).toBe(true);
	}, 90_000);

	it.each([
		["the same engine", { client: engineBuildIdentity(), now: PAST_WINDOW }, "live_generation"],
		["a host still inside its idle window", { client: NEWER_CLIENT, now: Date.now }, "stale_young"],
	] as const)(
		"keeps %s",
		async (_case, options, reason) => {
			const { qa, supervisor } = await idleHost("keep");
			const [row] = await readAllHostStatus({ agentDir: qa.agentDir, includeWorkers: true, staleEngine: options });
			expect(row?.stale_old_engine).toBe(false);
			const result = await gcHostEndpoints(qa.agentDir, { staleEngine: options });
			expect(result.stopped).toBeUndefined();
			expect(result.kept).toEqual([expect.objectContaining({ socket: qa.socket, reason })]);
			expect(processAlive(supervisor)).toBe(true);
		},
		90_000,
	);

	it("refuses a stop that requires an answer from a host that stopped answering", async () => {
		const { qa, supervisor, host } = await idleHost("silent");
		process.kill(host, "SIGSTOP");
		try {
			const result = await stopHost({
				socket: qa.socket,
				agentDir: qa.agentDir,
				timeoutMs: 500,
				requireAnswer: true,
			});
			expect(result).toEqual({ action: "refuse", reason: "sessions_live" });
			expect(processAlive(supervisor)).toBe(true);
		} finally {
			process.kill(host, "SIGCONT");
		}
	}, 90_000);

	// senpi#7623: a host judged stale whose stop cannot prove it (no key record for its launch under the key root) is
	// kept as stale_unproven_owner and never signalled. An empty SENPI_RPC_KEY_ROOT stands in for that root.
	it("keeps a stale host it cannot prove as stale_unproven_owner, unsignalled", async () => {
		const { qa, supervisor, host } = await idleHost("unproven");
		const emptyRoot = join(qa.root, "other-agent");
		mkdirSync(emptyRoot, { recursive: true, mode: 0o700 });
		vi.mocked(judgeStaleEngine).mockResolvedValueOnce({ stale: true, pid: supervisor });
		const saved = process.env.SENPI_RPC_KEY_ROOT;
		process.env.SENPI_RPC_KEY_ROOT = emptyRoot;
		try {
			const result = await gcHostEndpoints(qa.agentDir, { staleEngine });
			expect(result.stopped).toBeUndefined();
			expect(result.kept).toEqual([expect.objectContaining({ socket: qa.socket, reason: "stale_unproven_owner" })]);
		} finally {
			if (saved === undefined) delete process.env.SENPI_RPC_KEY_ROOT;
			else process.env.SENPI_RPC_KEY_ROOT = saved;
		}
		expect(processAlive(supervisor)).toBe(true);
		expect(processAlive(host)).toBe(true);
	}, 90_000);

	it("never judges a live host without the stale-engine option", async () => {
		const { qa, supervisor } = await idleHost("plain");
		const result = await gcHostEndpoints(qa.agentDir);
		expect(result.kept).toEqual([expect.objectContaining({ socket: qa.socket, reason: "live_generation" })]);
		expect(processAlive(supervisor)).toBe(true);
	}, 90_000);
});
