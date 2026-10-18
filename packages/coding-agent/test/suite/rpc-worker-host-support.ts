import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { endpoint, type WorkerHostRecord } from "./rpc-host-endpoint.ts";

export type { WorkerHostRecord };

// Keep native-entry rescue live when a registry test controls the host request clock.
const fifoSetTimeout = setTimeout;
const fifoClearTimeout = clearTimeout;

export async function waitForFifoReader(path: string) {
	const opening = open(path, "w");
	let expired = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			opening,
			new Promise<never>((_resolve, reject) => {
				timer = fifoSetTimeout(() => {
					expired = true;
					reject(new Error("FIFO reader entry deadline"));
				}, 35_000);
			}),
		]);
	} catch (cause) {
		if (expired) {
			// Opening both ends releases our pending writer-open even when the tested host failed before entering.
			const rescue = await open(path, "r+");
			await (await opening).close();
			await rescue.close();
		}
		throw cause;
	} finally {
		if (timer) fifoClearTimeout(timer);
	}
}

/** `cli-default` omits `--session-runtime`, so the host picks the runtime its listener implies. */
type HostSessionRuntime = "in-process" | "worker" | "cli-default";

export async function startWorkerHost(
	extensionSource?: string,
	options: { socket?: boolean; node?: boolean; preload?: string; sessionRuntime?: HostSessionRuntime } = {},
) {
	// Worker by default: every rpc-worker-* suite asserts worker-isolate behavior, and a
	// socket host otherwise defaults to the in-process runtime.
	const sessionRuntime: HostSessionRuntime = options.sessionRuntime ?? "worker";
	const scratch = await mkdtemp(join(tmpdir(), "senpi-worker-test-"));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const extension = join(scratch, "gates.mjs");
	if (extensionSource) await writeFile(extension, extensionSource);
	const preload = join(scratch, "observe-transport.mjs");
	if (options.preload) await writeFile(preload, options.preload);
	const bin = join(scratch, "bin");
	await mkdir(bin);
	const bun = options.node ? undefined : process.env.SENPI_RPC_TEST_BUN;
	if (bun) await symlink(bun, join(bin, "bun"));
	await symlink(process.execPath, join(bin, "node"));
	const socketPath = join(scratch, "rpc.sock");
	const binary = options.node ? undefined : process.env.SENPI_RPC_TEST_BINARY;
	const useNode = binary === undefined && bun === undefined;
	// cli.ts intentionally spawns an isolated child for --import. Observed
	// fixtures own the real host PID by entering the same production cli-main.
	const nodeEntry = options.preload ? "dist/cli-main.js" : "dist/cli.js";
	const child = spawn(
		binary ?? join(bin, bun ? "bun" : "node"),
		[
			...(options.preload ? ["--import", preload] : []),
			...(binary ? [] : [resolve(useNode ? nodeEntry : "src/cli.ts")]),
			"--mode",
			"rpc",
			"--multi-session",
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
			...(options.socket ? ["--listen", `unix://${socketPath}`] : []),
			...(sessionRuntime === "cli-default" ? [] : ["--session-runtime", sessionRuntime]),
			...(extensionSource ? ["--extension", extension] : []),
		],
		{
			cwd,
			env: {
				PATH: `${bin}:/usr/bin:/bin`,
				HOME: scratch,
				TMPDIR: scratch,
				SENPI_CODING_AGENT_DIR: agentDir,
				SENPI_OFFLINE: "1",
				SENPI_RPC_CLOSE_GRACE_MS: "100",
				...(useNode ? { SENPI_RUNTIME: "node" } : {}),
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const exited = once(child, "close");
	if (options.preload) {
		child.once("exit", (code, signal) =>
			process.stderr.write(`PRESSURE_CHILD_EXIT ${JSON.stringify({ pid: child.pid, code, signal })}\n`),
		);
		child.once("close", () => process.stderr.write(`PRESSURE_CHILD_CLOSE ${child.pid}\n`));
	}
	let stderr = "";
	let listening: (() => void) | undefined;
	const ready = new Promise<void>((resolveReady) => {
		listening = resolveReady;
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-16000);
		if (stderr.includes("senpi rpc listening on")) listening?.();
	});
	const stdio = endpoint(child.stdout, child.stdin, () => stderr);
	const connections: Array<{ dispose(): void }> = [];
	const dispose = async () => {
		if (options.preload)
			process.stderr.write(
				`PRESSURE_DISPOSE ${JSON.stringify({ pid: child.pid, exitCode: child.exitCode, stdout: child.stdout.readableFlowing, stderr: child.stderr.readableFlowing })}\n`,
			);
		for (const connection of connections) connection.dispose();
		child.kill("SIGTERM");
		const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
		await exited;
		clearTimeout(deadline);
		stdio.dispose();
		if (options.preload) process.stderr.write(`PRESSURE_REMOVE ${scratch}\n`);
		await rm(scratch, { recursive: true, force: true });
		if (options.preload) process.stderr.write(`PRESSURE_REMOVED ${scratch}\n`);
	};
	if (options.socket) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				ready,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error(`Listener deadline: ${stderr}`)), 30_000);
				}),
			]);
		} catch (cause) {
			await dispose();
			throw cause;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	return {
		...stdio,
		cwd,
		scratch,
		agentDir,
		child,
		dispose,
		socketPath,
		/** Host stderr seen so far; the runtime-gate cases assert on what the host warned. */
		stderrText: () => stderr,
		async connect() {
			const socket = createConnection(socketPath);
			const wire = endpoint(socket, socket, () => stderr);
			connections.push({
				dispose: () => {
					wire.dispose();
					socket.destroy();
				},
			});
			await once(socket, "connect", { signal: AbortSignal.timeout(10_000) });
			return wire;
		},
	};
}

/**
 * Socket host booted with NO `--session-runtime`, so it pins the DEFAULT runtime a
 * `--listen` host selects: every session runs IN the host process (no worker isolate,
 * no worker cap). Pass `sessionRuntime` to `startWorkerHost` to pin one explicitly.
 */
export function startInProcessHost(extensionSource?: string) {
	return startWorkerHost(extensionSource, { socket: true, sessionRuntime: "cli-default" });
}
