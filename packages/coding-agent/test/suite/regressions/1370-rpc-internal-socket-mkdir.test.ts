import * as childProcess from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminateProcessTrees } from "../../../../senpi-codemode/src/kernels/js/process-tree-host.ts";
import { createInternalSocketPath, runHostSupervisor } from "../../../src/modes/rpc/host-lifecycle.ts";
import {
	createSocketSecret,
	readSocketSecret,
	resolveSocketTransportAddress,
	sendSocketHandshake,
	socketSecretPath,
} from "../../../src/modes/rpc/socket-transport.ts";
import { hermeticProviderEnv } from "../../helpers/rpc-hermetic.ts";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	const spawn = vi.fn(actual.spawn);
	return { ...actual, spawn, default: { ...actual, spawn } };
});

// Each wait in the direct-route case has its own deadline, sized for a loaded host, and fails with a named
// error carrying the supervisor's captured stderr. Readiness gets the TEST's own allowance for the
// supervisor's start (the product sets no deadline on it) plus the product's budget for the host child:
// the supervisor holds that child to 30 s to start listening (`waitForListener` in host-lifecycle.ts) and
// exits when it misses. The case ceiling sits above every deadline, so a hang always fails by name, and the
// supervisor tree is stopped on every path (senpi#4689).
const SUPERVISOR_START_ALLOWANCE_MS = 30_000;
const HOST_CHILD_LISTEN_MS = 30_000;
const READINESS_DEADLINE_MS = SUPERVISOR_START_ALLOWANCE_MS + HOST_CHILD_LISTEN_MS;
const ENDPOINT_DEADLINE_MS = 15_000;
// Each cleanup signal (tree stop, then SIGTERM, then SIGKILL to the supervisor itself) gets this long to end it.
const SUPERVISOR_EXIT_DEADLINE_MS = 5_000;
// The stderr pipe can stay open after the supervisor exits (its host child inherits it), so its drain is bounded.
const STDERR_DRAIN_MS = 2_000;
const DIRECT_ROUTE_CEILING_MS =
	READINESS_DEADLINE_MS + 2 * ENDPOINT_DEADLINE_MS + 3 * SUPERVISOR_EXIT_DEADLINE_MS + STDERR_DRAIN_MS + 5_000;

function reasonOf(cause: unknown): string {
	if (!(cause instanceof Error)) return String(cause);
	return cause.cause instanceof Error ? cause.cause.message : cause.message;
}

/**
 * Settles with `work`, or fails by name with the supervisor output so far: `${failure} within <ms> ms`
 * when the deadline passes, `${failure} (<reason>)` when the work itself rejects.
 */
async function withinDeadline<T>(ms: number, failure: string, output: () => string, work: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work.catch((cause: unknown) => {
				throw new Error(`${failure} (${reasonOf(cause)}):\n${output()}`, { cause });
			}),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${failure} within ${ms} ms:\n${output()}`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Signals a process group this test created; a group that is already gone is not an error. */
function signalGroup(group: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-group, signal);
	} catch (cause) {
		if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
	}
}

/** Whether `work` settles within `ms`; never rejects on the deadline. */
async function settlesWithin(ms: number, work: Promise<unknown>): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work.then(() => true),
			new Promise<boolean>((resolveLate) => {
				timer = setTimeout(() => resolveLate(false), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Stops the supervisor tree, then makes sure it is gone. The tree stop signals nothing when it cannot read
 * the process table, so the supervisor's own process group is signalled after it: SIGTERM first, whose
 * shutdown also stops its host child, then SIGKILL. A supervisor that outlives both fails by name.
 */
async function stopSupervisor(supervisor: childProcess.ChildProcess, exited: Promise<unknown>, output: () => string) {
	if (supervisor.pid !== undefined) {
		await terminateProcessTrees([supervisor.pid], { ownerPid: process.pid, graceMs: 1000 });
	}
	if (await settlesWithin(SUPERVISOR_EXIT_DEADLINE_MS, exited)) return;
	const group = supervisor.pid;
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		// The supervisor's own process group (it was spawned detached): the wrapper, the re-executed CLI and the host child.
		if (process.platform === "win32") supervisor.kill(signal);
		else if (group !== undefined && group > 0) signalGroup(group, signal);
		if (await settlesWithin(SUPERVISOR_EXIT_DEADLINE_MS, exited)) return;
	}
	throw new Error(
		`supervisor did not exit within ${3 * SUPERVISOR_EXIT_DEADLINE_MS} ms of cleanup (tree stop, SIGTERM, SIGKILL):\n${output()}`,
	);
}

// Regression coverage for https://github.com/code-yeongyu/senpi/issues/1370
describe("createInternalSocketPath", () => {
	const created: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it.each([false, true])("provisions the win32 public secret before spawning (existing=%s)", async (existing) => {
		const agentDir = mkdtempSync(join(tmpdir(), "rpc1370-"));
		created.push(agentDir);
		const socket = join(agentDir, "rpc", "rpc.sock");
		const secretPath = socketSecretPath(socket);
		const original = existing ? await createSocketSecret(secretPath) : undefined;
		const reachedSpawn = new Error("bootstrap reached child spawn");
		vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));

		await vi.mocked(childProcess.spawn).withImplementation(
			() => {
				throw reachedSpawn;
			},
			async () => {
				await expect(runHostSupervisor({ socket, agentDir, hostArgs: [] })).rejects.toBe(reachedSpawn);
			},
		);
		const secret = await readSocketSecret(secretPath);
		expect(secret).toHaveLength(32);
		if (original) expect(secret).toEqual(original);
	});

	it(
		"starts the real direct supervisor route on a fresh profile and serves the public endpoint",
		async () => {
			// The private hop uses the short outer run root, not this deeper fixture directory.
			const temporaryDirectory = tmpdir();
			const root = mkdtempSync(join(temporaryDirectory, "rpc1370-"));
			created.push(root);
			const agentDir = join(root, "agent");
			const socketPath = join(root, "rpc.sock");
			const secretPath = socketSecretPath(socketPath);
			expect(existsSync(join(agentDir, "rpc-host-daemon"))).toBe(false);
			expect(existsSync(secretPath)).toBe(false);
			const supervisor = childProcess.spawn(
				process.execPath,
				[
					"--import",
					import.meta.resolve("tsx"),
					resolve(import.meta.dirname, "../../../src/cli.ts"),
					"--internal-rpc-host-supervisor",
					"--socket",
					socketPath,
					"--agent-dir",
					agentDir,
					"--no-extensions",
					"--no-skills",
					"--no-prompt-templates",
				],
				{
					cwd: root,
					env: {
						...process.env,
						...hermeticProviderEnv(),
						PI_OFFLINE: "1",
						TMPDIR: temporaryDirectory,
						TMP: temporaryDirectory,
						TEMP: temporaryDirectory,
						SENPI_CODING_AGENT_DIR: agentDir,
						SENPI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
						SENPI_RPC_HOST_COLD_START: "persistent",
					},
					stdio: ["ignore", "ignore", "pipe"],
					// Its own process group: cleanup can still end the whole tree (the CLI re-executes itself under
					// another runtime, then starts the host child) when the process table cannot be read.
					detached: process.platform !== "win32",
				},
			);
			const exited = once(supervisor, "exit");
			const stderr = createInterface({ input: supervisor.stderr });
			const stderrClosed = once(stderr, "close");
			let output = "";
			const captured = () => output;
			let failure: unknown;
			const ready = new Promise<void>((resolveReady) => {
				stderr.on("line", (line) => {
					output = `${output}${line}\n`.slice(-16_000);
					if (line.includes("senpi rpc host ready on ")) resolveReady();
				});
			});
			try {
				// Readiness ends on the ready line or on the supervisor process's own exit, never on its stderr
				// pipe closing: the host child inherits that pipe and can hold it open after the supervisor is gone.
				const earlyExit = await withinDeadline(
					READINESS_DEADLINE_MS,
					"supervisor readiness not reached",
					captured,
					Promise.race([ready.then(() => undefined), exited]),
				);
				if (earlyExit) {
					const [code, signal] = earlyExit;
					// 'exit' can arrive before the pipe drains: read the last lines before quoting them.
					await settlesWithin(STDERR_DRAIN_MS, stderrClosed);
					throw new Error(`supervisor exited (code ${code}, signal ${signal}) before readiness:\n${output}`);
				}
				const secret = process.platform === "win32" ? await readSocketSecret(secretPath) : undefined;
				const socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform, secret));
				const lines = createInterface({ input: socket });
				// Both waits below also end when the connection closes: a refused or vanished endpoint can
				// close the socket without an 'error' event, and a closed endpoint never connects or answers.
				const closed = new AbortController();
				socket.once("close", () => closed.abort(new Error("the connection closed")));
				try {
					await withinDeadline(
						ENDPOINT_DEADLINE_MS,
						"public endpoint did not accept a connection",
						captured,
						once(socket, "connect", { signal: closed.signal }),
					);
					const response = once(lines, "line", { signal: closed.signal });
					if (secret) sendSocketHandshake(socket, secret);
					socket.write(`${JSON.stringify({ id: "bootstrap", type: "get_protocol_info" })}\n`);
					const [line] = await withinDeadline(
						ENDPOINT_DEADLINE_MS,
						"public endpoint did not answer",
						captured,
						response,
					);
					expect(JSON.parse(line)).toMatchObject({ id: "bootstrap", success: true });
					if (secret) expect(await readFile(secretPath)).toEqual(secret);
				} finally {
					lines.close();
					socket.destroy();
				}
			} catch (cause) {
				failure = cause;
			}
			// Cleanup runs on every path; a cleanup failure never hides why the case itself failed.
			let cleanupFailure: unknown;
			try {
				await stopSupervisor(supervisor, exited, captured);
			} catch (cause) {
				cleanupFailure = cause;
			} finally {
				stderr.close();
			}
			if (failure !== undefined && cleanupFailure !== undefined)
				throw new AggregateError(
					[failure, cleanupFailure],
					"the case failed, then its supervisor outlived cleanup",
				);
			if (failure !== undefined) throw failure;
			if (cleanupFailure !== undefined) throw cleanupFailure;
		},
		DIRECT_ROUTE_CEILING_MS,
	);

	it("creates the win32 internal directory when rpc-host-daemon does not exist yet", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-hlc-win32-"));
		created.push(agentDir);
		const daemonDir = join(agentDir, "rpc-host-daemon");
		expect(existsSync(daemonDir)).toBe(false);

		const internal = await createInternalSocketPath(daemonDir, "win32");

		const dir = internal.dir;
		if (dir === undefined) throw new Error("expected an internal socket directory");
		expect(existsSync(dir)).toBe(true);
		expect(dirname(dir)).toBe(daemonDir);
		expect(internal.socket.startsWith("\\\\.\\pipe\\")).toBe(true);
		expect(internal.secretPath).toBe(join(dir, "secret"));
	});

	it("keeps the posix internal directory in the OS temp dir", async () => {
		const internal = await createInternalSocketPath(join(tmpdir(), "senpi-hlc-unused"), "linux");

		const dir = internal.dir;
		if (dir === undefined) throw new Error("expected an internal socket directory");
		created.push(dir);
		expect(existsSync(dir)).toBe(true);
		expect(dirname(dir)).toBe(tmpdir());
		expect(internal.socket).toBe(join(dir, "host.sock"));
	});
});
