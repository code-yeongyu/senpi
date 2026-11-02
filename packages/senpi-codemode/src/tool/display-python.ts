import { spawn } from "node:child_process";
import { createInterpreterDetector } from "../interpreters/detect.ts";
import { PYTHON_FORMATTER_SCRIPT } from "./display-python-script.ts";

export type PythonStrategy = "ruff" | "black" | "ast";
export type PythonInvocation = { readonly command: string; readonly args: readonly string[] };

export interface PythonFormatOptions {
	readonly strategies: readonly PythonStrategy[];
	readonly timeoutMs: number;
	readonly env?: NodeJS.ProcessEnv;
}

export interface PythonDisplayOptions extends PythonFormatOptions {
	readonly interpreter: () => Promise<PythonInvocation | null>;
}

export interface PythonDisplay {
	/**
	 * The formatted cell once it is known, otherwise the cell as sent. With `onFormatted`, a missing
	 * result is formatted in the background and `onFormatted` runs when a formatted cell is ready.
	 */
	display(code: string, onFormatted?: () => void): string;
}

const DEFAULT_STRATEGIES: readonly PythonStrategy[] = ["ruff", "black", "ast"];
const FORMAT_TIMEOUT_MS = 5_000;
const MAX_CONCURRENT_FORMATTERS = 2;
const CACHE_LIMIT = 64;

function formattedCode(stdout: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(stdout);
		if (parsed === null || typeof parsed !== "object" || !("code" in parsed)) return undefined;
		return typeof parsed.code === "string" ? parsed.code : undefined;
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

// ruff runs inside the formatter process, so it gets most of the caller's budget and never outlives it.
function ruffTimeoutSeconds(timeoutMs: number): string {
	return String(Math.max(1, timeoutMs - 1_000) / 1_000);
}

export function formatPythonCell(
	code: string,
	invocation: PythonInvocation,
	options: PythonFormatOptions,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		const child = spawn(
			invocation.command,
			[
				...invocation.args,
				"-c",
				PYTHON_FORMATTER_SCRIPT,
				ruffTimeoutSeconds(options.timeoutMs),
				...options.strategies,
			],
			{
				stdio: ["pipe", "pipe", "ignore"],
				timeout: options.timeoutMs,
				windowsHide: true,
				...(options.env === undefined ? {} : { env: options.env }),
			},
		);
		let stdout = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => resolve(undefined));
		child.on("close", (exitCode) => resolve(exitCode === 0 ? formattedCode(stdout) : undefined));
		child.stdin.on("error", () => resolve(undefined));
		child.stdin.end(code);
	});
}

export function createPythonDisplay(options: PythonDisplayOptions): PythonDisplay {
	const settled = new Map<string, string>();
	const listeners = new Map<string, Set<() => void>>();
	const queue: string[] = [];
	let running = 0;

	const remember = (code: string, formatted: string) => {
		if (settled.size >= CACHE_LIMIT) settled.delete(settled.keys().next().value ?? "");
		settled.set(code, formatted);
	};

	const format = async (code: string): Promise<string | undefined> => {
		const invocation = await options.interpreter();
		return invocation === null ? undefined : formatPythonCell(code, invocation, options);
	};

	const pump = () => {
		while (running < MAX_CONCURRENT_FORMATTERS) {
			const code = queue.shift();
			if (code === undefined) return;
			running += 1;
			void format(code)
				.catch(() => undefined)
				.then((formatted) => {
					remember(code, formatted ?? code);
					const waiting = listeners.get(code);
					listeners.delete(code);
					if (formatted !== undefined && formatted !== code) for (const listener of waiting ?? []) listener();
				})
				.finally(() => {
					running -= 1;
					pump();
				});
		}
	};

	return {
		display(code, onFormatted) {
			const known = settled.get(code);
			if (known !== undefined || onFormatted === undefined) return known ?? code;
			const waiting = listeners.get(code);
			if (waiting !== undefined) {
				waiting.add(onFormatted);
				return code;
			}
			listeners.set(code, new Set([onFormatted]));
			queue.push(code);
			pump();
			return code;
		},
	};
}

async function detectedPython(): Promise<PythonInvocation | null> {
	const detected = await createInterpreterDetector().detect("py");
	if (!detected.ok) return null;
	const [command, ...args] = detected.path.split(" ");
	return command === undefined ? null : { command, args };
}

let userPython: Promise<PythonInvocation | null> | undefined;

export const pythonDisplay: PythonDisplay = createPythonDisplay({
	interpreter: () => {
		userPython ??= detectedPython();
		return userPython;
	},
	strategies: DEFAULT_STRATEGIES,
	timeoutMs: FORMAT_TIMEOUT_MS,
});
