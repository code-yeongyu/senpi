import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";

const recordSchema = z
	.object({
		type: z.string(),
		id: z.string().optional(),
		command: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
		success: z.boolean().optional(),
		error: z.string().optional(),
		message: z.string().optional(),
		sessionId: z.string().optional(),
		data: z
			.object({
				sessionId: z.string().optional(),
				sessionFile: z.string().optional(),
				attached: z.boolean().optional(),
				state: z.object({ sessionId: z.string(), sessionFile: z.string().optional() }).passthrough().optional(),
				sessions: z
					.array(z.object({ sessionId: z.string(), status: z.string(), sessionPath: z.string().optional() }))
					.optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();
export type WorkerHostRecord = z.infer<typeof recordSchema>;

function endpoint(input: Readable, output: Writable, diagnostic: () => string) {
	let serial = 0;
	const records: WorkerHostRecord[] = [];
	const listeners = new Set<{ accept: (record: WorkerHostRecord) => void; reject: (error: Error) => void }>();
	const lines = createInterface({ input });
	lines.on("line", (line) => {
		try {
			const record = recordSchema.parse(JSON.parse(line));
			records.push(record);
			if (records.length > 512) records.shift();
			for (const listener of [...listeners]) listener.accept(record);
		} catch (cause) {
			const error = cause instanceof Error ? cause : new Error(String(cause));
			for (const listener of [...listeners]) listener.reject(error);
		}
	});
	function wait(predicate: (record: WorkerHostRecord) => boolean, ms = 30_000): Promise<WorkerHostRecord> {
		return new Promise((resolveRecord, reject) => {
			const finish = () => {
				clearTimeout(timer);
				listeners.delete(listener);
			};
			const listener = {
				accept(record: WorkerHostRecord) {
					if (predicate(record)) {
						finish();
						resolveRecord(record);
					}
				},
				reject(error: Error) {
					finish();
					reject(error);
				},
			};
			const timer = setTimeout(() => listener.reject(new Error(`RPC deadline; ${diagnostic()}`)), ms);
			listeners.add(listener);
		});
	}
	return {
		records,
		wait,
		pauseReading: () => input.pause(),
		resumeReading: () => input.resume(),
		send(command: Record<string, unknown>) {
			output.write(`${JSON.stringify(command)}\n`);
		},
		request(command: Record<string, unknown>, ms?: number) {
			const id = `worker-test-${++serial}`;
			const response = wait((record) => record.type === "response" && record.id === id, ms);
			output.write(`${JSON.stringify({ ...command, id })}\n`);
			return response;
		},
		dispose() {
			for (const listener of [...listeners]) listener.reject(new Error("Test endpoint disposed"));
			lines.close();
		},
	};
}

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

export async function startWorkerHost(
	extensionSource?: string,
	options: { socket?: boolean; node?: boolean; preload?: string } = {},
) {
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
		child,
		dispose,
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
