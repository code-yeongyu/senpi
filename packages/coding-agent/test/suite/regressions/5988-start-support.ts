import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// senpi#5988: drives `5988-start-step.ts`, one CLI start in its own process, step by step over stdin.
const STEP = fileURLToPath(new URL("./5988-start-step.ts", import.meta.url));
const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));

export interface CliStart {
	readonly child: ChildProcessWithoutNullStreams;
	readonly exited: Promise<number | null>;
	/** The next step the start reports, or undefined once it exited (a refused start reports nothing). */
	next(): Promise<Record<string, unknown> | undefined>;
	/** Ends the stand-in for loading: the start goes on to its next step. */
	go(): void;
	[Symbol.asyncDispose](): Promise<void>;
}

export function cliStart(args: {
	readonly root: string;
	readonly file: string;
	readonly id: string;
	readonly failLoad?: boolean;
}): CliStart {
	const child = spawn("bun", [STEP, JSON.stringify(args)], {
		cwd: REPO,
		env: { ...process.env, SENPI_CODING_AGENT_DIR: join(args.root, "agent") },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	let ended = false;
	return {
		child,
		exited,
		next: async () => {
			const line = await lines.next();
			if (line.done === true) {
				ended = true;
				return undefined;
			}
			const value: unknown = JSON.parse(line.value);
			return typeof value === "object" && value !== null ? { ...value } : undefined;
		},
		// A start that closed its output has exited: there is no loading left to end.
		go: () => {
			if (!ended) child.stdin.write("go\n");
		},
		[Symbol.asyncDispose]: async () => {
			child.stdin.end();
			await exited;
		},
	};
}
