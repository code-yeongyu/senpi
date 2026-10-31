import { fstatSync } from "node:fs";

// Harnesses (ssh, CI runners, spawn with stdio "pipe") hand children a stdin that is open but never
// written or closed. Slow real producers (`curl … |`, `git log |` on a big repo) need well over 150 ms.
export const PIPED_STDIN_GRACE_MS = 2_000;

export interface PipedStdin {
	readonly isTTY?: boolean;
	readonly fd?: number;
	setEncoding(encoding: BufferEncoding): unknown;
	on(event: "data", listener: (chunk: string) => void): unknown;
	on(event: "end", listener: () => void): unknown;
	off(event: "data", listener: (chunk: string) => void): unknown;
	off(event: "end", listener: () => void): unknown;
	resume(): unknown;
	pause(): unknown;
	unref?(): unknown;
}

export interface ReadPipedStdinOptions {
	hasPromptArgument: boolean;
	forceRead: boolean;
	stdin?: PipedStdin;
	graceMs?: number;
	isRegularFile?: (stdin: PipedStdin) => boolean;
	onSkip?: () => void;
}

function stdinIsRegularFile(stdin: PipedStdin): boolean {
	try {
		return fstatSync(stdin.fd ?? 0).isFile();
	} catch {
		return false;
	}
}

export function readPipedStdin(options: ReadPipedStdinOptions): Promise<string | undefined> {
	const stdin: PipedStdin = options.stdin ?? process.stdin;
	if (!options.forceRead && stdin.isTTY) {
		return Promise.resolve(undefined);
	}
	const isRegularFile = options.isRegularFile ?? stdinIsRegularFile;
	const readToEof = options.forceRead || !options.hasPromptArgument || isRegularFile(stdin);

	return new Promise((resolve) => {
		let data = "";
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const onData = (chunk: string) => {
			clearTimeout(graceTimer);
			data += chunk;
		};
		const settle = (value: string | undefined) => {
			clearTimeout(graceTimer);
			stdin.off("data", onData);
			stdin.off("end", onEnd);
			resolve(value);
		};
		const onEnd = () => settle(data.trim() || undefined);

		stdin.setEncoding("utf8");
		stdin.on("data", onData);
		stdin.on("end", onEnd);
		if (!readToEof) {
			graceTimer = setTimeout(() => {
				stdin.pause();
				stdin.unref?.();
				settle(undefined);
				options.onSkip?.();
			}, options.graceMs ?? PIPED_STDIN_GRACE_MS);
		}
		stdin.resume();
	});
}
