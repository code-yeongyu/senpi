/**
 * Standalone manual QA, never a default-suite test. Run from the worktree root:
 * SENPI_CLI="$PWD/packages/coding-agent/dist/bundle/cli.js" \
 *   node --import tsx packages/coding-agent/test/manual-qa/parked-session-cpu.ts --arm baseline
 * Repeat with --arm patched AFTER the parent rebuilds the same artifact.
 * SENPI_CLI must be a Node-loadable JS CLI preserving FileWatchLoop names (not a compiled executable).
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../../src/modes/rpc/rpc-client.ts";
import { MOCK_API_KEY, MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "../helpers/rpc-hermetic.ts";
import { fakeModel, manifestWritten, nextPolls, observe, processProof, stopHost } from "./parked-session-support.ts";

const arm = process.argv[process.argv.indexOf("--arm") + 1];
assert(arm === "baseline" || arm === "patched", "pass --arm baseline|patched");
assert(process.env.SENPI_CLI, "SENPI_CLI must name the frozen JS CLI artifact");
assert(!("bun" in process.versions), "run this driver with Node, not Bun");
const cli = resolve(process.env.SENPI_CLI);
const sibling = dirname(fileURLToPath(import.meta.url));
const root = await realpath(await mkdtemp(join(tmpdir(), "parkqa-")));
const agentDir = join(root, "agent");
const cwd = join(root, "cwd");
const socketPath = join(root, "rpc.sock");
const observerSocket = join(root, "obs.sock");
const paths = [0, 1, 2].map((index) => join(cwd, `watch-${index}.log`));
const clients: RpcClient[] = [];
const observedEvents: unknown[] = [];
const abort = new AbortController();
let host: ChildProcess | undefined;
let fake: Awaited<ReturnType<typeof fakeModel>> | undefined;
let stderr = "";
let failed = false;
const receipt = (phase: string, data: unknown) => console.log(JSON.stringify({ arm, phase, data }));
const signal = () => abort.abort(new Error("QA interrupted"));
process.once("SIGINT", signal);
process.once("SIGTERM", signal);

async function connected(): Promise<RpcClient> {
	const client = new RpcClient({ socketPath });
	clients.push(client);
	client.onEvent((event) => observedEvents.push(event));
	await client.start();
	return client;
}
async function run(): Promise<void> {
	for (const dir of [agentDir, cwd, join(root, "home"), join(root, "tmp")]) await mkdir(dir, { recursive: true });
	await Promise.all(paths.map((path) => writeFile(path, "initial\n")));
	fake = await fakeModel(paths);
	writeRpcModelsJson(agentDir, fake.origin);
	// Keep monitor directly callable; this probe measures terminal polling, not eval routing.
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({
			compaction: { enabled: false },
			disabledBuiltinExtensions: ["codemode"],
		}),
	);
	const sha256 = createHash("sha256")
		.update(await readFile(cli))
		.digest("hex");
	receipt("artifact", { cli, sha256, node: process.version, measurementMs: 20_000 });
	host = spawn(
		process.execPath,
		[
			"--require",
			join(sibling, "parked-session-observer.cjs"),
			cli,
			"--mode",
			"rpc",
			"--multi-session",
			"--session-runtime",
			"in-process",
			"--listen",
			`unix://${socketPath}`,
			"--no-extensions",
			"--extension",
			join(sibling, "parked-session-observer-extension.ts"),
			"--provider",
			MOCK_PROVIDER,
			"--model",
			MOCK_MODEL,
		],
		{
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			// Deliberate allowlist: no ambient credentials, brand, config, proxy, or NODE_OPTIONS.
			env: {
				PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
				HOME: join(root, "home"),
				TMPDIR: join(root, "tmp"),
				XDG_CONFIG_HOME: join(root, "home", ".config"),
				XDG_CACHE_HOME: join(root, "home", ".cache"),
				XDG_DATA_HOME: join(root, "home", ".local", "share"),
				SENPI_CODING_AGENT_DIR: agentDir,
				SENPI_RUNTIME: "node",
				SENPI_CLI_ISOLATED_CHILD: "1",
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				ANTHROPIC_API_KEY: MOCK_API_KEY,
				PARKED_QA_RPC_SOCKET: socketPath,
				PARKED_QA_OBSERVER_SOCKET: observerSocket,
				LANG: "en_US.UTF-8",
				TERM: "dumb",
			},
		},
	);
	const child = host;
	child.stdout?.on("data", () => {}); // Drain; protocol lives on the real Unix socket.
	await new Promise<void>((resolveReady, reject) => {
		const timer = setTimeout(() => finish(new Error(`host readiness timeout: ${stderr}`)), 60_000);
		const finish = (error?: Error) => {
			clearTimeout(timer);
			child.off("exit", exited);
			child.off("error", errored);
			error ? reject(error) : resolveReady();
		};
		const exited = () => finish(new Error(`host exited before readiness: ${stderr}`));
		const errored = (error: Error) => finish(error);
		child.once("exit", exited);
		child.once("error", errored);
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-64_000);
			if (stderr.includes("parked-qa-observer-ready") && stderr.includes(`rpc listening on unix://${socketPath}`))
				finish();
		});
	});
	assert(child.pid, "host did not spawn");
	const sessions: Array<{ sessionId: string; durableId: string; path: string }> = [];
	for (let index = 0; index < paths.length; index++) {
		abort.signal.throwIfAborted();
		const client = await connected();
		const opened = await client.openSession({
			cwd,
			provider: MOCK_PROVIDER,
			modelId: MOCK_MODEL,
			thinkingLevel: "off",
			permissionPreset: "full-access",
			retain_on_disconnect: true,
		});
		const path = opened.state.sessionFile;
		assert(path, "open_session omitted sessionFile");
		sessions.push({ sessionId: opened.sessionId, durableId: opened.state.sessionId, path });
		const manifest = join(dirname(path), "extensions", "terminal", `${opened.state.sessionId}.json`);
		await mkdir(dirname(manifest), { recursive: true });
		const persisted = manifestWritten(manifest, paths[index], abort.signal);
		const [events, contents] = await Promise.all([
			client
				.promptAndWait(
					`parked-qa-watch-${index}: start the requested persistent native file monitor.`,
					undefined,
					60_000,
				)
				.then((events) => {
					receipt("turn", { index, events: events.filter((event) => event.type === "tool_execution_end") });
					return events;
				}),
			persisted,
		]);
		assert(
			events.some((event) => event.type === "tool_execution_end" && event.toolName === "monitor" && !event.isError),
			`session ${index}: no successful real monitor execution`,
		);
		receipt("monitor", { session: sessions[index], manifest: contents });
	}
	const initial = await observe(observerSocket, "?wait=polling");
	assert.equal(initial.pid, child.pid, "preload and CLI must run in the same process");
	assert.equal(initial.events.filter((event) => event.type === "session_start").length, 3);
	assert.equal(fake.calls.filter((call) => call.tool).length, 3);
	receipt("initial-polls", initial);
	const closed = observe(observerSocket, "?wait=closed&count=3");
	await Promise.all([...clients.map((client) => client.stop()), closed]);
	if (arm === "patched") await observe(observerSocket, "?wait=session_parked&count=3");
	// A non-session control client verifies retention without attaching to any session.
	const admin = await connected();
	const retained = await admin.listSessions();
	assert.equal(retained.length, 3);
	for (const session of sessions)
		assert(retained.some((entry) => entry.sessionId === session.sessionId && entry.attachments === 0));
	const adminClosed = observe(observerSocket, "?wait=closed&count=4");
	await Promise.all([admin.stop(), adminClosed]);
	receipt("retained", retained);
	const before = await observe(observerSocket);
	assert.equal(before.loops.filter((loop) => loop.active).length, arm === "baseline" ? 3 : 0);
	const cpuBefore = await processProof(child.pid);
	const started = performance.now();
	// The duration IS the behavior measured here; this is not a readiness sleep.
	await new Promise<void>((resolveWindow, reject) => {
		const interrupted = () => {
			clearTimeout(timer);
			reject(abort.signal.reason);
		};
		const timer = setTimeout(() => {
			abort.signal.removeEventListener("abort", interrupted);
			resolveWindow();
		}, 20_000);
		abort.signal.addEventListener("abort", interrupted, { once: true });
		if (abort.signal.aborted) interrupted();
	});
	const cpuAfter = await processProof(child.pid);
	const elapsedMs = performance.now() - started;
	const after = await observe(observerSocket);
	const pollDelta =
		after.loops.reduce((sum, loop) => sum + loop.polls, 0) - before.loops.reduce((sum, loop) => sum + loop.polls, 0);
	const cpuSeconds = cpuAfter.seconds - cpuBefore.seconds;
	receipt("measurement", {
		elapsedMs,
		cpuSeconds,
		cpuPercentOneCore: (cpuSeconds / (elapsedMs / 1000)) * 100,
		pollDelta,
		before,
		after,
		cpuBefore,
		cpuAfter,
	});
	assert.equal(child.exitCode, null, "host exited with no attached sockets");
	assert.equal(child.signalCode, null);
	if (arm === "patched") {
		assert.equal(pollDelta, 0, "parked file callbacks still fired");
		assert.equal(after.loops.filter((loop) => loop.active).length, 0);
	} else {
		for (const loop of before.loops.filter((entry) => entry.active))
			assert(
				(after.loops.find((entry) => entry.id === loop.id)?.polls ?? 0) > loop.polls,
				"baseline loop did not poll",
			);
	}
	const polling = observe(observerSocket, nextPolls(after));
	await Promise.all([
		polling,
		(async () => {
			for (const session of sessions) {
				const client = await connected();
				const opened = await client.openSession({ sessionPath: session.path, retain_on_disconnect: true });
				assert.equal(opened.attached, true);
				assert.equal(opened.sessionId, session.sessionId);
				assert.equal(opened.state.sessionFile, session.path);
				assert.equal(opened.state.sessionId, session.durableId);
			}
		})(),
	]);
	if (arm === "patched") await observe(observerSocket, "?wait=session_resumed&count=3");
	const resumed = await observe(observerSocket);
	assert.equal(
		resumed.events.filter((event) => event.type === "session_start").length,
		3,
		"reattach recreated a session",
	);
	if (arm === "patched")
		for (const session of sessions)
			for (const type of ["session_parked", "session_resumed"])
				assert.equal(
					resumed.events.filter((event) => event.type === type && event.sessionId === session.durableId).length,
					1,
				);
	receipt("resumed-polls", resumed);
	receipt("pass", { arm, pollDelta, cpuPercentOneCore: (cpuSeconds / (elapsedMs / 1000)) * 100 });
}
try {
	await run();
} catch (error) {
	failed = true;
	receipt("failure", {
		error: String(error),
		stderr,
		modelCalls: fake?.calls,
		events: observedEvents
			.filter(
				(event) =>
					typeof event === "object" && event !== null && "type" in event && event.type === "tool_execution_end",
			)
			.slice(0, 3),
	});
} finally {
	abort.abort(new Error("QA cleanup"));
	const errors: string[] = [];
	for (const client of clients)
		try {
			await client.stop();
		} catch (error) {
			errors.push(String(error));
		}
	if (host)
		try {
			await stopHost(host);
		} catch (error) {
			errors.push(String(error));
		}
	if (fake)
		try {
			await fake.close();
		} catch (error) {
			errors.push(String(error));
		}
	try {
		await rm(root, { recursive: true, force: true });
	} catch (error) {
		errors.push(String(error));
	}
	process.off("SIGINT", signal);
	process.off("SIGTERM", signal);
	receipt("cleanup", { root, hostPid: host?.pid, hostExit: host?.exitCode, hostSignal: host?.signalCode, errors });
	if (failed || errors.length) process.exitCode = 1;
}
