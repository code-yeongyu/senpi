import childProcess, { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { Socket } from "node:net";
import { join } from "node:path";
import { mock } from "node:test";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths, generationPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { readHostRegistration } from "../../../src/modes/rpc/host-daemon-registration.ts";
import { STOP_WAIT_BUDGET_MS } from "../../../src/modes/rpc/host-ensure-stop.ts";
import { type HandoffResult, handoffHost } from "../../../src/modes/rpc/host-handoff.ts";
import {
	type GenerationScratch,
	generationEnv,
	generationScratch,
	HeldAnthropicModel,
	JsonlPeer,
	openedSessionId,
	supervisorLaunch,
} from "../../helpers/rpc-generation-support.ts";
import { writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";
import { RpcOwnerProcesses } from "../../helpers/rpc-owner-processes.ts";

const fixture = join(import.meta.dirname, "../../fixtures/rpc-owner-caller.ts");
const roots: GenerationScratch[] = [];
const processes = new RpcOwnerProcesses();
const peers: JsonlPeer[] = [];
const models: HeldAnthropicModel[] = [];
const EXIT_BOUND_MS = 10_000;

async function caller(qa: GenerationScratch, ownership = "caller", failure?: string): Promise<ChildProcess> {
	const child = spawn(process.execPath, [fixture, qa.socket, qa.agentDir, ownership], {
		env: { ...process.env, ...generationEnv(qa), SENPI_CODING_AGENT_DIR: qa.agentDir },
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	processes.owner(child);
	const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("caller readiness timeout")), 30_000);
		child.on("message", (message, handle) => {
			if (typeof message !== "object" || message === null || !("type" in message)) return;
			if (message.type === "supervisor" && "pid" in message && typeof message.pid === "number") {
				if (!(handle instanceof Socket)) return reject(new Error("missing transferred exit pipe"));
				processes.supervisor(message.pid, handle);
				return;
			}
			clearTimeout(timer);
			resolve({ ...message });
		});
	});
	if (failure) {
		expect(ready).toMatchObject({ type: "failure", error: expect.stringContaining(failure) });
		return child;
	}
	expect(ready, JSON.stringify(ready)).toMatchObject({ type: "ready" });
	await rememberHost(qa);
	// Each native waiter is armed before this caller can be exited by the test.
	await processes.ready();
	return child;
}

async function rememberHost(qa: GenerationScratch): Promise<void> {
	const paths = createHostDaemonPaths({ socket: qa.socket, agentDir: qa.agentDir });
	const registration = await readHostRegistration(paths);
	if (!registration) throw new Error("no supervisor registration");
	processes.remember(registration.record.pid);
	const record = JSON.parse(await readFile(generationPaths(paths, registration.instanceId).childPidFile, "utf8"));
	expect(record.pid).toBeTypeOf("number");
	processes.remember(record.pid);
}

afterEach(async () => {
	for (const peer of peers.splice(0)) peer.destroy();
	for (const model of models.splice(0)) {
		model.release();
		await model.close();
	}
	await processes.cleanup();
	for (const qa of roots.splice(0)) await rm(qa.root, { recursive: true, force: true });
}, STOP_WAIT_BUDGET_MS + 30_000);

async function exitOwner(owner: ChildProcess, signal?: "SIGKILL"): Promise<void> {
	const exited = once(owner, "exit", { signal: AbortSignal.timeout(EXIT_BOUND_MS) });
	if (signal) owner.kill(signal);
	else owner.send("exit");
	await exited;
}

async function peer(qa: GenerationScratch, observe = false): Promise<JsonlPeer> {
	const result = await JsonlPeer.connect(qa.socket);
	peers.push(result);
	expect(await result.request({ id: "info", type: "get_protocol_info", observe })).toMatchObject({ success: true });
	return result;
}

// Here elapsed time IS the assertion: a lifetime must survive the short owner-death exit window.
async function survivesOwnerGrace(connection: JsonlPeer): Promise<void> {
	await expect(connection.waitForClose(4_000)).rejects.toThrow("connection stayed open");
	expect(await connection.request({ id: "still-serving", type: "get_protocol_info", observe: true })).toMatchObject({
		success: true,
	});
}

// #3044: the real detached supervisor and real in-process host must not wait out the 15-minute idle policy.
// POSIX process-table assertions follow the existing supervised lifecycle harness.
describe.skipIf(process.platform === "win32")("RPC owner lifetime", () => {
	it.each(["normal", "SIGKILL"] as const)(
		"exits within the bound after owner %s exit",
		async (exit) => {
			const qa = generationScratch("owner");
			roots.push(qa);
			const owner = await caller(qa);
			const exited = once(owner, "exit", { signal: AbortSignal.timeout(EXIT_BOUND_MS) });
			if (exit === "normal") owner.send("exit");
			else owner.kill("SIGKILL");
			await exited;
			await processes.allGone();
		},
		45_000,
	);

	it("keeps serving a second peer until it disconnects", async () => {
		const qa = generationScratch("peer");
		roots.push(qa);
		const owner = await caller(qa);
		const attached = await peer(qa);
		await exitOwner(owner);
		await survivesOwnerGrace(attached);
		attached.destroy();
		await processes.allGone();
	}, 45_000);

	it("finishes a disconnected in-flight turn before ownerless exit", async () => {
		const qa = generationScratch("turn");
		roots.push(qa);
		const model = await HeldAnthropicModel.start();
		models.push(model);
		writeRpcModelsJson(qa.agentDir, model.origin);
		const owner = await caller(qa);
		const observer = await peer(qa, true);
		const attached = await peer(qa);
		const opened = await attached.request({
			id: "open",
			type: "open_session",
			cwd: qa.cwd,
			retainOnDisconnect: true,
		});
		const sessionId = openedSessionId(opened);
		const data = opened.data;
		if (typeof data !== "object" || data === null) throw new Error("missing open data");
		const state: unknown = Reflect.get(data, "state");
		if (typeof state !== "object" || state === null) throw new Error("missing session state");
		const sessionFile: unknown = Reflect.get(state, "sessionFile");
		if (typeof sessionFile !== "string") throw new Error("missing persisted session file");
		const started = attached.waitFor((event) => event.type === "agent_start" && event.sessionId === sessionId);
		await attached.request({ id: "prompt", type: "prompt", sessionId, message: "hold the turn" });
		await started;
		attached.destroy();
		await exitOwner(owner, "SIGKILL");
		await survivesOwnerGrace(observer);
		model.release();
		await processes.allGone();
		const entries: unknown[] = (await readFile(sessionFile, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(entries).toContainEqual(
			expect.objectContaining({
				message: expect.objectContaining({
					role: "assistant",
					stopReason: "stop",
					content: expect.arrayContaining([expect.objectContaining({ type: "text", text: "held turn complete" })]),
				}),
			}),
		);
	}, 45_000);

	it.each(["unowned", "live"] as const)(
		"does not exit early when %s",
		async (mode) => {
			const qa = generationScratch(mode);
			roots.push(qa);
			const owner = await caller(qa, mode === "unowned" ? "none" : "caller");
			const observer = await peer(qa, true);
			if (mode === "unowned") await exitOwner(owner);
			else {
				const reused = once(owner, "message", { signal: AbortSignal.timeout(10_000) });
				owner.send("reuse");
				expect((await reused)[0]).toEqual({ type: "reused", reused: true });
			}
			await survivesOwnerGrace(observer);
		},
		45_000,
	);

	it("refuses a different live owner and lets a new caller replace a dead one on reuse", async () => {
		const qa = generationScratch("reuse");
		roots.push(qa);
		const owner = await caller(qa);
		const attached = await peer(qa);
		await caller(qa, "caller", "owner is still alive");
		await exitOwner(owner);
		const replacement = await caller(qa);
		attached.destroy();
		const observer = await peer(qa, true);
		await survivesOwnerGrace(observer);
		await exitOwner(replacement, "SIGKILL");
		await processes.allGone();
	}, 45_000);

	it("inherits the owner through a foreign generation handoff", async () => {
		const qa = generationScratch("handoff");
		roots.push(qa);
		const owner = await caller(qa);
		const original = childProcess.spawn;
		const observed = mock.method(
			childProcess,
			"spawn",
			(command: string, args: readonly string[], options: SpawnOptions) => {
				if (!args[0]?.endsWith("host-lifecycle.ts")) return original(command, args, options);
				const stdio = Array.isArray(options.stdio) ? [...options.stdio] : [];
				stdio[1] = "pipe";
				const child = original(command, args, { ...options, stdio });
				if (child.pid === undefined || !(child.stdout instanceof Socket)) throw new Error("missing successor pipe");
				processes.successor(child, child.stdout);
				return child;
			},
		);
		syncBuiltinESMExports();
		let result: HandoffResult;
		try {
			result = await handoffHost({
				socket: qa.socket,
				agentDir: qa.agentDir,
				env: generationEnv(qa),
				_test: { launch: supervisorLaunch },
			});
		} finally {
			observed.mock.restore();
			syncBuiltinESMExports();
		}
		expect(result.action).toBe("handoff");
		await rememberHost(qa);
		const observer = await peer(qa, true);
		await survivesOwnerGrace(observer);
		await exitOwner(owner);
		await processes.allGone();
	}, 60_000);
});
