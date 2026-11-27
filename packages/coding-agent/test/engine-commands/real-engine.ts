import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, onTestFinished } from "vitest";

export const CLI = join(__dirname, "..", "..", "src", "cli.ts");
export const CLI_MAIN = join(__dirname, "..", "..", "src", "cli-main.ts");

// Every run gets a fresh home, which would also give Bun a cold runtime transpiler cache for each start: measured at
// load 29 to 59, ten paired starts of cli-main took a median 4.5 s with a fresh cache and 2.5 s with a shared one (32.0 s
// against 17.9 s at load 58.6). The runs of one test file share one cache directory, outside every run's home, removed
// after the file; nothing else of the child's environment is shared.
let transpilerCache: string | undefined;
function sharedTranspilerCache(): string {
	transpilerCache ??= mkdtempSync(join(tmpdir(), "real-engine-transpiler-cache-"));
	return transpilerCache;
}
afterAll(() => {
	if (transpilerCache !== undefined) rmSync(transpilerCache, { recursive: true, force: true });
	transpilerCache = undefined;
});

export interface RealEngineRun {
	readonly code: number | null;
	readonly output: string;
}

export interface RealEngineOptions {
	readonly root: string;
	/** The private table; `undefined` starts the entry with none. */
	readonly table: string | undefined;
	readonly slot5?: "pipe" | number;
	readonly write?: (sink: Writable) => void;
	readonly runtime?: readonly string[];
	readonly entry?: string;
}

const started = new Set<number>();

/** The pids of the runs this file started that are still alive; every run ends with its test, so this is empty. */
export function runsStillAlive(): number[] {
	return [...started].filter((pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	});
}

/** Starts a real CLI entry with a private table and descriptor 5 as given, and collects its exit and output. */
export async function realEngine(args: readonly string[], options: RealEngineOptions): Promise<RealEngineRun> {
	const { root, table, slot5 = "pipe", write, runtime = [], entry = CLI } = options;
	const child = spawn("bun", [...runtime, entry, ...args], {
		cwd: root,
		stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", slot5],
		env: {
			PATH: process.env.PATH ?? "",
			HOME: root,
			SENPI_CODING_AGENT_DIR: join(root, "agent"),
			PI_OFFLINE: "1",
			NO_COLOR: "1",
			BUN_RUNTIME_TRANSPILER_CACHE_PATH: sharedTranspilerCache(),
			...(table === undefined ? {} : { SENPI_PRIVATE_FDS: table }),
		},
	});
	// A run the test stopped waiting on (it failed or timed out) must not outlive the test: an entry that wrongly starts a
	// mode instead of answering never exits on its own.
	const closed = new Promise<void>((done) => child.once("close", () => done()));
	if (child.pid !== undefined) started.add(child.pid);
	onTestFinished(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await closed;
	});
	const sink: unknown = Reflect.get(child.stdio, 5);
	if (sink instanceof Writable) {
		sink.on("error", () => {});
		write?.(sink);
	}
	let output = "";
	for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => (output += String(chunk)));
	const code = await new Promise<number | null>((done) => child.once("close", done));
	return { code, output };
}
