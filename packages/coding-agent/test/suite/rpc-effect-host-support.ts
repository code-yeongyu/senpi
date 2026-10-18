import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { EFFECT_CRASH_ENV } from "../../src/modes/rpc/effect-crash-point.ts";

export type HostRecord = Record<string, unknown> & {
	id?: string;
	type?: string;
	sessionId?: string;
	success?: boolean;
	errorCode?: string;
	data?: Record<string, unknown>;
	errorData?: Record<string, unknown>;
};

const fauxModule = (): string => {
	const built = fileURLToPath(new URL("../../../ai/dist/providers/faux.js", import.meta.url));
	const source = fileURLToPath(new URL("../../../ai/src/providers/faux.ts", import.meta.url));
	return pathToFileURL(existsSync(built) ? built : source).href;
};

/**
 * Two faux models; every turn is held until it is aborted, so a test decides when a turn ends and a
 * host killed mid-turn leaves a real `running` receipt behind.
 */
const extensionSource = (releaseDir: string): string => `import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from ${JSON.stringify(fauxModule())};
const releaseDir = ${JSON.stringify(releaseDir)};
const released = () => existsSync(join(releaseDir, "release"));
const whenReleased = () => new Promise((resolve) => {
	if (released()) return resolve();
	const watcher = watch(releaseDir, () => {
		if (!released()) return;
		watcher.close();
		resolve();
	});
});
const held = (_context, options) => new Promise((resolve) => {
	const settle = () => resolve(fauxAssistantMessage("held turn ended"));
	if (options?.signal?.aborted) settle();
	else options?.signal?.addEventListener("abort", settle, { once: true });
});
export default function (pi) {
	const faux = fauxProvider({
		api: "fauxeffect",
		provider: "fauxeffect",
		models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-stubborn" }],
	});
	faux.setResponses(Array.from({ length: 32 }, () => held));
	pi.registerProvider(faux.provider);
	// On faux-stubborn an agent_end handler holds the turn open until the test writes \`release\`, past any abort.
	// A non-client abort, the way an extension or a host-side watchdog stops a turn.
	pi.registerCommand("sysabort", { description: "abort the running turn as the system", handler: async (_args, ctx) => ctx.abort("system") });
	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.model?.id === "faux-stubborn") await whenReleased();
	});
	// Publishes live extension work, the way background terminal jobs or monitors do.
	pi.registerCommand("busyext", { description: "publish one live wake source", handler: async () => {
		pi.events.emit("wake_source_state", { source: "test-background-job", activeCount: 1 });
	} });
}`;

export async function rawClient(socketPath: string) {
	const socket = createConnection(socketPath);
	await once(socket, "connect", { signal: AbortSignal.timeout(10_000) });
	const records: HostRecord[] = [];
	const waiters = new Set<(record: HostRecord) => void>();
	// Strict LF framing: a host SIGKILLed mid-write leaves an unterminated tail, which is not a record.
	let pending = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		const lines = (pending + chunk).split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines) {
			if (line === "") continue;
			const record = z.record(z.string(), z.unknown()).parse(JSON.parse(line)) as HostRecord;
			records.push(record);
			for (const waiter of [...waiters]) waiter(record);
		}
	});
	let serial = 0;
	const wait = (predicate: (record: HostRecord) => boolean, ms = 60_000): Promise<HostRecord> =>
		new Promise((resolveRecord, reject) => {
			const seen = records.find(predicate);
			if (seen) return resolveRecord(seen);
			const timer = setTimeout(() => {
				waiters.delete(waiter);
				reject(new Error(`deadline waiting on the socket: ${String(predicate).slice(0, 160)}`));
			}, ms);
			const waiter = (record: HostRecord): void => {
				if (!predicate(record)) return;
				clearTimeout(timer);
				waiters.delete(waiter);
				resolveRecord(record);
			};
			waiters.add(waiter);
		});
	return {
		records,
		wait,
		send(command: Record<string, unknown>): string {
			const id = `raw-${++serial}`;
			socket.write(`${JSON.stringify({ ...command, id })}\n`);
			return id;
		},
		async request(command: Record<string, unknown>): Promise<HostRecord> {
			const id = `raw-${++serial}`;
			const response = wait((record) => record.type === "response" && record.id === id);
			socket.write(`${JSON.stringify({ ...command, id })}\n`);
			return response;
		},
		close(): void {
			socket.destroy();
		},
	};
}
export type RawClient = Awaited<ReturnType<typeof rawClient>>;

/** One agent dir that outlives host processes: `start` launches a fresh host over the same transcripts. */
export async function effectHostWorld() {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-effect-"));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	const bin = join(scratch, "bin");
	await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(bin)]);
	const extension = join(scratch, "faux-effect.mjs");
	const releaseDir = join(scratch, "release");
	await mkdir(releaseDir);
	await writeFile(extension, extensionSource(releaseDir));
	const bun = process.env.SENPI_RPC_TEST_BUN;
	if (bun) await symlink(bun, join(bin, "bun"));
	await symlink(process.execPath, join(bin, "node"));
	const live = new Set<ChildProcess>();
	let generation = 0;

	async function start(options: { crashAt?: string } = {}) {
		const socketPath = join(scratch, `rpc-${++generation}.sock`);
		const child = spawn(
			join(bin, bun ? "bun" : "node"),
			[
				resolve(bun ? "src/cli.ts" : "dist/cli.js"),
				"--mode",
				"rpc",
				"--multi-session",
				"--listen",
				`unix://${socketPath}`,
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-context-files",
				"--extension",
				extension,
			],
			{
				cwd,
				env: {
					PATH: `${bin}:/usr/bin:/bin`,
					HOME: scratch,
					TMPDIR: scratch,
					SENPI_CODING_AGENT_DIR: agentDir,
					SENPI_OFFLINE: "1",
					...(bun ? {} : { SENPI_RUNTIME: "node" }),
					...(options.crashAt === undefined ? {} : { [EFFECT_CRASH_ENV]: options.crashAt }),
				},
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		live.add(child);
		const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));
		void exited.then(() => live.delete(child));
		let stderr = "";
		const listening = new Promise<void>((resolveReady, reject) => {
			const timer = setTimeout(() => reject(new Error(`host never listened: ${stderr}`)), 60_000);
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr = (stderr + chunk.toString()).slice(-16_000);
				if (stderr.includes("senpi rpc listening on")) {
					clearTimeout(timer);
					resolveReady();
				}
			});
			void exited.then(() => {
				clearTimeout(timer);
				reject(new Error(`host exited before listening: ${stderr}`));
			});
		});
		await listening;
		const clients: RawClient[] = [];
		return {
			socketPath,
			exited,
			async connect(): Promise<RawClient> {
				const client = await rawClient(socketPath);
				clients.push(client);
				return client;
			},
			/** SIGTERM, then wait for the process to be gone: the same agent dir can be served again. */
			async stop(): Promise<void> {
				for (const client of clients) client.close();
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
				const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
				await exited;
				clearTimeout(deadline);
			},
			kill(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
				for (const client of clients) client.close();
				child.kill("SIGKILL");
				return exited;
			},
		};
	}

	return {
		cwd,
		agentDir,
		start,
		/** Let every faux-stubborn turn finish. */
		release: (): Promise<void> => writeFile(join(releaseDir, "release"), "go"),
		readEntries: async (path: string): Promise<Record<string, unknown>[]> =>
			(await readFile(path, "utf8"))
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>),
		async [Symbol.asyncDispose]() {
			for (const child of live) child.kill("SIGKILL");
			await Promise.all([...live].map((child) => once(child, "exit")));
			await rm(scratch, { recursive: true, force: true });
		},
	};
}

export async function openSession(client: RawClient, fields: Record<string, unknown>) {
	const opened = await client.request({ type: "open_session", ...fields });
	if (opened.success !== true) throw new Error(`open_session failed: ${JSON.stringify(opened)}`);
	const sessionId = String(opened.data?.sessionId);
	const state = await client.request({ type: "get_state", sessionId });
	return { sessionId, sessionPath: String(state.data?.sessionFile) };
}

/**
 * Run one turn to idle (the faux turn is held until aborted), so the transcript holds messages: a resumed
 * session restores its model from the transcript only when it has a conversation.
 */
export async function settledTurn(client: RawClient, sessionId: string): Promise<void> {
	const started = client.wait((record) => record.type === "agent_start" && record.sessionId === sessionId);
	const idle = client.wait((record) => record.type === "agent_idle" && record.sessionId === sessionId);
	await client.request({ type: "prompt", sessionId, message: "warm up" });
	await started;
	await client.request({ type: "abort", sessionId });
	await idle;
}

export const effectOf = (record: HostRecord): Record<string, unknown> | undefined =>
	(record.data?.effect as Record<string, unknown> | undefined) ?? undefined;
