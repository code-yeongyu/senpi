import childProcess, { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { writeHostRegistration } from "../../../src/modes/rpc/host-daemon-registration.ts";
import { writeHostSettings } from "../../../src/modes/rpc/host-daemon-state.ts";
import * as hostEnsure from "../../../src/modes/rpc/host-ensure.ts";
import { settledOpportunisticHostGc } from "../../../src/modes/rpc/host-gc-pass.ts";
import { observeProtocolInfo } from "../../../src/modes/rpc/host-probe.ts";
import { runHostSessionRequest } from "../../../src/modes/rpc/host-session-runner.ts";
import { readHostStatus } from "../../../src/modes/rpc/host-status.ts";
import * as ownershipLock from "../../../src/modes/rpc/ownership-safe-lock.ts";
import { RpcClient, RpcCommandError } from "../../../src/modes/rpc/rpc-client.ts";
import { readProcessStartTime } from "../../../src/utils/process-identity.ts";
import { generationEnv, generationScratch, JsonlPeer } from "../../helpers/rpc-generation-support.ts";

const fixture = join(import.meta.dirname, "../../fixtures/rpc-stopping-supervisor.ts");
const cleanups: Array<() => Promise<void>> = [];

async function rig() {
	const qa = generationScratch("3059");
	const paths = createHostDaemonPaths({ socket: qa.socket, agentDir: qa.agentDir });
	await writeHostSettings(paths, {
		socket: qa.socket,
		capabilities: [],
		coldStart: "persistent",
		idleExitMs: 60_000,
		generation: 0,
		instanceId: "stopping-generation",
	});
	const supervisor = spawn(process.execPath, [fixture, "controlled", qa.socket, qa.agentDir], {
		env: {
			...process.env,
			...generationEnv(qa),
			SENPI_CODING_AGENT_DIR: qa.agentDir,
			SENPI_RPC_HOST_INSTANCE_ID: "stopping-generation",
		},
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	if (!supervisor.pid) throw new Error("missing supervisor pid");
	const exit = once(supervisor, "exit");
	let stderr = "";
	supervisor.stderr?.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const messages: string[] = [];
	supervisor.on("message", (message) => {
		if (typeof message === "object" && message !== null && "type" in message && typeof message.type === "string")
			messages.push(message.type);
	});
	const wait = async (type: string, after = 0) => {
		if (messages.slice(after).includes(type)) return;
		await new Promise<void>((resolve, reject) => {
			const done = (error?: Error) => {
				clearTimeout(timer);
				supervisor.off("message", check);
				supervisor.off("exit", failed);
				if (error) reject(error);
				else resolve();
			};
			const check = () => {
				if (messages.slice(after).includes(type)) done();
			};
			const failed = () => done(new Error(`supervisor exited before ${type}: ${stderr}`));
			const timer = setTimeout(() => done(new Error(`missing ${type}: ${stderr}`)), 10_000);
			supervisor.on("message", check);
			supervisor.once("exit", failed);
		});
	};
	const peers: JsonlPeer[] = [];
	const clients: RpcClient[] = [];
	const successors: Array<{ child: ChildProcess; exit: Promise<unknown> }> = [];
	cleanups.push(async () => {
		for (const peer of peers) peer.destroy();
		for (const client of clients) await client.stop();
		if (supervisor.exitCode === null && supervisor.signalCode === null) {
			supervisor.kill("SIGTERM");
			supervisor.send("exit");
		}
		await exit;
		for (const next of successors) {
			next.child.kill("SIGTERM");
			await next.exit;
		}
		await settledOpportunisticHostGc(qa.agentDir);
		await rm(qa.root, { recursive: true, force: true });
	});
	await wait("ready");
	await writeHostRegistration(paths, {
		record: { pid: supervisor.pid, processStartTime: (await readProcessStartTime(supervisor.pid)) ?? null },
		socket: qa.socket,
		instanceId: "stopping-generation",
		generation: 0,
		launchProfileId: "fixture",
	});
	const launch = { command: process.execPath, args: [fixture, "successor", qa.socket, qa.agentDir] };
	const spawnOriginal = childProcess.spawn;
	vi.spyOn(childProcess, "spawn").mockImplementation((...args: Parameters<typeof spawnOriginal>) => {
		const child = spawnOriginal(...args);
		if (args[1]?.includes("successor")) successors.push({ child, exit: once(child, "exit") });
		return child;
	});
	// ensureHost imports the native named export; capture its real handle too.
	syncBuiltinESMExports();
	return {
		qa,
		supervisor,
		exit,
		messages,
		wait,
		launch,
		successors,
		stop: async () => {
			supervisor.kill("SIGTERM");
			await wait("child-stopping");
		},
		peer: async () => {
			const peer = await JsonlPeer.connect(qa.socket);
			peers.push(peer);
			return peer;
		},
		client: async () => {
			const client = new RpcClient({ socketPath: qa.socket });
			clients.push(client);
			await client.start();
			return client;
		},
	};
}

afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		vi.restoreAllMocks();
		syncBuiltinESMExports();
	}
});

describe.skipIf(process.platform === "win32")("stopping host admission", () => {
	it("returns a typed refusal when ready is read just before stop on the same connection", async () => {
		const r = await rig();
		const peer = await r.peer();
		expect(await peer.request({ id: "ready", type: "get_protocol_info" })).toMatchObject({ success: true });
		await r.stop();
		expect(await peer.request({ id: "open", type: "open_session", cwd: r.qa.cwd }, 1_000)).toMatchObject({
			id: "open",
			success: false,
			errorCode: "host_stopping",
		});
		expect(r.messages).not.toContain("open-reached-child");
	});

	it("does not adopt a stopping generation and starts only after its observed exit", async () => {
		const r = await rig();
		await r.stop();
		const after = r.messages.length;
		let settled = false;
		const adoption = hostEnsure
			.ensureHost({
				socket: r.qa.socket,
				agentDir: r.qa.agentDir,
				_test: { spawn: r.launch },
			})
			.then(
				(host) => ({ host }),
				(error: unknown) => ({ error }),
			)
			.finally(() => {
				settled = true;
			});
		// A public request proves ensure reached the stopping generation, not a scheduling delay.
		await r.wait("public-probe", after);
		expect(await observeProtocolInfo(r.qa.socket, 1_000)).toMatchObject({ lifecycle: "stopping" });
		expect(settled).toBe(false);
		r.supervisor.send("exit");
		await r.exit;
		const result = await adoption;
		if (!("host" in result)) throw result.error;
		const next = result.host;
		try {
			expect(next.reused).toBe(false);
			expect(next.pid).not.toBe(r.supervisor.pid);
			expect(r.successors.map(({ child }) => child.pid)).toEqual([next.pid]);
		} finally {
			next.release();
		}
	});

	it("retries a launch-owning open into a fresh host after a typed refusal", async () => {
		const r = await rig();
		const ensure = hostEnsure.ensureHost;
		vi.spyOn(hostEnsure, "ensureHost").mockImplementation((options) =>
			ensure({ ...options, _test: { spawn: r.launch } }),
		);
		const open = RpcClient.prototype.openSession;
		let first = true;
		let refusal: unknown;
		vi.spyOn(RpcClient.prototype, "openSession").mockImplementation(async function (this: RpcClient, options) {
			if (first) {
				first = false;
				await r.stop();
				try {
					return await open.call(this, options);
				} catch (error) {
					refusal = error;
					r.supervisor.send("exit");
					throw error;
				}
			}
			return open.call(this, options);
		});
		const outcome = await runHostSessionRequest({
			action: "open",
			target: { socket: r.qa.socket, agentDir: r.qa.agentDir },
			cwd: r.qa.cwd,
			spec: { hostArgs: [], env: {}, policy: {} },
		});
		expect(refusal).toBeInstanceOf(RpcCommandError);
		expect(refusal).toMatchObject({ errorCode: "host_stopping" });
		expect(outcome.exitCode).toBe(0);
		expect(outcome.payload).toMatchObject({ action: "open", reused: false });
		expect(outcome.payload.sessionId).not.toBe("stopping-generation");
		expect(r.successors.map(({ child }) => child.pid)).toEqual([outcome.payload.pid]);
	});

	it("gives two callers waiting during stopping exactly one fresh generation", async () => {
		const r = await rig();
		await r.stop();
		let entered = 0;
		let bothEntered!: () => void;
		const contending = new Promise<void>((resolve) => {
			bothEntered = resolve;
		});
		const acquire = ownershipLock.acquireOwnershipSafeLock;
		const target = `${hostEnsure.hostEnsureLockTarget(r.qa.socket)}.lock`;
		vi.spyOn(ownershipLock, "acquireOwnershipSafeLock").mockImplementation((...args) => {
			if (args[0] === target && ++entered === 2) bothEntered();
			return acquire(...args);
		});
		const after = r.messages.length;
		const callers = [0, 1].map(() =>
			hostEnsure
				.ensureHost({
					socket: r.qa.socket,
					agentDir: r.qa.agentDir,
					_test: { spawn: r.launch },
				})
				.then(
					(host) => ({ host }),
					(error: unknown) => ({ error }),
				),
		);
		await contending;
		await r.wait("public-probe", after);
		expect(r.successors).toHaveLength(0);
		r.supervisor.send("exit");
		await r.exit;
		const results = await Promise.all(callers);
		try {
			const hosts = results.map((result) => {
				if (!("host" in result)) throw result.error;
				return result.host;
			});
			expect(hosts[0].pid).toBe(hosts[1].pid);
			expect(hosts.map((host) => host.reused).sort()).toEqual([false, true]);
			expect(r.successors.map(({ child }) => child.pid)).toEqual([hosts[0].pid]);
		} finally {
			for (const result of results) if ("host" in result) result.host.release();
		}
	});

	it("reports stopping through both discovery and host status while the child remains alive", async () => {
		const r = await rig();
		await r.stop();
		expect(await observeProtocolInfo(r.qa.socket, 1_000)).toMatchObject({
			instanceId: "stopping-generation",
			lifecycle: "stopping",
		});
		expect(
			await readHostStatus({ socket: r.qa.socket, agentDir: r.qa.agentDir }, { timeoutMs: 1_000 }),
		).toMatchObject({
			reachable: true,
			lifecycle: "stopping",
			instanceId: "stopping-generation",
		});
		expect(r.messages).not.toContain("child-exited");
	});

	it("fails closed at the stop budget without signalling or replacing the live generation", async () => {
		const r = await rig();
		await r.stop();
		await expect(
			hostEnsure.ensureHost({
				socket: r.qa.socket,
				agentDir: r.qa.agentDir,
				stoppingTimeoutMs: 0,
				_test: { spawn: r.launch },
			}),
		).rejects.toMatchObject({ reason: "host_stopping" });
		expect(r.supervisor.exitCode).toBeNull();
		expect(r.messages).not.toContain("child-exited");
		expect(await observeProtocolInfo(r.qa.socket, 1_000)).toMatchObject({
			instanceId: "stopping-generation",
			lifecycle: "stopping",
		});
	});

	it("refuses an in-flight open before child teardown instead of exposing a half attachment", async () => {
		const r = await rig();
		const client = await r.client();
		r.supervisor.send("hold-open");
		await r.wait("open-held");
		const opened = client.openSession({ cwd: r.qa.cwd }).catch((error: unknown) => error);
		await r.wait("open-reached-child");
		await r.stop();
		expect(await opened).toMatchObject({ errorCode: "host_stopping" });
		r.supervisor.send("release-open");
	});

	it("advertises stopping and refuses new peers as soon as a drain is requested", async () => {
		const r = await rig();
		r.supervisor.kill("SIGUSR1");
		await r.wait("child-draining");
		const client = await r.client();
		await expect(client.openSession({ cwd: r.qa.cwd })).rejects.toMatchObject({ errorCode: "host_stopping" });
		expect(await observeProtocolInfo(r.qa.socket, 1_000)).toMatchObject({ lifecycle: "stopping" });
		expect(r.messages).not.toContain("open-reached-child");
	});
});
