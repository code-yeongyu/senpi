import { fstatSync } from "node:fs";

/**
 * How long a non-pipe stdin gets to produce its first byte when the prompt already came from the command line.
 * A caller that means to send stdin (for example `spawn(..., { stdio: "pipe" })` followed by `stdin.end(text)`)
 * writes within milliseconds; a harness that merely leaves an inherited stdin open never writes at all.
 */
export const PIPED_STDIN_GRACE_MS = 1000;

export type PipedStdinKind = "tty" | "pipe" | "file" | "other";

interface StdinLike {
	isTTY?: boolean;
	fd?: number;
	setEncoding(encoding: BufferEncoding): unknown;
	on(event: "data" | "end", listener: (chunk: string) => void): unknown;
	removeListener(event: "data" | "end", listener: (chunk: string) => void): unknown;
	resume(): unknown;
	pause(): unknown;
	unref?: () => unknown;
}

export interface ReadPipedStdinOptions {
	/** True when positional messages or `@file` arguments already supply the prompt. */
	hasPromptArgs: boolean;
	stdin?: StdinLike;
	kind?: PipedStdinKind;
	graceMs?: number;
	onGiveUp?: (graceMs: number) => void;
}

export function classifyStdin(stdin: StdinLike = process.stdin): PipedStdinKind {
	if (stdin.isTTY) return "tty";
	try {
		const stats = fstatSync(stdin.fd ?? 0);
		if (stats.isFIFO()) return "pipe";
		if (stats.isFile()) return "file";
	} catch {
		// A closed or unusable descriptor is treated like any other non-pipe input.
	}
	return "other";
}

/**
 * Read all content from piped stdin. Returns undefined for a TTY or empty input.
 *
 * Shell pipes and redirected files are read to EOF, however long the producer takes. Any other stdin (a socket
 * or character device, which is what agent harnesses and CI runners hand their children) is waited on to EOF only
 * when it is the sole source of the prompt; when the prompt came from arguments it gets `graceMs` to start
 * sending, after which the run continues without it instead of blocking forever on a descriptor nobody closes.
 */
export function readPipedStdin(options: ReadPipedStdinOptions): Promise<string | undefined> {
	const stdin = options.stdin ?? process.stdin;
	const kind = options.kind ?? classifyStdin(stdin);
	if (kind === "tty") return Promise.resolve(undefined);

	const bounded = options.hasPromptArgs && kind === "other";
	const graceMs = options.graceMs ?? PIPED_STDIN_GRACE_MS;

	return new Promise((resolve) => {
		let data = "";
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const stop = () => {
			if (graceTimer !== undefined) clearTimeout(graceTimer);
			stdin.removeListener("data", onData);
			stdin.removeListener("end", onEnd);
		};
		const onData = (chunk: string) => {
			if (graceTimer !== undefined) {
				clearTimeout(graceTimer);
				graceTimer = undefined;
			}
			data += chunk;
		};
		const onEnd = () => {
			stop();
			resolve(data.trim() || undefined);
		};

		stdin.setEncoding("utf8");
		stdin.on("data", onData);
		stdin.on("end", onEnd);
		if (bounded) {
			graceTimer = setTimeout(() => {
				graceTimer = undefined;
				stop();
				stdin.pause();
				stdin.unref?.();
				options.onGiveUp?.(graceMs);
				resolve(undefined);
			}, graceMs);
		}
		stdin.resume();
	});
}
