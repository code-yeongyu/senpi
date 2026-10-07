import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { createInterface } from "node:readline";
import { GrepEngineError } from "../engine.ts";
import { parseRgEvent, type RgEvent } from "./json-rows.ts";

export interface RgEngineOptions {
	/** Process and clock seams keep cancellation and ordered-deadline tests event-driven. */
	spawn?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
	now?: () => number;
}

export type RgRun = (
	args: string[],
	cwd: string,
	onEvent?: (event: RgEvent) => void,
	input?: Buffer,
) => Promise<Buffer>;

export class SearchTimeout extends Error {}

function rgError(message: string): GrepEngineError {
	if (/look-around|backreference/i.test(message)) return new GrepEngineError("UNSUPPORTED_REGEX", message);
	if (/regex parse error|PCRE2: error compiling pattern|the literal .* is not allowed in a regex/i.test(message))
		return new GrepEngineError("INVALID_PATTERN", message);
	if (/error parsing glob/i.test(message)) return new GrepEngineError("INVALID_GLOB", message);
	if (/unrecognized file type|unknown file type/i.test(message)) return new GrepEngineError("UNKNOWN_TYPE", message);
	return new GrepEngineError("ENGINE_UNAVAILABLE", message);
}

function onlyNoFilesWarnings(stderr: string): boolean {
	const lines = stderr.trim().split(/\r?\n/);
	return (
		lines.some((line) => line.startsWith("No files were searched")) &&
		lines.every(
			(line) =>
				line.startsWith("No files were searched") ||
				line === "Running with --debug will show why files are being skipped.",
		)
	);
}

export function createRgRunner({
	executable,
	launch,
	now,
	deadline,
	signal,
	check,
}: {
	executable: string;
	launch: NonNullable<RgEngineOptions["spawn"]>;
	now: () => number;
	deadline: number;
	signal?: AbortSignal;
	check: () => void;
}): RgRun {
	return async (args, cwd, onEvent, input) => {
		check();
		return new Promise<Buffer>((resolveRun, reject) => {
			const child = launch(executable, args, { cwd, stdio: "pipe" });
			const chunks: Buffer[] = [];
			let stderr = "";
			let failure: Error | undefined;
			let timedOut = false;
			const stop = () => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
			};
			const onAbort = () => {
				stop();
			};
			const timer = setTimeout(
				() => {
					timedOut = true;
					stop();
				},
				Math.max(0, deadline - now()),
			);
			signal?.addEventListener("abort", onAbort, { once: true });
			const lines = onEvent ? createInterface({ input: child.stdout }) : undefined;
			lines?.on("line", (line) => {
				if (failure) return;
				try {
					onEvent?.(parseRgEvent(line));
				} catch (error) {
					failure = new GrepEngineError("ENGINE_UNAVAILABLE", `Malformed ripgrep JSON: ${String(error)}`);
					stop();
				}
			});
			if (!onEvent) child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.on("error", (error) => {
				failure = new GrepEngineError("ENGINE_UNAVAILABLE", `Failed to run ripgrep: ${error.message}`);
			});
			child.stdin.on("error", (error: NodeJS.ErrnoException) => {
				// rg can stop reading stdin at -m before the prefix has finished writing.
				if (error.code === "EPIPE") return;
				failure = new GrepEngineError("ENGINE_UNAVAILABLE", `Failed to write ripgrep input: ${error.message}`);
				stop();
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				lines?.close();
				signal?.removeEventListener("abort", onAbort);
				if (signal?.aborted) reject(new GrepEngineError("ABORTED", "Grep search aborted"));
				else if (timedOut || now() >= deadline) reject(new SearchTimeout());
				else if (failure) reject(failure);
				else if (code !== 0 && code !== 1 && !(code === 2 && onlyNoFilesWarnings(stderr)))
					reject(rgError(stderr.trim() || `ripgrep exited with code ${code}`));
				else resolveRun(Buffer.concat(chunks));
			});
			if (input !== undefined) child.stdin.end(input);
			if (signal?.aborted) onAbort();
		});
	};
}
