import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { hermeticProviderEnv, MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";
import { type RecordValue, waitForJsonLine } from "../../rpc-protocol-identity-support.ts";

// A real `senpi --mode rpc` host under Bun, holding a session file with large resident entries and a
// test extension that opens a JS kernel (`/memory-fill`), keeps a cell running (`/memory-hold`) and
// registers a task-child memory reporter.

const CLI = join(import.meta.dirname, "..", "..", "..", "src", "cli.ts");
const RESIDENT_TEXT_BYTES = 40 * 1024;
const REPORT_DEADLINE_MS = 5_000;
const POLL_MS = 25;
export const RESIDENT_ENTRIES = 3;
export const TASK_CHILD_FIGURES = { records: 2, retainedTranscriptBytes: 4096, inProcess: 1, hostSession: 0 };

const footprint = z.object({ bytes: z.number(), measure: z.string() });
export const memoryReport = z.object({
	sessionId: z.string(),
	main: z.object({ jscHeapSize: z.number(), heapUsed: z.number(), external: z.number(), footprint }),
	kernels: z.array(
		z.object({
			id: z.string(),
			sessionId: z.string(),
			language: z.string(),
			measure: z.string(),
			lastLiveBytes: z.number().optional(),
			stale: z.boolean(),
		}),
	),
	residentStore: z.object({ entries: z.number(), approxBytes: z.number() }),
	taskChildren: z.record(z.string(), z.number()).optional(),
	tuiRenderCache: z.unknown().optional(),
	heapSnapshot: z.string().optional(),
});
export type MemoryReport = z.infer<typeof memoryReport>;

export interface MemoryReportHost {
	readonly child: ChildProcessWithoutNullStreams;
	readonly root: string;
	readonly memoryDir: string;
	readonly holdMarker: string;
	stderr(): string;
	/** Resolves once stderr contains `text`; rejects after `deadlineMs` with what stderr held. */
	waitForStderr(text: string, deadlineMs: number): Promise<void>;
	request(command: RecordValue): Promise<RecordValue>;
	runCommand(name: string): Promise<void>;
}

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

export function cleanupMemoryReportHosts(): void {
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export async function startMemoryReportHost(env: Readonly<Record<string, string>> = {}): Promise<MemoryReportHost> {
	const root = mkdtempSync(join(tmpdir(), "senpi-2561-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "work");
	mkdirSync(join(cwd, ".senpi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeRpcModelsJson(agentDir, "http://127.0.0.1:1");
	writeFileSync(join(cwd, ".senpi", "settings.json"), JSON.stringify({ permission: { eval: "allow" } }));
	const holdMarker = join(root, "hold-started");
	const extension = join(root, "memory-probe.ts");
	writeFileSync(extension, probeExtension(holdMarker));
	const sessionFile = join(root, "session.jsonl");
	writeFileSync(sessionFile, residentSession(cwd));
	const scrubbed: Record<string, string | undefined> = { ...process.env, ...hermeticProviderEnv() };
	for (const key of ["SENPI_MEMORY_REPORT", "SENPI_MEMORY_REPORT_SNAPSHOT", "SENPI_RUNTIME", "SENPI_RPC_SOCKET"]) {
		delete scrubbed[key];
	}
	const child = spawn(
		"bun",
		[CLI, "--mode", "rpc", "--session", sessionFile, "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL].concat([
			"--no-skills",
			"--no-context-files",
			"-e",
			extension,
		]),
		{
			cwd,
			env: {
				...scrubbed,
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				SENPI_CODING_AGENT_DIR: agentDir,
				SENPI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
				...env,
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	children.push(child);
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	let serial = 0;
	const request = async (command: RecordValue): Promise<RecordValue> => {
		const id = `req-${++serial}`;
		const reply = waitForJsonLine(child.stdout, (value) => value.type === "response" && value.id === id, 60_000);
		child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		return await reply;
	};
	const host: MemoryReportHost = {
		child,
		root,
		memoryDir: join(root, "session-artifacts", "memory"),
		holdMarker,
		stderr: () => stderr,
		// stderr and the stdout reply are separate pipes, so a line written before the reply can still arrive after it.
		waitForStderr: (text, deadlineMs) =>
			new Promise<void>((resolve, reject) => {
				const onData = (): void => {
					if (!stderr.includes(text)) return;
					clearTimeout(timer);
					child.stderr.off("data", onData);
					resolve();
				};
				const timer = setTimeout(() => {
					child.stderr.off("data", onData);
					reject(
						new Error(
							`stderr never contained ${JSON.stringify(text)} within ${deadlineMs} ms; got: ${JSON.stringify(stderr)}`,
						),
					);
				}, deadlineMs);
				child.stderr.on("data", onData);
				onData();
			}),
		request,
		async runCommand(name) {
			const done = waitForJsonLine(
				child.stdout,
				(value) => value.type === "extension_ui_request" && value.message === `${name} done`,
				90_000,
			);
			// An extension command's prompt is answered only after its handler returns, which `memory-hold` never does.
			child.stdin.write(`${JSON.stringify({ type: "prompt", message: `/${name}`, id: `cmd-${++serial}` })}\n`);
			await done;
		},
	};
	await request({ type: "get_state" });
	return host;
}

/** Signals the host through `process.kill(pid, "SIGUSR2")` (never `child.kill` by name) and waits for the report it writes. */
export async function signalForReport(host: MemoryReportHost): Promise<MemoryReport> {
	const known = new Set(reportFiles(host.memoryDir));
	const report = waitForReportFile(host, known);
	const pid = host.child.pid;
	if (pid === undefined) throw new Error("host has no pid");
	process.kill(pid, "SIGUSR2");
	return memoryReport.parse(JSON.parse(readFileSync(join(host.memoryDir, await report), "utf8")));
}

export function reportFiles(memoryDir: string): string[] {
	try {
		return readdirSync(memoryDir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
}

export function waitForExit(child: ChildProcessWithoutNullStreams): Promise<NodeJS.Signals | number | null> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.signalCode ?? child.exitCode);
	return new Promise((resolve) => child.once("exit", (code, signal) => resolve(signal ?? code)));
}

export async function waitForPath(path: string, deadlineMs: number): Promise<void> {
	await pollUntil(
		() => {
			try {
				readFileSync(path);
				return true;
			} catch {
				return false;
			}
		},
		deadlineMs,
		`file ${path}`,
	);
}

function waitForReportFile(host: MemoryReportHost, known: ReadonlySet<string>): Promise<string> {
	let found: string | undefined;
	return pollUntil(
		() => {
			if (host.child.exitCode !== null || host.child.signalCode !== null) {
				throw new Error(`host exited (${host.child.signalCode ?? host.child.exitCode}) before writing a report`);
			}
			found = reportFiles(host.memoryDir).find((name) => !known.has(name));
			return found !== undefined;
		},
		REPORT_DEADLINE_MS,
		"a memory report",
	).then(() => found ?? "");
}

function pollUntil(check: () => boolean, deadlineMs: number, what: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const timer = setInterval(() => {
			try {
				if (check()) {
					clearInterval(timer);
					resolve();
				} else if (Date.now() - started > deadlineMs) {
					clearInterval(timer);
					reject(new Error(`no ${what} within ${deadlineMs} ms`));
				}
			} catch (error) {
				clearInterval(timer);
				reject(error);
			}
		}, POLL_MS);
	});
}

function residentSession(cwd: string): string {
	const lines: RecordValue[] = [
		{ type: "session", version: 3, id: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd },
	];
	let parentId: string | null = null;
	for (let index = 0; index < RESIDENT_ENTRIES; index++) {
		const id = `e${index}`.padEnd(8, "0");
		const text = `${index}`.repeat(RESIDENT_TEXT_BYTES);
		const message = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
		lines.push({ type: "message", id, parentId, timestamp: new Date().toISOString(), message });
		parentId = id;
	}
	return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function probeExtension(holdMarker: string): string {
	return `
export default function (pi) {
	pi.registerMemoryReporter("taskChildren", () => (${JSON.stringify(TASK_CHILD_FIGURES)}));
	const evalCell = (summary, code) => pi.executeTool("eval", { language: "js", summary, code, on_timeout: "error" });
	pi.registerCommand("memory-fill", {
		description: "allocate 100 MiB in the JS kernel",
		handler: async (_args, ctx) => {
			await evalCell("fill", "globalThis.fill = new Uint8Array(100 * 1024 * 1024).fill(1); fill.length");
			ctx.ui.notify("memory-fill done", "info");
		},
	});
	pi.registerCommand("memory-hold", {
		description: "keep a JS cell running",
		handler: async (_args, ctx) => {
			ctx.ui.notify("memory-hold done", "info");
			await evalCell("hold", ${JSON.stringify(`(await import("node:fs")).writeFileSync(${JSON.stringify(holdMarker)}, "started"); await new Promise((resolve) => setTimeout(resolve, 120000));`)});
		},
	});
}
`;
}
