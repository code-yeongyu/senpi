import { spawn } from "node:child_process";
import { join } from "node:path";
import { Writable } from "node:stream";

export const CLI = join(__dirname, "..", "..", "src", "cli.ts");
export const CLI_MAIN = join(__dirname, "..", "..", "src", "cli-main.ts");

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
	/** Ends the child after this many milliseconds; the run then has no exit code and says so in its output. */
	readonly boundMs?: number;
}

/** The output line of a run that gave no answer within its bound. */
export const NO_ANSWER_WITHIN_BOUND = "[real-engine: no answer within the bound]";

/** Starts a real CLI entry with a private table and descriptor 5 as given, and collects its exit and output. */
export async function realEngine(args: readonly string[], options: RealEngineOptions): Promise<RealEngineRun> {
	const { root, table, slot5 = "pipe", write, runtime = [], entry = CLI, boundMs } = options;
	const child = spawn("bun", [...runtime, entry, ...args], {
		cwd: root,
		stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", slot5],
		env: {
			PATH: process.env.PATH ?? "",
			HOME: root,
			SENPI_CODING_AGENT_DIR: join(root, "agent"),
			PI_OFFLINE: "1",
			NO_COLOR: "1",
			...(table === undefined ? {} : { SENPI_PRIVATE_FDS: table }),
		},
	});
	const sink: unknown = Reflect.get(child.stdio, 5);
	if (sink instanceof Writable) {
		sink.on("error", () => {});
		write?.(sink);
	}
	let output = "";
	for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => (output += String(chunk)));
	let bounded = false;
	const bound =
		boundMs === undefined
			? undefined
			: setTimeout(() => {
					bounded = true;
					child.kill("SIGKILL");
				}, boundMs);
	const code = await new Promise<number | null>((done) => child.once("close", done));
	clearTimeout(bound);
	return bounded ? { code: null, output: `${output}\n${NO_ANSWER_WITHIN_BOUND}` } : { code, output };
}
